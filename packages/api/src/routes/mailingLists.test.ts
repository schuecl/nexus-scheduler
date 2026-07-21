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

// Route-level integration tests for issue #219 (saved mailing lists):
// ownership boundaries on the CRUD routes, and the Job-attachment path
// through PUT /:id/notifications + GET /:id/mailing-lists. Same "real
// app, real Postgres, no mocking" posture as the rest of this suite.
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.API_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  SESSION_SECRET: "mailing-lists-test-session-secret-32-chars!!",
  APP_BASE_URL: undefined,
  OIDC_ISSUER_URL: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_REDIRECT_URI: undefined,
  LOCAL_AUTH_ENABLED: true,
  BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
  API_KEY_ENCRYPTION_KEY: "mailing-lists-test-encryption-key-32ch!",
  LIBRECHAT_BASE_URL: undefined,
  PDF_SERVICE_URL: "http://placeholder.invalid",
  PDF_SERVICE_SHARED_SECRET: undefined,
  LOG_LEVEL: "error",
};

const PASSWORD = "correct horse battery staple";
const BCRYPT_ROUNDS = 4; // fast — test fixture, not a real credential store

async function resetDb() {
  await prisma.auditEvent.deleteMany({});
  await prisma.jobMailingList.deleteMany({});
  await prisma.mailingList.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.promptVersion.deleteMany({});
  await prisma.prompt.deleteMany({});
  await prisma.projectAcl.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.apiKey.deleteMany({});
  await prisma.user.deleteMany({});
}

let userCounter = 0;
async function makeUser(role: "ADMIN" | "EDITOR" | "VIEW" = "EDITOR") {
  userCounter += 1;
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
  return prisma.user.create({
    data: {
      email: `mailing-list-user-${userCounter}@example.test`,
      authSource: "LOCAL",
      role,
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

// End-to-end job creation through the same HTTP surface a real client
// uses, owned by `user`.
async function makeJobForUser(agent: request.Agent, ownerId: string) {
  await prisma.apiKey.create({
    data: { ownerType: "USER", ownerUserId: ownerId, label: "key", encryptedKey: "placeholder-ciphertext" },
  });
  const key = await prisma.apiKey.findFirstOrThrow({ where: { ownerUserId: ownerId } });
  const project = await agent.post("/api/projects").send({ name: "P" });
  const prompt = await agent.post(`/api/projects/${project.body.id}/prompts`).send({ name: "Prompt", content: "hi" });
  const job = await agent.post(`/api/projects/${project.body.id}/jobs`).send({
    name: "Job",
    promptId: prompt.body.id,
    agentId: "agent-1",
    apiKeyId: key.id,
  });
  expect(job.status).toBe(201);
  return job.body as { id: string };
}

describe("mailing lists (issue #219)", () => {
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

  describe("CRUD ownership", () => {
    it("creates a list owned by the caller and returns it from GET", async () => {
      const user = await makeUser();
      const agent = await loginAs(app, user);

      const create = await agent
        .post("/api/mailing-lists")
        .send({ name: "Leadership", emails: ["a@example.test", "b@example.test"] });
      expect(create.status).toBe(201);
      expect(create.body.name).toBe("Leadership");
      expect(create.body.emails).toEqual(["a@example.test", "b@example.test"]);

      const list = await agent.get("/api/mailing-lists");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].id).toBe(create.body.id);
    });

    it("rejects creating a list with no emails", async () => {
      const user = await makeUser();
      const agent = await loginAs(app, user);
      const res = await agent.post("/api/mailing-lists").send({ name: "Empty", emails: [] });
      expect(res.status).toBe(400);
    });

    it("rejects creating a list with a malformed email address", async () => {
      const user = await makeUser();
      const agent = await loginAs(app, user);
      const res = await agent.post("/api/mailing-lists").send({ name: "Bad", emails: ["not-an-email"] });
      expect(res.status).toBe(400);
    });

    it("never shows one user's list to another user's GET", async () => {
      const a = await makeUser();
      const b = await makeUser();
      const agentA = await loginAs(app, a);
      const agentB = await loginAs(app, b);

      await agentA.post("/api/mailing-lists").send({ name: "A's list", emails: ["a@example.test"] });

      const listB = await agentB.get("/api/mailing-lists");
      expect(listB.status).toBe(200);
      expect(listB.body).toEqual([]);
    });

    it("rejects a non-owner editing or deleting another user's list with 403", async () => {
      const a = await makeUser();
      const b = await makeUser();
      const agentA = await loginAs(app, a);
      const agentB = await loginAs(app, b);

      const created = await agentA.post("/api/mailing-lists").send({ name: "A's list", emails: ["a@example.test"] });

      const patch = await agentB.patch(`/api/mailing-lists/${created.body.id}`).send({ name: "Hijacked" });
      expect(patch.status).toBe(403);

      const del = await agentB.delete(`/api/mailing-lists/${created.body.id}`);
      expect(del.status).toBe(403);

      // And neither actually happened.
      const stillA = await prisma.mailingList.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(stillA.name).toBe("A's list");
    });

    it("lets an admin edit or delete a list they don't own", async () => {
      const owner = await makeUser();
      const admin = await makeUser("ADMIN");
      const ownerAgent = await loginAs(app, owner);
      const adminAgent = await loginAs(app, admin);

      const created = await ownerAgent
        .post("/api/mailing-lists")
        .send({ name: "Owner's list", emails: ["owner@example.test"] });

      const patch = await adminAgent.patch(`/api/mailing-lists/${created.body.id}`).send({ name: "Renamed by admin" });
      expect(patch.status).toBe(200);
      expect(patch.body.name).toBe("Renamed by admin");

      const del = await adminAgent.delete(`/api/mailing-lists/${created.body.id}`);
      expect(del.status).toBe(204);
      expect(await prisma.mailingList.findUnique({ where: { id: created.body.id } })).toBeNull();
    });
  });

  describe("attaching to a Job's notifications", () => {
    it("attaches the caller's own list and returns it from GET /:id/mailing-lists", async () => {
      const user = await makeUser();
      const agent = await loginAs(app, user);
      const job = await makeJobForUser(agent, user.id);
      const list = await agent
        .post("/api/mailing-lists")
        .send({ name: "Team", emails: ["team@example.test"] });

      const put = await agent.put(`/api/jobs/${job.id}/notifications`).send({
        notifyOnSuccess: true,
        notifyOnFailure: false,
        attachPdfToEmail: false,
        ccRecipients: [],
        mailingListIds: [list.body.id],
      });
      expect(put.status).toBe(200);

      const attached = await agent.get(`/api/jobs/${job.id}/mailing-lists`);
      expect(attached.status).toBe(200);
      expect(attached.body).toEqual([{ id: list.body.id, name: "Team" }]);
    });

    it("rejects attaching another user's mailing list with 400", async () => {
      const owner = await makeUser();
      const attacker = await makeUser();
      const ownerAgent = await loginAs(app, owner);
      const attackerAgent = await loginAs(app, attacker);

      const foreignList = await ownerAgent
        .post("/api/mailing-lists")
        .send({ name: "Owner's list", emails: ["owner@example.test"] });
      const job = await makeJobForUser(attackerAgent, attacker.id);

      const put = await attackerAgent.put(`/api/jobs/${job.id}/notifications`).send({
        notifyOnSuccess: true,
        notifyOnFailure: false,
        attachPdfToEmail: false,
        ccRecipients: [],
        mailingListIds: [foreignList.body.id],
      });
      expect(put.status).toBe(400);

      // And nothing was attached.
      const attached = await attackerAgent.get(`/api/jobs/${job.id}/mailing-lists`);
      expect(attached.body).toEqual([]);
    });

    it("replaces the full attached set on a second PUT, same as webhooks", async () => {
      const user = await makeUser();
      const agent = await loginAs(app, user);
      const job = await makeJobForUser(agent, user.id);
      const listA = await agent.post("/api/mailing-lists").send({ name: "A", emails: ["a@example.test"] });
      const listB = await agent.post("/api/mailing-lists").send({ name: "B", emails: ["b@example.test"] });

      await agent.put(`/api/jobs/${job.id}/notifications`).send({
        notifyOnSuccess: true,
        notifyOnFailure: false,
        attachPdfToEmail: false,
        ccRecipients: [],
        mailingListIds: [listA.body.id, listB.body.id],
      });
      const secondPut = await agent.put(`/api/jobs/${job.id}/notifications`).send({
        notifyOnSuccess: true,
        notifyOnFailure: false,
        attachPdfToEmail: false,
        ccRecipients: [],
        mailingListIds: [listB.body.id],
      });
      expect(secondPut.status).toBe(200);

      const attached = await agent.get(`/api/jobs/${job.id}/mailing-lists`);
      expect(attached.body).toEqual([{ id: listB.body.id, name: "B" }]);
    });
  });
});
