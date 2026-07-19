// Client for the OCR pipeline service (#109). The worker sends a job's
// attachments through it before every agent call: the agent receives
// extracted text (docling markdown — tables and reading order intact),
// never the raw file, and the run record keeps both the text and the
// searchable-PDF audit artifact.
//
// One request per attachment: /process treats its input as a single
// document (one PDF, or one batch of images composing one document),
// so a job with several attachments is several documents — batching
// them into one request would 400 on the second PDF.

export interface OcrResult {
  markdown: string;
  searchablePdfBase64: string;
  descriptions: string[];
  ocrReported: number;
}

export interface OcrAttachmentInput {
  filename: string;
  mimeType: string;
  data: Buffer;
}

// Carries the HTTP status so the processor can tell a deterministic
// client rejection (415/422 — retrying re-sends the same bytes to the
// same validator) from a transient service failure worth retrying.
export class OcrError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "OcrError";
  }
}

export async function extractAttachment(
  baseUrl: string,
  attachment: OcrAttachmentInput,
  options: { describe?: boolean; timeoutMs?: number; abortSignal?: AbortSignal } = {},
): Promise<OcrResult> {
  const form = new FormData();
  form.append(
    "files",
    new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }),
    attachment.filename,
  );
  // Named request so a cancel can reach the server-side work: aborting
  // the fetch only disconnects us — the service is told to kill the
  // in-flight subprocesses via POST /process/{id}/cancel below.
  const requestId = crypto.randomUUID();
  const url = new URL("/process", baseUrl);
  url.searchParams.set("request_id", requestId);
  if (options.describe) url.searchParams.set("describe", "true");
  // Mirror the client-side abort budget server-side: aborting the fetch
  // only disconnects us — a sync handler mid-Tesseract wouldn't notice
  // and would grind on as an orphan. With the budget passed along, the
  // service kills its own subprocesses at the same deadline (408).
  if (options.timeoutMs) {
    url.searchParams.set("budget_seconds", String(options.timeoutMs / 1000));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
  // A run cancellation (issue #111) aborts the OCR request the same
  // way it aborts the agent call — without this, one slow attachment
  // holds a cancelled run for its entire remaining budget.
  const onExternalAbort = () => controller.abort();
  if (options.abortSignal?.aborted) controller.abort();
  options.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetch(url, { method: "POST", body: form, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OcrError(
        `OCR service returned ${response.status} for ${attachment.filename}: ${body.slice(0, 300)}`,
        response.status,
      );
    }
    const json = (await response.json()) as {
      markdown: string;
      searchable_pdf_base64: string;
      descriptions: string[];
      meta: { ocr_reported: number };
    };
    return {
      markdown: json.markdown,
      searchablePdfBase64: json.searchable_pdf_base64,
      descriptions: json.descriptions ?? [],
      ocrReported: json.meta?.ocr_reported ?? 0,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      // Disconnecting doesn't stop a sync handler mid-subprocess; tell
      // the service to kill this request's work now rather than letting
      // it grind to its budget ceiling. Best-effort: the budget bound
      // still backstops a lost cancel.
      void fetch(new URL(`/process/${requestId}/cancel`, baseUrl), { method: "POST" }).catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", onExternalAbort);
  }
}
