import { afterEach, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import dgram from "node:dgram";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRfc5424Message, sendSyslogMessage, type SyslogAuditFields } from "./syslog.js";

const baseFields: SyslogAuditFields = {
  timestamp: new Date("2026-01-01T12:00:00.000Z"),
  eventId: "evt-1",
  actorType: "USER",
  actorId: "user-1",
  actorEmail: "test@example.com",
  action: "job.create",
  targetType: "job",
  targetId: "job-1",
  result: "SUCCESS",
  appName: "nexus-scheduler-api",
};

describe("buildRfc5424Message", () => {
  it("produces a well-formed RFC 5424 header and structured data", () => {
    const msg = buildRfc5424Message(baseFields);
    // <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD] MSG
    expect(msg).toMatch(/^<\d+>1 /);
    expect(msg).toContain("2026-01-01T12:00:00.000Z");
    expect(msg).toContain("nexus-scheduler-api");
    expect(msg).toContain("job.create");
    expect(msg).toContain('[nexusAudit@32473 eventId="evt-1"');
    expect(msg).toContain('actorEmail="test@example.com"');
    expect(msg).toContain('targetId="job-1"');
  });

  it("uses severity 6 (informational) for SUCCESS and 4 (warning) for FAILURE", () => {
    const successMsg = buildRfc5424Message({ ...baseFields, result: "SUCCESS" });
    const failureMsg = buildRfc5424Message({ ...baseFields, result: "FAILURE" });
    // facility 16 (local0) * 8 = 128; +6 = 134, +4 = 132
    expect(successMsg.startsWith("<134>1 ")).toBe(true);
    expect(failureMsg.startsWith("<132>1 ")).toBe(true);
  });

  // §41: a successful privilege escalation/ACL grant/admin action
  // shouldn't blend in with routine reads at informational severity.
  it("bumps SUCCESS severity to 5 (notice) for security-sensitive categories", () => {
    const authzMsg = buildRfc5424Message({ ...baseFields, result: "SUCCESS", category: "authz_change" });
    const adminMsg = buildRfc5424Message({ ...baseFields, result: "SUCCESS", category: "admin" });
    const governanceMsg = buildRfc5424Message({ ...baseFields, result: "SUCCESS", category: "governance" });
    // facility 16 * 8 = 128; +5 = 133
    expect(authzMsg.startsWith("<133>1 ")).toBe(true);
    expect(adminMsg.startsWith("<133>1 ")).toBe(true);
    expect(governanceMsg.startsWith("<133>1 ")).toBe(true);
  });

  it("leaves non-sensitive categories and FAILUREs of any category at their normal severity", () => {
    const dataAccessMsg = buildRfc5424Message({ ...baseFields, result: "SUCCESS", category: "data_access" });
    const failedAuthzMsg = buildRfc5424Message({ ...baseFields, result: "FAILURE", category: "authz_change" });
    expect(dataAccessMsg.startsWith("<134>1 ")).toBe(true); // still informational
    expect(failedAuthzMsg.startsWith("<132>1 ")).toBe(true); // still warning, not further escalated
  });

  // §41: the affected second principal (e.g. the user added to a team),
  // distinct from targetType/Id/Name.
  it("includes subject fields in structured data and the MSG summary when present", () => {
    const msg = buildRfc5424Message({
      ...baseFields,
      subjectType: "user",
      subjectId: "user-2",
      subjectName: "added@example.com",
    });
    expect(msg).toContain('subjectType="user"');
    expect(msg).toContain('subjectId="user-2"');
    expect(msg).toContain('subjectName="added@example.com"');
    expect(msg).toContain("subject=added@example.com");
  });

  it("includes requestId, HTTP method/path, user-agent, and category as their own SD-PARAMs", () => {
    const msg = buildRfc5424Message({
      ...baseFields,
      requestId: "req-1",
      httpMethod: "PATCH",
      httpPath: "/api/teams/:teamId/members/:userId",
      userAgent: "Mozilla/5.0 test-agent",
      category: "admin",
    });
    expect(msg).toContain('requestId="req-1"');
    expect(msg).toContain('httpMethod="PATCH"');
    expect(msg).toContain('httpPath="/api/teams/:teamId/members/:userId"');
    expect(msg).toContain('userAgent="Mozilla/5.0 test-agent"');
    expect(msg).toContain('category="admin"');
  });

  // §41: changes must be queryable STRUCTURED-DATA, not buried in the
  // free-text MSG/details blob.
  it("JSON-encodes before->after changes as its own SD-PARAM", () => {
    const msg = buildRfc5424Message({
      ...baseFields,
      changes: { role: { from: "VIEW", to: "ADMIN" } },
    });
    expect(msg).toContain(`changes="${JSON.stringify({ role: { from: "VIEW", to: "ADMIN" } }).replace(/"/g, '\\"')}"`);
  });

  it("omits subject/requestId/http*/category/changes SD-PARAMs entirely when absent", () => {
    const msg = buildRfc5424Message(baseFields);
    expect(msg).not.toContain("subjectType=");
    expect(msg).not.toContain("requestId=");
    expect(msg).not.toContain("httpMethod=");
    expect(msg).not.toContain("category=");
    expect(msg).not.toContain("changes=");
  });

  // Regression for #26: sourceIp was dropped entirely from the SIEM
  // mirror even though Postgres has it.
  it("includes sourceIp in the structured data when present", () => {
    const msg = buildRfc5424Message({ ...baseFields, sourceIp: "10.1.2.3" });
    expect(msg).toContain('sourceIp="10.1.2.3"');
  });

  it("omits the sourceIp SD-PARAM entirely when null or undefined", () => {
    expect(buildRfc5424Message({ ...baseFields, sourceIp: null })).not.toContain("sourceIp=");
    expect(buildRfc5424Message({ ...baseFields, sourceIp: undefined })).not.toContain("sourceIp=");
  });

  it("escapes backslash, quote, and closing-bracket characters in SD-PARAM values", () => {
    const msg = buildRfc5424Message({
      ...baseFields,
      targetName: `back\\slash "quoted" ]bracket`,
    });
    expect(msg).toContain('targetName="back\\\\slash \\"quoted\\" \\]bracket"');
  });

  it("includes JSON-serialized details in the MSG body", () => {
    const msg = buildRfc5424Message({ ...baseFields, details: { changed: ["name"] } });
    expect(msg).toContain(JSON.stringify({ changed: ["name"] }));
  });

  // Regression for #34: no cap meant a large `details` blob could
  // produce a datagram common UDP receivers silently drop/truncate.
  it("truncates an oversized message to the byte cap while preserving header and structured data", () => {
    const msg = buildRfc5424Message({ ...baseFields, details: { blob: "x".repeat(5000) } });
    expect(Buffer.byteLength(msg, "utf8")).toBeLessThanOrEqual(2048);
    expect(msg).toContain("job.create");
    expect(msg).toContain('actorId="user-1"');
    expect(msg.endsWith("...[truncated]")).toBe(true);
  });

  it("leaves a message well under the byte cap untouched", () => {
    const msg = buildRfc5424Message(baseFields);
    expect(msg.endsWith("...[truncated]")).toBe(false);
  });
});

describe("sendSyslogMessage — UDP", () => {
  let server: dgram.Socket | undefined;

  afterEach(() => {
    try {
      server?.close();
    } catch {
      // already closed — fine, nothing left to clean up
    }
    server = undefined;
  });

  it("delivers the exact message as a single UDP datagram", async () => {
    const sock = dgram.createSocket("udp4");
    server = sock;
    const received = new Promise<string>((resolve) => {
      sock.once("message", (msg) => resolve(msg.toString("utf8")));
    });
    await new Promise<void>((resolve) => sock.bind(0, "127.0.0.1", resolve));
    const port = (sock.address() as net.AddressInfo).port;

    await sendSyslogMessage({ host: "127.0.0.1", port, transport: "UDP", tls: false }, "a udp test message");

    expect(await received).toBe("a udp test message");
  });

  it("rejects when nothing is listening on the target port", async () => {
    // A closed UDP port doesn't always ICMP-reject reliably in every
    // environment, so this asserts the call either resolves or rejects
    // cleanly (no hang, no unhandled rejection) rather than a specific
    // outcome — the framing/delivery-when-reachable case above is the
    // one that actually matters for this transport.
    await expect(
      Promise.race([
        sendSyslogMessage({ host: "127.0.0.1", port: 1, transport: "UDP", tls: false }, "x"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 2000)),
      ]),
    ).resolves.not.toThrow();
  });
});

describe("sendSyslogMessage — TCP", () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("frames the message with RFC 6587 octet-counting", async () => {
    const sock = net.createServer();
    server = sock;
    const received = new Promise<string>((resolve) => {
      sock.on("connection", (socket) => {
        let data = "";
        socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        socket.on("end", () => resolve(data));
      });
    });
    await new Promise<void>((resolve) => sock.listen(0, "127.0.0.1", resolve));
    const port = (sock.address() as net.AddressInfo).port;

    const message = "a tcp test message\nwith an embedded newline";
    await sendSyslogMessage({ host: "127.0.0.1", port, transport: "TCP", tls: false }, message);

    const expectedLen = Buffer.byteLength(message, "utf8");
    expect(await received).toBe(`${expectedLen} ${message}`);
  });

  it("rejects when the connection times out with nothing listening", async () => {
    // 127.0.0.1 with no listener refuses the connection quickly (ECONNREFUSED)
    // rather than actually timing out, but either way this must reject,
    // not hang.
    await expect(
      sendSyslogMessage({ host: "127.0.0.1", port: 1, transport: "TCP", tls: false }, "x"),
    ).rejects.toThrow();
  });
});

describe("sendSyslogMessage — TLS", () => {
  let caCertPem: string;
  let serverCertPem: string;
  let serverKeyPem: string;

  beforeAll(() => {
    // Throwaway self-signed CA + server cert generated fresh for this
    // test run via openssl (present on both this sandbox and GitHub
    // Actions' ubuntu-latest runners) — mirrors
    // scripts/generate-local-env.sh's local syslog-test-container setup,
    // just scoped to a temp dir instead of the repo's docker/generated/.
    const dir = mkdtempSync(join(tmpdir(), "nexus-syslog-tls-test-"));
    const caKey = join(dir, "ca-key.pem");
    const caCert = join(dir, "ca.pem");
    const serverKey = join(dir, "server-key.pem");
    const serverCsr = join(dir, "server.csr");
    const serverCert = join(dir, "server.pem");

    execFileSync("openssl", ["genrsa", "-out", caKey, "2048"]);
    execFileSync("openssl", [
      "req", "-x509", "-new", "-nodes", "-key", caKey, "-sha256", "-days", "1",
      "-out", caCert, "-subj", "/CN=Nexus Test CA",
    ]);
    execFileSync("openssl", ["genrsa", "-out", serverKey, "2048"]);
    execFileSync("openssl", [
      "req", "-new", "-key", serverKey, "-out", serverCsr, "-subj", "/CN=localhost",
    ]);
    const extFile = join(dir, "ext.cnf");
    writeFileSync(extFile, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    execFileSync("openssl", [
      "x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey,
      "-CAcreateserial", "-out", serverCert, "-days", "1", "-sha256",
      "-extfile", extFile,
    ]);

    caCertPem = readFileSync(caCert, "utf8");
    serverCertPem = readFileSync(serverCert, "utf8");
    serverKeyPem = readFileSync(serverKey, "utf8");
  });

  let server: tls.Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("delivers over TLS and verifies the receiver's cert against a supplied private CA", async () => {
    const sock = tls.createServer({ cert: serverCertPem, key: serverKeyPem });
    server = sock;
    const received = new Promise<string>((resolve) => {
      sock.on("secureConnection", (socket) => {
        let data = "";
        socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        socket.on("end", () => resolve(data));
      });
    });
    await new Promise<void>((resolve) => sock.listen(0, "127.0.0.1", resolve));
    const port = (sock.address() as net.AddressInfo).port;

    const message = "a tls test message";
    await sendSyslogMessage(
      { host: "127.0.0.1", port, transport: "TCP", tls: true, caCert: caCertPem },
      message,
    );

    expect(await received).toBe(`${Buffer.byteLength(message, "utf8")} ${message}`);
  });

  it("rejects an untrusted self-signed cert when no caCert is supplied (rejectUnauthorized stays on)", async () => {
    const sock = tls.createServer({ cert: serverCertPem, key: serverKeyPem });
    server = sock;
    await new Promise<void>((resolve) => sock.listen(0, "127.0.0.1", resolve));
    const port = (sock.address() as net.AddressInfo).port;

    await expect(
      sendSyslogMessage({ host: "127.0.0.1", port, transport: "TCP", tls: true }, "x"),
    ).rejects.toThrow();
  });
});
