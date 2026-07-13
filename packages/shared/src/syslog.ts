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
  result: string;
  errorMessage?: string | null;
  correlationId?: string | null;
  details?: unknown;
  appName: string; // emitting service, e.g. "nexus-scheduler-api" / "-worker"
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

// Builds one RFC 5424 message from an audit event, per REQUIREMENTS
// §7.1's field mapping: TIMESTAMP=timestamp, HOSTNAME/APP-NAME=the
// emitting pod, MSGID=action, and the rest (event_id, actor_type,
// actor_id, actor_email, target_type, target_id, result, correlation_id)
// as STRUCTURED-DATA under a single nexusAudit@<enterprise-id> SD-ID;
// details and a human-readable summary form the MSG body.
export function buildRfc5424Message(fields: SyslogAuditFields): string {
  const facility = 16; // local0 — REQUIREMENTS doesn't mandate a specific facility
  const severity = fields.result === "FAILURE" ? 4 : 6; // warning / informational
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
    sdParam("result", fields.result) +
    sdParam("errorMessage", fields.errorMessage) +
    sdParam("correlationId", fields.correlationId) +
    `]`;

  const targetSuffix = fields.targetId ? `:${fields.targetId}` : "";
  const summary = `${fields.action} ${fields.result.toLowerCase()} (actor=${fields.actorEmail}, target=${fields.targetType}${targetSuffix})`;
  const detailsSuffix = fields.details ? ` ${JSON.stringify(fields.details)}` : "";
  const msg = `${summary}${detailsSuffix}`;

  return `<${pri}>${version} ${timestamp} ${hostname} ${fields.appName} ${procId} ${msgId} ${structuredData} ${msg}`;
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
    // The receiver's host may resolve to IPv6 (or be an IPv6 literal); a
    // hardcoded udp4 socket rejects those with EINVAL, so resolve the
    // address family first and open a matching socket. Note UDP remains
    // fire-and-forget: a resolved promise means the datagram left this
    // host, not that the receiver got it.
    dns.lookup(destination.host, (lookupErr, address, family) => {
      if (lookupErr) {
        finish(lookupErr);
        return;
      }
      const socket = dgram.createSocket(family === 6 ? "udp6" : "udp4");
      const buf = Buffer.from(message, "utf8");
      socket.once("error", (err) => {
        socket.close();
        finish(err);
      });
      socket.send(buf, destination.port, address, (err) => {
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
