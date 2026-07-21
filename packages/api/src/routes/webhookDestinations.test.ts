import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { prisma } from "../db.js";
import { createApp } from "../app.js";
import { createLogger } from "../logger.js";
import type { AppConfig } from "../config.js";

// Route-level tests for issue #224 (optional custom JSON payload +
// optional HMAC signing on WebhookDestination): the write-time template
// validation and the create/update effective-state cross-field check.
// Real app, real Postgres, no mocking — same posture as the rest of
// this suite.
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.API_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  SESSION_SECRET: "webhook-destinations-test-session-secret-32ch",
  APP_BASE_URL: undefined,
  OIDC_ISSUER_URL: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_REDIRECT_URI: undefined,
  LOCAL_AUTH_ENABLED: true,
  BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
  API_KEY_ENCRYPTION_KEY: "webhook-destinations-test-encryption-key-32c",
  LIBRECHAT_BASE_URL: undefined,
  PDF_SERVICE_URL: "http://placeholder.invalid",
  PDF_SERVICE_SHARED_SECRET: undefined,
  LOG_LEVEL: "error",
};

const PASSWORD = "correct horse battery staple";
const BCRYPT_ROUNDS = 4; // fast — test fixture, not a real credential store

async function resetDb() {
  await prisma.auditEvent.deleteMany({});
  await prisma.jobWebhookDestination.deleteMany({});
  await prisma.webhookDestination.deleteMany({});
  await prisma.user.deleteMany({});
}

async function makeAdmin() {
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
  return prisma.user.create({
    data: {
      email: `webhook-admin-${Date.now()}-${Math.random()}@example.test`,
      authSource: "LOCAL",
      role: "ADMIN",
      active: true,
      passwordHash,
    },
  });
}

async function loginAs(app: Express, user: { email: string }) {
  const agent = request.agent(app);
  const res = await agent.post("/auth/local-login").send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("webhook destinations — custom payload & optional signing (issue #224)", () => {
  let app: Express;
  let redisClient: Redis;
  let runsQueue: Queue;

  beforeAll(() => {
    app = createApp(config, createLogger(config));
    redisClient = app.get("redisClient");
    runsQueue = app.get("runsQueue");
  });

  beforeEach(resetDb);

  afterAll(async () => {
    await resetDb();
    try {
      await runsQueue?.close();
    } finally {
      redisClient?.disconnect();
    }
    await prisma.$disconnect();
  });

  it("rejects a payload template that does not render to valid JSON", async () => {
    const admin = await makeAdmin();
    const agent = await loginAs(app, admin);

    const res = await agent.post("/api/webhook-destinations").send({
      name: "Bad template",
      url: "http://receiver.internal/hook",
      customPayloadEnabled: true,
      payloadTemplate: "not json at all",
    });
    expect(res.status).toBe(400);
  });

  it("rejects enabling a custom payload with no template", async () => {
    const admin = await makeAdmin();
    const agent = await loginAs(app, admin);

    const res = await agent.post("/api/webhook-destinations").send({
      name: "No template",
      url: "http://receiver.internal/hook",
      customPayloadEnabled: true,
    });
    expect(res.status).toBe(400);
    expect(await prisma.webhookDestination.count()).toBe(0);
  });

  it("creates a destination with a valid custom payload template and signPayload off", async () => {
    const admin = await makeAdmin();
    const agent = await loginAs(app, admin);

    const res = await agent.post("/api/webhook-destinations").send({
      name: "Custom",
      url: "http://receiver.internal/hook",
      customPayloadEnabled: true,
      payloadTemplate: '{"status": "{{status}}"}',
      signPayload: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.customPayloadEnabled).toBe(true);
    expect(res.body.payloadTemplate).toBe('{"status": "{{status}}"}');
    expect(res.body.signPayload).toBe(false);
  });

  it("defaults signPayload to true when omitted, unchanged from pre-#224 behavior", async () => {
    const admin = await makeAdmin();
    const agent = await loginAs(app, admin);

    const res = await agent.post("/api/webhook-destinations").send({
      name: "Default",
      url: "http://receiver.internal/hook",
    });
    expect(res.status).toBe(201);
    expect(res.body.signPayload).toBe(true);
    expect(res.body.customPayloadEnabled).toBe(false);
  });

  it("allows enabling customPayloadEnabled via PATCH using an already-saved template", async () => {
    const admin = await makeAdmin();
    const agent = await loginAs(app, admin);

    const created = await agent.post("/api/webhook-destinations").send({
      name: "Toggle me",
      url: "http://receiver.internal/hook",
      customPayloadEnabled: true,
      payloadTemplate: '{"status": "{{status}}"}',
    });
    // Turn it off, keeping the template on file.
    await agent.patch(`/api/webhook-destinations/${created.body.id}`).send({ customPayloadEnabled: false });

    // Re-enable with no payloadTemplate in THIS request — must succeed
    // because the effective state check merges against what's saved.
    const reEnabled = await agent
      .patch(`/api/webhook-destinations/${created.body.id}`)
      .send({ customPayloadEnabled: true });
    expect(reEnabled.status).toBe(200);
    expect(reEnabled.body.payloadTemplate).toBe('{"status": "{{status}}"}');
  });

  it("rejects enabling customPayloadEnabled via PATCH when no template exists at all", async () => {
    const admin = await makeAdmin();
    const agent = await loginAs(app, admin);

    const created = await agent.post("/api/webhook-destinations").send({
      name: "Never had a template",
      url: "http://receiver.internal/hook",
    });

    const res = await agent
      .patch(`/api/webhook-destinations/${created.body.id}`)
      .send({ customPayloadEnabled: true });
    expect(res.status).toBe(400);

    const stillDisabled = await prisma.webhookDestination.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stillDisabled.customPayloadEnabled).toBe(false);
  });
});
