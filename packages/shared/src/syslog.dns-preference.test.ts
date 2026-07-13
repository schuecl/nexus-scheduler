import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import dgram from "node:dgram";
import { sendSyslogMessage } from "./syslog.js";

// Isolated in its own file: mocking node:dns here would otherwise also
// intercept the real UDP/TCP/TLS delivery tests in syslog.test.ts, which
// need genuine DNS/IP-literal resolution to hit real local servers.
// vi.mock calls are hoisted above all imports in this file by vitest,
// so syslog.ts's own `import dns from "node:dns"` resolves to this
// mock regardless of the static import above appearing first in source.
vi.mock("node:dns", () => ({
  default: {
    // Simulates a dual-stack hostname where the AAAA record sorts first
    // (a real quirk of some resolvers/`localhost` configs) — the code
    // under test must still choose the IPv4 address so a receiver bound
    // only on IPv4 isn't silently missed over UDP.
    lookup: (
      _host: string,
      _opts: unknown,
      cb: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
    ) => {
      cb(null, [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]);
    },
  },
}));

describe("sendSyslogMessage — UDP IPv4 preference", () => {
  let server: dgram.Socket | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  // This sandbox has no IPv6 support at all (dgram bind on "::1" fails
  // with EAFNOSUPPORT), so the preference is verified two ways instead
  // of racing a real udp4 receiver against a real udp6 one: (1) a real
  // udp4 server actually receives the datagram, proving delivery works
  // end to end: (2) dgram.createSocket is spied on (not replaced — the
  // real implementation still runs) to confirm it was called with
  // "udp4", not "udp6", directly proving the family-selection logic
  // picked the IPv4 record rather than whichever dns.lookup listed first.
  it("sends over a udp4 socket when dns.lookup returns both an AAAA and an A record", async () => {
    server = dgram.createSocket("udp4");
    const received = new Promise<string>((resolve) => {
      server!.once("message", (msg) => resolve(msg.toString("utf8")));
    });
    await new Promise<void>((resolve) => server!.bind(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const createSocketSpy = vi.spyOn(dgram, "createSocket");
    try {
      await sendSyslogMessage(
        { host: "dual-stack.example.test", port, transport: "UDP", tls: false },
        "prefer ipv4",
      );
      expect(await received).toBe("prefer ipv4");
      expect(createSocketSpy).toHaveBeenCalledWith("udp4");
      expect(createSocketSpy).not.toHaveBeenCalledWith("udp6");
    } finally {
      createSocketSpy.mockRestore();
    }
  });

  it("falls back to udp6 when only an AAAA record is available", async () => {
    // Confirms the fallback branch (`addresses.find(...) ?? addresses[0]`)
    // isn't just always choosing index 0 by coincidence — with no IPv4
    // record at all, it must still pick the (only) IPv6 one. Actually
    // exercising a udp6 socket isn't possible in this sandbox, so this
    // only asserts the socket-family decision, not real delivery.
    vi.doMock("node:dns", () => ({
      default: {
        lookup: (
          _host: string,
          _opts: unknown,
          cb: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
        ) => cb(null, [{ address: "::1", family: 6 }]),
      },
    }));
    vi.resetModules();
    const { sendSyslogMessage: sendWithIpv6Only } = await import("./syslog.js");

    const createSocketSpy = vi.spyOn(dgram, "createSocket").mockImplementation(() => {
      throw new Error("EAFNOSUPPORT (simulated — this sandbox has no IPv6)");
    });
    try {
      await expect(
        sendWithIpv6Only({ host: "ipv6-only.example.test", port: 1, transport: "UDP", tls: false }, "x"),
      ).rejects.toThrow();
      expect(createSocketSpy).toHaveBeenCalledWith("udp6");
    } finally {
      createSocketSpy.mockRestore();
      vi.doUnmock("node:dns");
      vi.resetModules();
    }
  });
});
