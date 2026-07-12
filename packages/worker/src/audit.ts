import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";

interface RecordAuditEventInput {
  actorType: "USER" | "SERVICE";
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetName?: string;
  result: "SUCCESS" | "FAILURE";
  errorMessage?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

// Worker-side counterpart to packages/api/src/audit.ts — same shape
// (REQUIREMENTS.md §7.1), separate implementation because each service
// owns its own Prisma client/process. Agent/service-initiated actions
// (a schedule firing) use actorType "SERVICE" per §7.
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
      correlationId: input.correlationId,
      details: input.details as never,
    },
  });
  // TODO(§7): mirror to syslog (RFC 5424) — same follow-up as the API's audit.ts.
}
