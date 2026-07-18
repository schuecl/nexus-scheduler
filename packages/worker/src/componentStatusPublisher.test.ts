import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Queue } from "bullmq";
import { WORKER_HEARTBEAT_KEY, workerComponentStatusKey } from "@nexus-scheduler/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { createRunsQueue, type RunJobData } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";
import { publishComponentStatus } from "./componentStatusPublisher.js";

// Regression coverage for issue #131 (live system map): the Worker is
// the only process that can reach LibreChat, so it publishes what it
// finds to Redis with a TTL rather than the API guessing. Real Redis +
// a real in-process HTTP stub standing in for LibreChat, same posture
// as the rest of this suite.
interface RawTestClient {
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

const REDIS_URL = process.env.WORKER_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const connection = parseRedisConnectionOptions(REDIS_URL);

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

function listenServer(handler: (res: http.ServerResponse) => void): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => handler(res));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("publishComponentStatus (issue #131)", () => {
  let queue: Queue<RunJobData>;
  let stubServer: Server | undefined;

  beforeEach(async () => {
    queue = createRunsQueue(connection);
    const raw = (await queue.client) as unknown as RawTestClient;
    await raw.del(workerComponentStatusKey("librechat"));
    await raw.del(WORKER_HEARTBEAT_KEY);
  });

  afterEach(async () => {
    await queue.close();
    if (stubServer) {
      const s = stubServer;
      stubServer = undefined;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  afterAll(async () => {
    // No Prisma/Postgres involvement in this suite — nothing to disconnect.
  });

  it("publishes 'up' with a TTL when LibreChat answers", async () => {
    const { server, baseUrl } = await listenServer((res) => res.writeHead(200).end("ok"));
    stubServer = server;
    const config = { LIBRECHAT_BASE_URL: baseUrl } as WorkerConfig;

    await publishComponentStatus(queue, config, logger);

    const raw = (await queue.client) as unknown as RawTestClient;
    expect(await raw.get(workerComponentStatusKey("librechat"))).toBe("up");
    const ttl = await raw.ttl(workerComponentStatusKey("librechat"));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
    expect(await raw.get(WORKER_HEARTBEAT_KEY)).toBe("up");
  });

  it("publishes 'up' even on a non-2xx response — reachability, not full health", async () => {
    const { server, baseUrl } = await listenServer((res) => res.writeHead(404).end("not found"));
    stubServer = server;
    const config = { LIBRECHAT_BASE_URL: baseUrl } as WorkerConfig;

    await publishComponentStatus(queue, config, logger);

    const raw = (await queue.client) as unknown as RawTestClient;
    expect(await raw.get(workerComponentStatusKey("librechat"))).toBe("up");
  });

  it("publishes 'down' when LibreChat is unreachable", async () => {
    // Nothing listening on this port.
    const config = { LIBRECHAT_BASE_URL: "http://127.0.0.1:1" } as WorkerConfig;

    await publishComponentStatus(queue, config, logger);

    const raw = (await queue.client) as unknown as RawTestClient;
    expect(await raw.get(workerComponentStatusKey("librechat"))).toBe("down");
    // The heartbeat is independent of LibreChat's own reachability — the
    // Worker itself is still alive and publishing.
    expect(await raw.get(WORKER_HEARTBEAT_KEY)).toBe("up");
  });
});
