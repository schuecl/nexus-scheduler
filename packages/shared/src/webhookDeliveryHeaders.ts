// Shared between the API's POST /:id/test (single-shot, immediate
// feedback) and the Worker's real run delivery (packages/worker/src/
// webhookDelivery.ts) so the "Content-Type and X-Nexus-Signature always
// win" rule can't drift between the two call sites (§27). Custom
// headers are already rejected at the zod-schema layer if they'd
// collide with either reserved name, but a row can predate that
// validation or be edited directly — so it's re-asserted here too.
//
// signature is null when the destination has signPayload: false (issue
// #224) — for a receiver that only checks a baked-in Authorization
// header (via customHeaders) and doesn't verify HMAC signatures.
// X-Nexus-Signature is simply omitted, not sent empty/unsigned.
export function buildWebhookDeliveryHeaders(
  customHeaders: unknown,
  signature: string | null,
): Record<string, string> {
  const base: Record<string, string> =
    customHeaders && typeof customHeaders === "object" ? { ...(customHeaders as Record<string, string>) } : {};
  for (const key of Object.keys(base)) {
    if (key.toLowerCase() === "content-type" || key.toLowerCase() === "x-nexus-signature") {
      delete base[key];
    }
  }
  return {
    ...base,
    "Content-Type": "application/json",
    ...(signature ? { "X-Nexus-Signature": `sha256=${signature}` } : {}),
  };
}
