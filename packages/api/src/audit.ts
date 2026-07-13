import { randomUUID } from "node:crypto";
import pino from "pino";
import type { Request } from "express";
import { buildRfc5424Message, sendSyslogMessage } from "@nexus-scheduler/shared";
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

// Narrow fallback logger for this one best-effort side-channel — every
// recordAuditEvent() call site (40+ across routes/) predates a logger
// being threaded through, and a syslog delivery failure shouldn't be
// the reason to change all of them.
const syslogLogger = pino({ name: "syslog-mirror" });

// Single write path for audit events so every caller produces the same
// shape described in REQUIREMENTS.md §7.1 — no ad hoc console.log audit
// trails scattered through route handlers.
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
      sourceIp: input.req?.ip,
      correlationId: input.correlationId,
      details: input.details as never,
    },
  });

  await mirrorToSyslog(event);
}

// Best-effort forward to syslog (RFC 5424, §7.1) — Postgres above
// remains the system of record regardless of whether this succeeds.
// Reads current settings on every call rather than caching, matching
// how email.ts/webhookDelivery.ts already read SMTP/webhook config
// fresh each time: audit volume here doesn't warrant the complexity of
// a cache, and settings can change at any time via the admin UI.
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
    const message = buildRfc5424Message({ ...event, eventId: event.id, appName: "nexus-scheduler-api" });
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
