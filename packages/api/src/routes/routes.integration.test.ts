import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Express } from "express";
import { prisma } from "../db.js";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import type { AppConfig } from "../config.js";

// Route-level integration tests (issue #45): boot the real Express app
// against the real test Postgres/Redis and exercise the HTTP surface,
// with a focus on the authorization boundaries that unit tests on the
// access helpers can't cover. No mocking of the system under test —
// same posture as the rest of this project's suite.

const ENCRYPTION_KEY = "ci-test-encryption-key-32-characters!!";
const config = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://ci:ci@localhost:5432/ci?schema=public",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  SESSION_SECRET: "integration-test-session-secret-000000",
  API_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY,
  LOCAL_AUTH_ENABLED: true,
  BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
  LOG_LEVEL: "silent",
} as unknown as AppConfig;

let app: Express;

beforeAll(() => {
  app = createApp(config, createLogger(config));
});

async function resetDb() {
  // Child rows first, then parents, so FK constraints don't block.
  await prisma.run.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.promptVersion.deleteMany({});
  await prisma.prompt.deleteMany({});
  await prisma.projectAcl.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.apiKey.deleteMany({});
  await prisma.teamMembership.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.auditEvent.deleteMany({});
}

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  // createApp exposes its Redis client and BullMQ queue via app-locals
  // (app.set) precisely so tests can close them; otherwise those sockets
  // and reconnect timers outlive the suite and leave Vitest waiting on /
  // force-closing workers. try/finally so the Redis handle is released
  // even if the queue close rejects (e.g. a flush timeout).
  const runsQueue = app.get("runsQueue") as { close: () => Promise<void> } | undefined;
  const redisClient = app.get("redisClient") as { disconnect: () => void } | undefined;
  try {
    if (runsQueue) await runsQueue.close();
  } finally {
    redisClient?.disconnect();
  }
  await prisma.$disconnect();
});

let userCounter = 0;
async function makeLocalUser(role: "ADMIN" | "EDITOR" | "VIEW" = "EDITOR") {
  userCounter += 1;
  const email = `int-user-${userCounter}@example.test`;
  const password = "correct-horse-battery-staple";
  const user = await prisma.user.create({
    data: { email, authSource: "LOCAL", role, active: true, passwordHash: bcrypt.hashSync(password, 12) },
  });
  return { user, email, password };
}

// Logs a user in once and returns a cookie-persisting agent, so a whole
// describe block stays well under the 20/15min login rate limit.
async function agentFor(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post("/auth/local-login").send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

async function makeApiKeyForUser(userId: string) {
  // The ownership guard under test never decrypts the key, so a placeholder
  // ciphertext is enough — and it keeps this test independent of the crypto
  // module (covered separately by crypto.test.ts).
  return prisma.apiKey.create({
    data: {
      ownerType: "USER",
      ownerUserId: userId,
      label: "test key",
      encryptedKey: "placeholder-ciphertext",
    },
  });
}

describe("authentication", () => {
  it("rejects an unauthenticated request to a protected route with 401", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
  });

  it("allows an authenticated request through", async () => {
    const { email, password } = await makeLocalUser();
    const agent = await agentFor(email, password);
    const res = await agent.get("/api/projects");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("rejects login with a wrong password", async () => {
    const { email } = await makeLocalUser();
    const res = await request(app).post("/auth/local-login").send({ email, password: "wrong" });
    expect(res.status).toBe(401);
  });
});

describe("project + prompt happy path", () => {
  it("creates a project and a prompt (prompt needs no API key)", async () => {
    const { email, password } = await makeLocalUser();
    const agent = await agentFor(email, password);

    const project = await agent.post("/api/projects").send({ name: "Proj A" });
    expect(project.status).toBe(201);

    const prompt = await agent
      .post(`/api/projects/${project.body.id}/prompts`)
      .send({ name: "Prompt A", content: "Hello {{name}}" });
    expect(prompt.status).toBe(201);
  });
});

describe("API-key IDOR guard on job creation (issue #6)", () => {
  it("lets a user create a job with their OWN key", async () => {
    const a = await makeLocalUser();
    const agent = await agentFor(a.email, a.password);
    const key = await makeApiKeyForUser(a.user.id);

    const project = await agent.post("/api/projects").send({ name: "Owned" });
    const prompt = await agent
      .post(`/api/projects/${project.body.id}/prompts`)
      .send({ name: "P", content: "hi" });

    const job = await agent.post(`/api/projects/${project.body.id}/jobs`).send({
      name: "Job",
      promptId: prompt.body.id,
      agentId: "agent-1",
      apiKeyId: key.id,
    });
    expect(job.status).toBe(201);
  });

  it("rejects a job that references ANOTHER user's API key with 400", async () => {
    const a = await makeLocalUser();
    const b = await makeLocalUser();
    const agent = await agentFor(a.email, a.password);
    const foreignKey = await makeApiKeyForUser(b.user.id); // owned by B

    const project = await agent.post("/api/projects").send({ name: "A's project" });
    const prompt = await agent
      .post(`/api/projects/${project.body.id}/prompts`)
      .send({ name: "P", content: "hi" });

    const job = await agent.post(`/api/projects/${project.body.id}/jobs`).send({
      name: "Sneaky",
      promptId: prompt.body.id,
      agentId: "agent-1",
      apiKeyId: foreignKey.id, // <-- B's key, A is not allowed to use it
    });
    expect(job.status).toBe(400);
    expect(String(job.body.error)).toMatch(/api key/i);

    // And the job must not have been created.
    expect(await prisma.job.count()).toBe(0);
  });
});

describe("project tenancy", () => {
  it("does not let a user access another user's private project", async () => {
    const a = await makeLocalUser();
    const b = await makeLocalUser();

    const agentA = await agentFor(a.email, a.password);
    const project = await agentA.post("/api/projects").send({ name: "A private" });
    expect(project.status).toBe(201);

    const agentB = await agentFor(b.email, b.password);
    const res = await agentB.get(`/api/projects/${project.body.id}`);
    expect([403, 404]).toContain(res.status);
  });
});
