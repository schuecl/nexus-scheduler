import { randomUUID } from "node:crypto";
import pino from "pino";
import { buildRfc5424Message, sendSyslogMessage } from "@nexus-scheduler/shared";
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

// See packages/api/src/audit.ts for why this is a standalone logger
// rather than threaded through every call site.
const syslogLogger = pino({ name: "syslog-mirror" });

// Worker-side counterpart to packages/api/src/audit.ts — same shape
// (REQUIREMENTS.md §7.1), separate implementation because each service
// owns its own Prisma client/process. Agent/service-initiated actions
// (a schedule firing) use actorType "SERVICE" per §7.
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  const event = await prisma.auditEvent.create({
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

  await mirrorToSyslog(event);
}

// Best-effort forward to syslog (RFC 5424, §7.1) — see the API's
// audit.ts for the full rationale (same code, separate Prisma client).
async function mirrorToSyslog(event: {
  id: string;
  timestamp: Date;
  actorType: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  result: string;
  errorMessage: string | null;
  correlationId: string | null;
  details: unknown;
}): Promise<void> {
  try {
    const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
    if (!settings?.syslogEnabled || !settings.syslogHost || !settings.syslogPort) {
      return;
    }
    const message = buildRfc5424Message({ ...event, eventId: event.id, appName: "nexus-scheduler-worker" });
    await sendSyslogMessage(
      {
        host: settings.syslogHost,
        port: settings.syslogPort,
        transport: settings.syslogTransport,
        tls: settings.syslogTls,
        caCert: settings.syslogTlsCaCert,
      },
      message,
    );
  } catch (err) {
    syslogLogger.warn({ err, eventId: event.id }, "syslog delivery failed");
  }
}
