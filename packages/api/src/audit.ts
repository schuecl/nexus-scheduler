import { randomUUID, createHash } from "node:crypto";
import pino from "pino";
import type { Request } from "express";
import { buildRfc5424Message, sendSyslogMessage, auditEventSchema, type AuditCategory } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";

type AuditChanges = Record<string, { from: unknown; to: unknown }>;

// Shared before->after diff for *.update handlers (§41) — only compares
// `keys` (typically Object.keys(parsed.data), i.e. the fields the
// request actually touched) so untouched fields never show up as noise.
// Dates are normalized to ISO strings first so e.g. a Prisma Date and
// its request-body ISO-string counterpart compare equal when unchanged.
// Never pass a secret-bearing key in — the caller is responsible for
// redacting those to a changed-flag boolean before diffing (as
// settings.ts already does for the SMTP password).
export function diffChangedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: (keyof T)[],
): AuditChanges | undefined {
  const changes: AuditChanges = {};
  for (const key of keys) {
    const normalize = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
    const from = normalize(before[key]);
    const to = normalize(after[key]);
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[key as string] = { from, to };
    }
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

interface RecordAuditEventInput {
  req?: Request;
  actorType: "USER" | "SERVICE";
  actorId: string;
  actorEmail: string;
  action: string; // "<resource>.<operation>", e.g. "job.create" — REQUIREMENTS §7.1
  targetType: string;
  targetId?: string;
  targetName?: string;
  // The affected second principal (§41) — e.g. the user added to a team
  // or granted a project ACL. Distinct from targetType/Id/Name, which is
  // the resource the action was performed on.
  subjectType?: string;
  subjectId?: string;
  subjectName?: string;
  result: "SUCCESS" | "FAILURE";
  errorMessage?: string;
  correlationId?: string;
  category?: AuditCategory;
  // Before->after diff for *.update actions — never put secret values
  // here; record a boolean changed-flag instead (as settings.ts already
  // does for the SMTP password).
  changes?: AuditChanges;
  details?: Record<string, unknown>;
}

// Narrow fallback logger for this one best-effort side-channel — every
// recordAuditEvent() call site (40+ across routes/) predates a logger
// being threaded through, and a syslog delivery failure shouldn't be
// the reason to change all of them.
const syslogLogger = pino({ name: "syslog-mirror" });

// Ties every event from one login session together (a SIEM can then
// answer "what did this session do after logging in") without logging
// the session id itself, which is a bearer credential equivalent — same
// reasoning as never storing a raw password-reset token (crypto.ts).
function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

// Express only fills in req.route once a route handler is reached
// (never for a 404), which is the only case recordAuditEvent is called
// from anyway. req.baseUrl carries the literal mounted prefix (params
// substituted with real values for parent routers, e.g.
// "/api/projects/<uuid>/jobs"); req.route.path is the matched route's
// own pattern relative to that mount (e.g. "/:id") — concatenating
// gives a reasonably low-cardinality path template without needing a
// separate route registry.
function httpPathFor(req: Request): string {
  const routePath = (req.route as { path?: string } | undefined)?.path;
  return routePath ? `${req.baseUrl}${routePath}` : req.originalUrl;
}

// Single write path for audit events so every caller produces the same
// shape described in REQUIREMENTS.md §7.1 — no ad hoc console.log audit
// trails scattered through route handlers. "How/where" fields (request
// id, HTTP method/path, user-agent, session-scoped correlation id) are
// derived from `req` here rather than requiring every one of the ~60
// call sites to pass them (§41) — the same pattern already used for
// sourceIp below.
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  const req = input.req;
  const correlationId = input.correlationId ?? (req?.sessionID ? hashSessionId(req.sessionID) : undefined);
  const requestId = req?.id !== undefined ? String(req.id) : undefined;

  const candidate = {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    actorType: input.actorType,
    actorId: input.actorId,
    actorEmail: input.actorEmail,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    targetName: input.targetName,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    result: input.result,
    errorMessage: input.errorMessage,
    sourceIp: req?.ip,
    correlationId,
    requestId,
    httpMethod: req?.method,
    httpPath: req ? httpPathFor(req) : undefined,
    userAgent: req?.get("user-agent"),
    category: input.category,
    changes: input.changes,
    details: input.details,
  };

  // Best-effort shape check on the way in — a bug at a new call site
  // (e.g. a malformed action string) should be visible in logs, never
  // block the operation being audited.
  const parsed = auditEventSchema.safeParse(candidate);
  if (!parsed.success) {
    syslogLogger.warn({ issues: parsed.error.issues, action: input.action }, "audit event failed schema validation");
  }

  const event = await prisma.auditEvent.create({
    data: {
      id: candidate.eventId,
      actorType: candidate.actorType,
      actorId: candidate.actorId,
      actorEmail: candidate.actorEmail,
      action: candidate.action,
      targetType: candidate.targetType,
      targetId: candidate.targetId,
      targetName: candidate.targetName,
      subjectType: candidate.subjectType,
      subjectId: candidate.subjectId,
      subjectName: candidate.subjectName,
      result: candidate.result,
      errorMessage: candidate.errorMessage,
      sourceIp: candidate.sourceIp,
      correlationId: candidate.correlationId,
      requestId: candidate.requestId,
      httpMethod: candidate.httpMethod,
      httpPath: candidate.httpPath,
      userAgent: candidate.userAgent,
      category: candidate.category,
      changes: candidate.changes as never,
      details: candidate.details as never,
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
  subjectType: string | null;
  subjectId: string | null;
  subjectName: string | null;
  result: string;
  errorMessage: string | null;
  correlationId: string | null;
  requestId: string | null;
  sourceIp: string | null;
  httpMethod: string | null;
  httpPath: string | null;
  userAgent: string | null;
  category: string | null;
  changes: unknown;
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
