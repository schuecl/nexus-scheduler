import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import bcrypt from "bcryptjs";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { AppConfig } from "./config.js";
import { prisma } from "./db.js";

// Regression test for the concurrent-prompt-version-create race (§30/§51):
// N concurrent POST .../versions on the same Prompt must produce N
// distinct, gapless version numbers, never a duplicate or a 500 from the
// (promptId, versionNumber) unique-constraint conflict createNextPromptVersion
// retries around (packages/api/src/routes/prompts.ts). Driven through the
// real HTTP route via supertest, not by calling that retry helper
// directly, since the route is the actual unit of concurrency here (each
// request gets its own read of "the latest version so far").
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.API_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  SESSION_SECRET: "promptver-test-session-secret-at-least-32-chars",
  APP_BASE_URL: undefined,
  OIDC_ISSUER_URL: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_REDIRECT_URI: undefined,
  LOCAL_AUTH_ENABLED: true,
  BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
  API_KEY_ENCRYPTION_KEY: "promptver-test-encryption-key-32-chars!",
  LIBRECHAT_BASE_URL: undefined,
  PDF_SERVICE_URL: "http://placeholder.invalid",
  PDF_SERVICE_SHARED_SECRET: undefined,
  LOG_LEVEL: "error",
};

const PASSWORD = "correct horse battery staple";

async function resetDb() {
  await prisma.auditEvent.deleteMany({});
  await prisma.promptVersion.deleteMany({});
  await prisma.prompt.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.user.deleteMany({});
}

describe("concurrent prompt-version creation (§51)", () => {
  let app: Express;
  let redisClient: Redis;
  let runsQueue: Queue;

  beforeAll(() => {
    app = createApp(config, createLogger(config));
    redisClient = app.get("redisClient");
    runsQueue = app.get("runsQueue");
  });

  afterAll(async () => {
    await resetDb();
    await runsQueue.close();
    await redisClient.quit();
    await prisma.$disconnect();
  });

  it("assigns monotonically unique version numbers under N concurrent creates", async () => {
    await resetDb();
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await prisma.user.create({
      data: { email: "promptver-user@example.test", authSource: "LOCAL", role: "EDITOR", active: true, passwordHash },
    });
    const project = await prisma.project.create({ data: { name: "P", ownerId: user.id, visibility: "PRIVATE" } });
    const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });
    await prisma.promptVersion.create({
      data: { promptId: prompt.id, versionNumber: 1, content: "v1", createdById: user.id },
    });

    const agent = request.agent(app);
    const loginRes = await agent.post("/auth/local-login").send({ email: user.email, password: PASSWORD });
    expect(loginRes.status).toBe(200);

    const CONCURRENCY = 15;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        agent.post(`/api/prompts/${prompt.id}/versions`).send({ content: `v-concurrent-${i}`, variables: [] }),
      ),
    );

    for (const res of responses) {
      expect([201, 409]).toContain(res.status);
    }
    // Every request should have succeeded outright (409 is the documented
    // "too much concurrent activity, please retry" outcome only after
    // MAX_VERSION_CONFLICT_RETRIES is exhausted — at 15-way concurrency
    // against a fresh prompt this shouldn't happen, and if it starts
    // happening that's worth knowing about too).
    const succeeded = responses.filter((r) => r.status === 201);
    expect(succeeded.length).toBe(CONCURRENCY);

    const versions = await prisma.promptVersion.findMany({
      where: { promptId: prompt.id },
      orderBy: { versionNumber: "asc" },
    });
    const versionNumbers = versions.map((v) => v.versionNumber);
    const uniqueNumbers = new Set(versionNumbers);

    // No duplicates...
    expect(uniqueNumbers.size).toBe(versionNumbers.length);
    // ...and gapless: the seed version (1) plus CONCURRENCY new ones is
    // exactly {1, 2, ..., CONCURRENCY + 1}.
    expect(versionNumbers).toEqual(Array.from({ length: CONCURRENCY + 1 }, (_, i) => i + 1));
  });
});
