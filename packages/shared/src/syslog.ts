import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import tls from "node:tls";
import os from "node:os";

// Syslog audit-event mirror (REQUIREMENTS.md §7.1) — RFC 5424 message
// format, RFC 6587-style octet-counting framing over TCP (TLS optional
// per RFC 5425), or a bare datagram over UDP. Independent of the
// Postgres audit trail: this is a forwarding path to an external SIEM,
// not a second copy of local storage, so delivery here must never be
// allowed to affect the operation being audited.

export type SyslogTransportKind = "TCP" | "UDP";

export interface SyslogDestination {
  host: string;
  port: number;
  transport: SyslogTransportKind;
  tls: boolean;
  // Optional PEM-encoded CA certificate(s) to verify the receiver's TLS
  // cert against, for receivers using a private CA not in the system
  // trust store. When omitted, Node's default trust roots are used.
  // Verification is never disabled — an unverifiable cert still fails.
  caCert?: string | null;
}

export interface SyslogAuditFields {
  timestamp: Date;
  eventId: string;
  actorType: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  targetName?: string | null;
  // The affected second principal (§41), e.g. the user added to a team
  // or granted a project ACL — distinct from targetType/Id/Name, which
  // is the resource the action was performed on.
  subjectType?: string | null;
  subjectId?: string | null;
  subjectName?: string | null;
  result: string;
  errorMessage?: string | null;
  correlationId?: string | null;
  // Undefined for Worker-originated events (schedule fires, no HTTP
  // request to read an IP from) — sdParam already omits the SD-PARAM
  // entirely when this is null/undefined/empty.
  sourceIp?: string | null;
  requestId?: string | null;
  httpMethod?: string | null;
  httpPath?: string | null;
  userAgent?: string | null;
  // Event classification (§41) — drives the severity bump below and
  // lets a SIEM alert/correlate without enumerating every action string.
  category?: string | null;
  // Before->after diff for *.update actions — emitted as its own
  // SD-PARAM (JSON-encoded), not folded into `details`/MSG, so a SIEM
  // can actually extract/query it (§41).
  changes?: unknown;
  details?: unknown;
  appName: string; // emitting service, e.g. "nexus-scheduler-api" / "-worker"
}

// Categories treated as security-sensitive enough that even a SUCCESS
// shouldn't blend in at informational severity (§41) — a successful
// privilege escalation or ACL grant is a materially different event
// from a benign read, and syslog severity is the one signal a SIEM can
// filter/alert on without parsing STRUCTURED-DATA.
const NOTICE_WORTHY_CATEGORIES = new Set(["authz_change", "admin", "governance"]);

function severityFor(result: string, category: string | null | undefined): number {
  if (result === "FAILURE") return 4; // warning
  if (category && NOTICE_WORTHY_CATEGORIES.has(category)) return 5; // notice
  return 6; // informational
}

// IANA-reserved Private Enterprise Number for documentation/example use
// (RFC 5612 / IANA PEN registry) — a real deployment integrating with a
// specific SIEM should register/substitute its own organization's PEN
// here if the receiver cares about ENTERPRISE-ID uniqueness; nothing
// about Nexus Scheduler's own behavior depends on this value.
const ENTERPRISE_ID = "32473";
const SD_ID = `nexusAudit@${ENTERPRISE_ID}`;

function escapeSdParamValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/]/g, "\\]");
}

function sdParam(name: string, value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return ` ${name}="${escapeSdParamValue(value)}"`;
}

// Common receivers cap a UDP datagram around ~2KB and silently
// drop/truncate anything larger (and an oversized datagram risks IP
// fragmentation/loss even before it gets there) — a verbose `details`
// object with no size limit could produce an audit event that never
// reaches the SIEM, with no error surfaced (UDP send resolves once the
// datagram leaves this host, not once it's received). TCP has no such
// hard ceiling, but applying the same budget everywhere keeps one
// receiver's behavior from being a surprise depending on which
// transport happens to be configured.
const MAX_MESSAGE_BYTES = 2048;
const TRUNCATION_MARKER = "...[truncated]";

// Cuts `value` down to at most `maxBytes` UTF-8 bytes without slicing a
// multi-byte character in half — Buffer#toString("utf8") already
// replaces a trailing partial sequence with U+FFFD rather than
// producing invalid output, so this is safe for any input.
function truncateToByteLength(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.byteLength <= maxBytes) return value;
  return buf.subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

// Builds one RFC 5424 message from an audit event, per REQUIREMENTS
// §7.1's field mapping: TIMESTAMP=timestamp, HOSTNAME/APP-NAME=the
// emitting pod, MSGID=action, and the rest — including the affected
// subject, before->after changes, request/session correlation ids, and
// HTTP method/path/user-agent (§41) — as STRUCTURED-DATA under a single
// nexusAudit@<enterprise-id> SD-ID, so a SIEM can extract/query/alert on
// them directly rather than parsing a free-text blob. Only `details`
// (action-specific, not otherwise standardized) and a human-readable
// summary form the MSG body. Severity is bumped from informational to
// notice for a SUCCESS in a security-sensitive category (§41) so a
// privilege escalation doesn't read the same as a benign read.
export function buildRfc5424Message(fields: SyslogAuditFields): string {
  const facility = 16; // local0 — REQUIREMENTS doesn't mandate a specific facility
  const severity = severityFor(fields.result, fields.category);
  const pri = facility * 8 + severity;
  const version = 1;
  const timestamp = fields.timestamp.toISOString();
  const hostname = os.hostname();
  const procId = process.pid;
  // MSGID is capped at 32 characters by RFC 5424; action strings here
  // (e.g. "run.notify_email") are always well under that in practice.
  const msgId = fields.action.slice(0, 32);

  const structuredData =
    `[${SD_ID}` +
    sdParam("eventId", fields.eventId) +
    sdParam("actorType", fields.actorType) +
    sdParam("actorId", fields.actorId) +
    sdParam("actorEmail", fields.actorEmail) +
    sdParam("targetType", fields.targetType) +
    sdParam("targetId", fields.targetId) +
    sdParam("targetName", fields.targetName) +
    sdParam("subjectType", fields.subjectType) +
    sdParam("subjectId", fields.subjectId) +
    sdParam("subjectName", fields.subjectName) +
    sdParam("result", fields.result) +
    sdParam("errorMessage", fields.errorMessage) +
    sdParam("correlationId", fields.correlationId) +
    sdParam("requestId", fields.requestId) +
    sdParam("sourceIp", fields.sourceIp) +
    sdParam("httpMethod", fields.httpMethod) +
    sdParam("httpPath", fields.httpPath) +
    sdParam("userAgent", fields.userAgent) +
    sdParam("category", fields.category) +
    sdParam("changes", fields.changes ? JSON.stringify(fields.changes) : undefined) +
    `]`;

  const targetSuffix = fields.targetId ? `:${fields.targetId}` : "";
  const subjectSuffix = fields.subjectName ? `, subject=${fields.subjectName}` : "";
  const summary = `${fields.action} ${fields.result.toLowerCase()} (actor=${fields.actorEmail}, target=${fields.targetType}${targetSuffix}${subjectSuffix})`;
  const detailsSuffix = fields.details ? ` ${JSON.stringify(fields.details)}` : "";
  const msg = `${summary}${detailsSuffix}`;

  const header = `<${pri}>${version} ${timestamp} ${hostname} ${fields.appName} ${procId} ${msgId} ${structuredData} `;
  const full = `${header}${msg}`;
  if (Buffer.byteLength(full, "utf8") <= MAX_MESSAGE_BYTES) {
    return full;
  }
  // Truncate only the free-text MSG tail, never HEADER/STRUCTURED-DATA —
  // those carry the fields a SIEM actually correlates/alerts on, so
  // they're worth preserving over an oversized `details` blob. The
  // marker below is what makes the truncation visible to whoever's
  // reading the forwarded stream, instead of a silently clipped record.
  const headerBytes = Buffer.byteLength(header, "utf8");
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const msgBudget = Math.max(0, MAX_MESSAGE_BYTES - headerBytes - markerBytes);
  return `${header}${truncateToByteLength(msg, msgBudget)}${TRUNCATION_MARKER}`;
}

// Sends one syslog message. Best-effort by design: callers must treat a
// rejected promise here as "delivery failed" and never let it affect
// the operation being audited — Postgres remains the system of record.
export async function sendSyslogMessage(destination: SyslogDestination, message: string): Promise<void> {
  if (destination.transport === "UDP") {
    return sendUdp(destination, message);
  }
  return sendTcp(destination, message);
}

function sendUdp(destination: SyslogDestination, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    // The receiver's host may be IPv6 (or an IPv6 literal); a hardcoded udp4
    // socket rejects those with EINVAL. Resolve *all* addresses and prefer
    // IPv4: a bare dns.lookup() can return an AAAA record first for dual-stack
    // names like "localhost", which would send over udp6 and — UDP being
    // fire-and-forget — silently miss a receiver bound only on IPv4. Fall back
    // to IPv6 only for IPv6-only hosts. A resolved promise means the datagram
    // left this host, not that the receiver got it.
    dns.lookup(destination.host, { all: true }, (lookupErr, addresses) => {
      if (lookupErr || addresses.length === 0) {
        finish(lookupErr ?? new Error(`could not resolve syslog host ${destination.host}`));
        return;
      }
      const chosen = addresses.find((a) => a.family === 4) ?? addresses[0];
      if (!chosen) {
        finish(new Error(`could not resolve syslog host ${destination.host}`));
        return;
      }
      const socket = dgram.createSocket(chosen.family === 6 ? "udp6" : "udp4");
      const buf = Buffer.from(message, "utf8");
      socket.once("error", (err) => {
        socket.close();
        finish(err);
      });
      socket.send(buf, destination.port, chosen.address, (err) => {
        socket.close();
        finish(err ?? undefined);
      });
    });
  });
}

function sendTcp(destination: SyslogDestination, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // RFC 6587 octet-counting framing: "<msg-len> <SYSLOG-MSG>" — the
    // receiver reads exactly msg-len bytes for the message, so there's
    // no delimiter ambiguity even if MSG itself contains newlines.
    const framed = `${Buffer.byteLength(message, "utf8")} ${message}`;
    const timeoutMs = 5000;

    const socket: net.Socket = destination.tls
      ? tls.connect({
          host: destination.host,
          port: destination.port,
          // SNI — required by receivers that host multiple certs; harmless
          // otherwise. Only sent for DNS names, not IP literals (per RFC 6066).
          servername: net.isIP(destination.host) ? undefined : destination.host,
          // Trust an operator-supplied private CA when provided; otherwise
          // fall back to Node's default roots. rejectUnauthorized stays on.
          ...(destination.caCert ? { ca: destination.caCert } : {}),
        })
      : net.connect({ host: destination.host, port: destination.port });

    socket.setTimeout(timeoutMs);
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("syslog TCP connection timed out"));
    });

    socket.once(destination.tls ? "secureConnect" : "connect", () => {
      socket.write(framed, "utf8", (err) => {
        socket.end();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
