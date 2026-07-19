import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Express } from "express";
import { Redis } from "ioredis";
import { WORKER_HEARTBEAT_KEY, workerComponentStatusKey } from "@nexus-scheduler/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import type { AppConfig } from "../config.js";

// Regression coverage for issue #131 (live system map): Postgres/Redis/
// pdf-service are probed directly by the API; LibreChat and the
// Worker's own liveness are read back from Redis keys the Worker would
// have published (componentStatusPublisher.ts, worker package) — set
// directly here to simulate that without needing a real worker process.
// Real Postgres/Redis + a real in-process HTTP stub for pdf-service,
// same "no mocking the system under test" posture as the rest of this
// suite.

const ENCRYPTION_KEY = "system-status-test-encryption-key-32ch!";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let pdfServer: Server;
let pdfBaseUrl: string;
let app: Express;
let directRedis: Redis;

beforeAll(async () => {
  pdfServer = http.createServer((_req, res) => res.writeHead(200).end("ok"));
  await new Promise<void>((resolve) => pdfServer.listen(0, "127.0.0.1", resolve));
  pdfBaseUrl = `http://127.0.0.1:${(pdfServer.address() as AddressInfo).port}`;

  const config = {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://ci:ci@localhost:5432/ci?schema=public",
    REDIS_URL,
    SESSION_SECRET: "system-status-test-session-secret-0000",
    API_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY,
    LOCAL_AUTH_ENABLED: true,
    BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
    PDF_SERVICE_URL: pdfBaseUrl,
    LOG_LEVEL: "silent",
  } as unknown as AppConfig;

  app = createApp(config, createLogger(config));
  directRedis = new Redis(REDIS_URL);
});

async function resetDb() {
  await prisma.user.deleteMany({});
}

beforeEach(async () => {
  await resetDb();
  await directRedis.del(workerComponentStatusKey("librechat"));
  await directRedis.del(WORKER_HEARTBEAT_KEY);
});

afterEach(async () => {
  await directRedis.del(workerComponentStatusKey("librechat"));
  await directRedis.del(WORKER_HEARTBEAT_KEY);
});

afterAll(async () => {
  await resetDb();
  const runsQueue = app.get("runsQueue") as { close: () => Promise<void> } | undefined;
  const redisClient = app.get("redisClient") as { disconnect: () => void } | undefined;
  try {
    if (runsQueue) await runsQueue.close();
  } finally {
    redisClient?.disconnect();
  }
  directRedis.disconnect();
  await prisma.$disconnect();
  await new Promise<void>((resolve) => pdfServer.close(() => resolve()));
});

let userCounter = 0;
// Admin by default: the endpoint is admin-gated (live infrastructure
// reachability is operational data, not something every user sees).
async function agentFor(role: "ADMIN" | "EDITOR" = "ADMIN") {
  userCounter += 1;
  const email = `system-status-user-${userCounter}@example.test`;
  const password = "correct-horse-battery-staple";
  await prisma.user.create({
    data: { email, authSource: "LOCAL", role, active: true, passwordHash: bcrypt.hashSync(password, 12) },
  });
  const agent = request.agent(app);
  const res = await agent.post("/auth/local-login").send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

describe("GET /api/system-status (issue #131)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/system-status");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin user with 403", async () => {
    const agent = await agentFor("EDITOR");
    const res = await agent.get("/api/system-status");
    expect(res.status).toBe(403);
  });

  it("reports postgres/redis/pdf-service as up (all reachable in this environment) and worker-owned links as stale when nothing has been published", async () => {
    const agent = await agentFor();
    const res = await agent.get("/api/system-status");

    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.components as Array<{ id: string; status: string }>).map((c) => [c.id, c.status]));
    expect(byId.api).toBe("up");
    expect(byId.postgres).toBe("up");
    expect(byId.redis).toBe("up");
    expect(byId["pdf-service"]).toBe("up");
    expect(byId.worker).toBe("stale");
    expect(byId.librechat).toBe("stale");
    expect(byId.ocr).toBe("stale");
  });

  it("reflects a worker-published 'unconfigured' status for the optional OCR service", async () => {
    const agent = await agentFor();
    await directRedis.set(workerComponentStatusKey("ocr"), "unconfigured", "EX", 90);

    const res = await agent.get("/api/system-status");

    const byId = Object.fromEntries((res.body.components as Array<{ id: string; status: string }>).map((c) => [c.id, c.status]));
    expect(byId.ocr).toBe("unconfigured");
  });

  it("reflects a worker-published 'down' status for LibreChat", async () => {
    const agent = await agentFor();
    await directRedis.set(workerComponentStatusKey("librechat"), "down", "EX", 90);
    await directRedis.set(WORKER_HEARTBEAT_KEY, "up", "EX", 90);

    const res = await agent.get("/api/system-status");

    const byId = Object.fromEntries((res.body.components as Array<{ id: string; status: string }>).map((c) => [c.id, c.status]));
    expect(byId.librechat).toBe("down");
    expect(byId.worker).toBe("up");
  });

  it("includes the expected edges between components", async () => {
    const agent = await agentFor();
    const res = await agent.get("/api/system-status");

    expect(res.body.edges).toEqual(
      expect.arrayContaining([
        { from: "api", to: "postgres" },
        { from: "api", to: "redis" },
        { from: "api", to: "pdf-service" },
        { from: "worker", to: "librechat" },
      ]),
    );
  });
});
