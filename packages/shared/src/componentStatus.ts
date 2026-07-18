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

// The only link modeled today that only the Worker can reach (its own
// LibreChat Agents API call). The system map's "model gateway"/OCR
// links described in #131 aren't wired into this app yet — nothing
// calls them directly, so there's nothing real to probe or draw a
// status for until that groundwork exists.
export type WorkerOwnedComponentId = "librechat";

export function workerComponentStatusKey(componentId: WorkerOwnedComponentId): string {
  return `${WORKER_COMPONENT_STATUS_KEY_PREFIX}${componentId}`;
}
