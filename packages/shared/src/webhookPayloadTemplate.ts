// Optional custom JSON body for outbound webhook delivery (issue #224).
// Lives in the shared package, not the worker, because it has the same
// two-call-site shape as webhookDeliveryHeaders.ts: the API's single-shot
// POST /:id/test and the worker's real per-run delivery both need to
// render the exact same template the same way.
export interface WebhookTemplateContext {
  runId: string;
  jobId: string;
  jobName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  output: string | null;
  errorMessage: string | null;
}

export class WebhookTemplateJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookTemplateJsonError";
  }
}

// {{name}} substitution, same syntax as packages/worker/src/
// notificationTemplate.ts's email templates — but NOT the same
// substitution logic. That renderer does a raw string replace, which is
// fine for a plaintext email body. It would be unsafe here: run `output`/
// `errorMessage` is arbitrary agent-generated text that can contain
// quotes or newlines, and substituting it raw into a JSON template would
// either produce malformed JSON or let run output inject extra
// structure into a body the receiver trusts.
//
// The fix: JSON.stringify each value, then strip the surrounding quotes
// `JSON.stringify` adds — the template itself supplies those quotes
// (author writes `"status": "{{status}}"`, not `"status": {{status}}`),
// so what lands in the hole is JSON-escaped *content*, never raw text.
// An unrecognized placeholder is left as-is, matching
// notificationTemplate.ts's behavior, rather than erroring.
export function renderWebhookPayloadTemplate(template: string, context: WebhookTemplateContext): string {
  const values: Record<string, string> = {
    run_id: context.runId,
    job_id: context.jobId,
    job_name: context.jobName,
    status: context.status,
    started_at: context.startedAt ?? "",
    completed_at: context.completedAt ?? "",
    output: context.output ?? "",
    error_message: context.errorMessage ?? "",
  };

  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => {
    if (!(name in values)) return match;
    // Slice off the leading/trailing " that JSON.stringify adds around a
    // string — the template's own quotes are what's kept.
    return JSON.stringify(values[name]!).slice(1, -1);
  });
}

// A fixed, obviously-fake context used only to check that a template
// renders to well-formed JSON — deliberately includes characters
// (quotes, a newline) that a naive template would mishandle, so this
// check actually exercises the JSON-escaping path rather than just
// confirming the placeholders resolve.
const SAMPLE_TEMPLATE_CONTEXT: WebhookTemplateContext = {
  runId: "00000000-0000-0000-0000-000000000000",
  jobId: "00000000-0000-0000-0000-000000000000",
  jobName: "Sample Job",
  status: "SUCCESS",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:05.000Z",
  output: 'Sample output with "quotes" and\na newline.',
  errorMessage: null,
};

// Called at write time (POST/PATCH a WebhookDestination) so a broken
// template is rejected immediately with a clear reason, instead of
// being discovered mid-delivery deep in the worker's retry loop — see
// createWebhookDestinationSchema/updateWebhookDestinationSchema.
export function validateWebhookPayloadTemplateJson(template: string): void {
  const rendered = renderWebhookPayloadTemplate(template, SAMPLE_TEMPLATE_CONTEXT);
  try {
    JSON.parse(rendered);
  } catch (err) {
    throw new WebhookTemplateJsonError(
      `payload template does not render to valid JSON (wrap every {{placeholder}} in double quotes): ${
        err instanceof Error ? err.message : "parse error"
      }`,
    );
  }
}
