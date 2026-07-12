import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { prisma } from "./db.js";

interface RecordAuditEventInput {
  req?: Request;
  actorType: "USER" | "SERVICE";
  actorId: string;
  actorEmail: string;
  action: string; // "<resource>.<operation>", e.g. "job.create" — REQUIREMENTS §7.1
  targetType: string;
  targetId?: string;
  targetName?: string;
  result: "SUCCESS" | "FAILURE";
  errorMessage?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

// Single write path for audit events so every caller produces the same
// shape described in REQUIREMENTS.md §7.1 — no ad hoc console.log audit
// trails scattered through route handlers.
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      id: randomUUID(),
      actorType: input.actorType,
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetName: input.targetName,
      result: input.result,
      errorMessage: input.errorMessage,
      sourceIp: input.req?.ip,
      correlationId: input.correlationId,
      details: input.details as never,
    },
  });
  // TODO(§7): mirror this event to syslog (RFC 5424) once the syslog
  // transport is implemented — see REQUIREMENTS.md §7 for the field
  // mapping this should follow.
}
