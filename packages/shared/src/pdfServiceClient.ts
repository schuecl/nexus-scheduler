// Thin HTTP client for the isolated pdf-service (REQUIREMENTS §2.5's
// recommended architecture: rendering runs in its own no-egress
// component, not in-process in the API/Worker). Lives here rather than
// duplicated between API/Worker like email.ts/audit.ts are, since this
// has no Prisma/process-local state to duplicate — it's a plain fetch
// wrapper both processes can share as-is.
//
// The request/response shapes below intentionally mirror
// packages/pdf/src/templates/{runReport,usageReport}.ts's exported data
// interfaces rather than importing them: importing would pull
// @nexus-scheduler/pdf (and transitively `playwright`) into this shared
// package, which the frontend also depends on.

export interface RunReportPdfRequest {
  productName: string;
  primaryColor: string;
  banner: { text: string; backgroundColor: string; textColor: string } | null;
  classification: { text: string; badgeBgColor: string; badgeTextColor: string } | null;
  jobName: string;
  runId: string;
  triggerType: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  computedCost: string | null;
  output: string | null;
  errorMessage: string | null;
}

export interface UsageReportPdfRequest {
  productName: string;
  primaryColor: string;
  banner: { text: string; backgroundColor: string; textColor: string } | null;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  runCounts: Partial<Record<"PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" | "SKIPPED", number>>;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: string | null;
}

export class PdfServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfServiceError";
  }
}

async function postForPdf(url: string, body: unknown, sharedSecret: string | undefined): Promise<Buffer> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "X-Internal-Auth": sharedSecret } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PdfServiceError(`pdf-service request to ${url} failed with ${response.status}: ${text}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// sharedSecret mirrors pdf-service's own optional PDF_SERVICE_SHARED_SECRET
// (defense-in-depth on top of NetworkPolicy, REQUIREMENTS §10) — omit it
// (or leave it unset on the pdf-service side) to keep prior unauthenticated
// behavior.
export function requestRunReportPdf(
  pdfServiceUrl: string,
  data: RunReportPdfRequest,
  sharedSecret?: string,
): Promise<Buffer> {
  return postForPdf(`${pdfServiceUrl}/render/run-report`, data, sharedSecret);
}

export function requestUsageReportPdf(
  pdfServiceUrl: string,
  data: UsageReportPdfRequest,
  sharedSecret?: string,
): Promise<Buffer> {
  return postForPdf(`${pdfServiceUrl}/render/usage-report`, data, sharedSecret);
}
