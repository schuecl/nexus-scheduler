import { z } from "zod";

// Mirrors the audit event schema proposed in REQUIREMENTS.md §7.1.
// This is the shape written to Postgres and mirrored to syslog (RFC 5424).
export const auditEventSchema = z.object({
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  actorType: z.enum(["USER", "SERVICE"]),
  actorId: z.string(),
  actorEmail: z.string().email(),
  action: z.string().regex(/^[a-z_]+\.[a-z_]+$/, "expected '<resource>.<operation>' form"),
  targetType: z.string(),
  targetId: z.string().optional(),
  targetName: z.string().optional(),
  result: z.enum(["SUCCESS", "FAILURE"]),
  errorMessage: z.string().optional(),
  sourceIp: z.string().ip().optional(),
  correlationId: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export type AuditEventInput = z.infer<typeof auditEventSchema>;
