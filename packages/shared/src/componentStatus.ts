// Shared between the Worker (publishes reachability for the links only
// it can reach) and the API (reads them back, alongside its own
// directly-probed links, for the system status endpoint powering issue
// #131's live system map) — same rationale as runCancellation.ts: one
// definition of the wire shape/key names so the two processes agree
// without this package depending on either's Redis client.
//
// Published as a plain "up"/"down" string under a short TTL rather than
// left to accumulate forever: if the worker crashes or is scaled to
// zero, the key simply expires and the API reports that link "stale"
// instead of showing a last-known status that may no longer be true.
// The TTL is a generous multiple of the publish interval so a single
// slow tick doesn't flicker a healthy link to stale.
export const WORKER_COMPONENT_STATUS_KEY_PREFIX = "nexus:component-status:";
export const WORKER_HEARTBEAT_KEY = "nexus:worker-heartbeat";
export const WORKER_COMPONENT_STATUS_TTL_SECONDS = 90;

// Links only the Worker can reach: its own LibreChat Agents API call,
// and the OCR pipeline service (#109) — which lives on an internal-only
// network the API is deliberately not a member of. OCR is optional, so
// its published value may be "unconfigured" (OCR_SERVICE_URL unset):
// distinct from "down" (configured but unreachable) and from an expired
// key ("stale" — the Worker itself isn't reporting).
export type WorkerOwnedComponentId = "librechat" | "ocr";

export function workerComponentStatusKey(componentId: WorkerOwnedComponentId): string {
  return `${WORKER_COMPONENT_STATUS_KEY_PREFIX}${componentId}`;
}
