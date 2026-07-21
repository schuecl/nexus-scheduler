import { z } from "zod";
import { httpUrlSchema } from "./url.js";
import { validateWebhookPayloadTemplateJson } from "../webhookPayloadTemplate.js";

// Header names the sender always controls — Content-Type identifies the
// body as the signed JSON payload, X-Nexus-Signature carries the HMAC
// over it. Letting a custom header override either would let an admin
// (accidentally or not) ship an unsigned/mislabeled request, so both
// are rejected here (write time) and re-asserted at delivery time.
const RESERVED_HEADER_NAMES = new Set(["content-type", "x-nexus-signature"]);

// Custom headers merged into outbound delivery (§27) — e.g. a
// receiver-side auth token. Values are rejected if they contain CR/LF
// (header injection) since they're passed straight into fetch()'s
// Headers. Capped at a small count/size: this is a handful of
// admin-entered auth headers, not a general-purpose templating system.
export const webhookHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(100)
      .regex(/^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/, "must be a valid HTTP header name"),
    z
      .string()
      .max(2000)
      .refine((v) => !/[\r\n]/.test(v), { message: "must not contain line breaks" }),
  )
  .refine((headers) => Object.keys(headers).length <= 20, { message: "at most 20 custom headers" })
  .refine((headers) => Object.keys(headers).every((name) => !RESERVED_HEADER_NAMES.has(name.toLowerCase())), {
    message: "Content-Type and X-Nexus-Signature are set automatically and can't be overridden",
  });
export type WebhookHeaders = z.infer<typeof webhookHeadersSchema>;

// A payloadTemplate, if provided at all, must render to well-formed
// JSON — checked here regardless of customPayloadEnabled, so a broken
// draft can't be saved and forgotten. Whether ENABLING custom payload
// requires an effective template is a route-level check instead (see
// webhookDestinations.ts): PATCH is partial, so only the route handler
// — which has the existing row — can tell whether a template already
// on file makes an enable-with-no-template-in-this-request valid.
function checkPayloadTemplate(payloadTemplate: string | null | undefined, ctx: z.RefinementCtx): void {
  if (payloadTemplate == null) return;
  try {
    validateWebhookPayloadTemplateJson(payloadTemplate);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payloadTemplate"],
      message: err instanceof Error ? err.message : "payload template must render to valid JSON",
    });
  }
}

// Admin-only allow-list entry (REQUIREMENTS §2.2/§10) — the destination
// URL is never user-supplied per-job, only picked from this list, which
// is exactly what prevents the outbound-delivery feature from becoming
// an SSRF/exfiltration path. Restricted to http(s): a file:// entry in
// this allow-list would be nonsensical, and z.string().url() alone
// accepts it (and javascript:/data:) with no complaint.
export const createWebhookDestinationSchema = z
  .object({
    name: z.string().min(1).max(200),
    url: httpUrlSchema,
    headers: webhookHeadersSchema.optional(),
    notifyOnSuccess: z.boolean().optional(),
    notifyOnFailure: z.boolean().optional(),
    notifyOnCancelled: z.boolean().optional(),
    // Both issue #224 — see the WebhookDestination model comments for
    // the full rationale. Optional here (default true/false server-side
    // on create) so existing callers/tests that don't set them keep
    // getting today's behavior.
    signPayload: z.boolean().optional(),
    customPayloadEnabled: z.boolean().optional(),
    payloadTemplate: z.string().min(1).max(5000).nullable().optional(),
  })
  .superRefine((data, ctx) => checkPayloadTemplate(data.payloadTemplate, ctx));
export type CreateWebhookDestinationInput = z.infer<typeof createWebhookDestinationSchema>;

export const updateWebhookDestinationSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    url: httpUrlSchema.optional(),
    active: z.boolean().optional(),
    headers: webhookHeadersSchema.nullable().optional(),
    notifyOnSuccess: z.boolean().optional(),
    notifyOnFailure: z.boolean().optional(),
    notifyOnCancelled: z.boolean().optional(),
    signPayload: z.boolean().optional(),
    customPayloadEnabled: z.boolean().optional(),
    payloadTemplate: z.string().min(1).max(5000).nullable().optional(),
  })
  .superRefine((data, ctx) => checkPayloadTemplate(data.payloadTemplate, ctx));
export type UpdateWebhookDestinationInput = z.infer<typeof updateWebhookDestinationSchema>;

// Replaces the full set of destinations attached to a Job in one call —
// simpler than incremental add/remove for what's normally a short list.
export const setJobWebhooksSchema = z.object({
  webhookDestinationIds: z.array(z.string().uuid()),
});
export type SetJobWebhooksInput = z.infer<typeof setJobWebhooksSchema>;

// Outbound delivery payload shape (REQUIREMENTS §2.2) — POSTed to the
// destination URL with an HMAC-SHA256 signature over the raw JSON body
// in the X-Nexus-Signature header.
export const webhookPayloadSchema = z.object({
  runId: z.string().uuid(),
  jobId: z.string().uuid(),
  jobName: z.string(),
  status: z.enum(["SUCCESS", "FAILED", "CANCELLED"]),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  output: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
