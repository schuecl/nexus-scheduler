import { z } from "zod";

// Admin-only allow-list entry (REQUIREMENTS §2.2/§10) — the destination
// URL is never user-supplied per-job, only picked from this list, which
// is exactly what prevents the outbound-delivery feature from becoming
// an SSRF/exfiltration path.
export const createWebhookDestinationSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url(),
});
export type CreateWebhookDestinationInput = z.infer<typeof createWebhookDestinationSchema>;

export const updateWebhookDestinationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
});
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
