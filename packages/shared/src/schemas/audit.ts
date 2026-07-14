import { z } from "zod";

// Event classification (§41) for SIEM alerting/severity — a plain string
// union rather than a Prisma enum (see schema.prisma's AuditEvent.category
// comment) so a new category never needs a migration. Mirrors
// REQUIREMENTS.md §7's action-category taxonomy: "governance" covers its
// schedule approval/rejection and webhook-delivery/classification-change
// examples, which don't fit cleanly under authz_change/admin/lifecycle.
export const AUDIT_CATEGORIES = [
  "authn",
  "authz_change",
  "admin",
  "data_access",
  "lifecycle",
  "governance",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

// Mirrors the audit event schema proposed in REQUIREMENTS.md §7.1.
// This is the shape written to Postgres and mirrored to syslog (RFC 5424).
// Used as a non-blocking validation safety net in recordAuditEvent (§41)
// — a shape mismatch is logged, never thrown, since a bug in a new call
// site must not be the reason the operation being audited fails.
export const auditEventSchema = z.object({
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  actorType: z.enum(["USER", "SERVICE"]),
  actorId: z.string(),
  // Denormalized human-readable actor per REQUIREMENTS §7.1 — a real
  // email for USER actors, but a service identifier (e.g.
  // "system:scheduler") for SERVICE actors, or the literal "unknown" for
  // pre-authentication events (a failed login, a rejected consent
  // banner) where no identity exists yet. Not constrained to `.email()`.
  actorEmail: z.string().min(1),
  // "<resource>.<operation>", but REQUIREMENTS.md §7.1's own examples
  // include multi-segment actions (e.g. "team.membership.add"), so this
  // allows one or more dot-separated segments, not exactly one dot.
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/, "expected dot-separated '<resource>.<operation>' form"),
  targetType: z.string(),
  targetId: z.string().optional(),
  targetName: z.string().optional(),
  // The affected second principal, e.g. the user added to a team or
  // granted a project ACL — distinct from targetType/Id/Name, which is
  // the resource the action was performed on (§41).
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  subjectName: z.string().optional(),
  result: z.enum(["SUCCESS", "FAILURE"]),
  errorMessage: z.string().optional(),
  sourceIp: z.string().ip().optional(),
  // Session-scoped (hash of the session id) — ties every event from one
  // login session together. Worker events instead use the runId that
  // ties multiple events about one run together.
  correlationId: z.string().optional(),
  // Per-HTTP-request id, distinct from correlationId's per-session scope.
  requestId: z.string().optional(),
  httpMethod: z.string().optional(),
  httpPath: z.string().optional(),
  userAgent: z.string().optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  // Before->after diff for *.update actions — never include secret
  // values; record a boolean changed-flag instead (as settings.ts
  // already does for the SMTP password).
  changes: z.record(z.object({ from: z.unknown(), to: z.unknown() })).optional(),
  details: z.record(z.unknown()).optional(),
});

export type AuditEventInput = z.infer<typeof auditEventSchema>;
