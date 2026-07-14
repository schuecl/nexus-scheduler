import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import bcrypt from "bcryptjs";
import { encryptSecret } from "@nexus-scheduler/shared";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { AppConfig } from "./config.js";
import { prisma } from "./db.js";

// Route-level authorization/tenancy integration tests (§45) — the vitest
// suite elsewhere covers unit logic (access.test.ts, crypto, scheduling,
// syslog); this boots the real Express app (no mocked Prisma/session
// store) via supertest and drives it through HTTP, the same "real infra
// only" discipline as every other test in this repo.
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.API_TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  SESSION_SECRET: "authz-test-session-secret-at-least-32-chars",
  APP_BASE_URL: undefined,
  OIDC_ISSUER_URL: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_REDIRECT_URI: undefined,
  LOCAL_AUTH_ENABLED: true,
  BOOTSTRAP_ADMIN_EMAIL: "admin@nexus-scheduler.local",
  BOOTSTRAP_ADMIN_PASSWORD: undefined,
  API_KEY_ENCRYPTION_KEY: "authz-test-encryption-key-32-chars!!!!!",
  LIBRECHAT_BASE_URL: undefined,
  PDF_SERVICE_URL: "http://placeholder.invalid",
  PDF_SERVICE_SHARED_SECRET: undefined,
  LOG_LEVEL: "error",
};

const PASSWORD = "correct horse battery staple";
const BCRYPT_ROUNDS = 4; // fast — test fixture, not a real credential store

async function resetDb() {
  await prisma.auditEvent.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.jobWebhookDestination.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.promptVersion.deleteMany({});
  await prisma.prompt.deleteMany({});
  await prisma.projectAcl.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.apiKey.deleteMany({});
  await prisma.teamMembership.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.user.deleteMany({});
}

let userCounter = 0;
async function makeUser(role: "ADMIN" | "EDITOR" | "VIEW" = "EDITOR") {
  userCounter += 1;
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
  return prisma.user.create({
    data: {
      email: `authz-user-${userCounter}@example.test`,
      authSource: "LOCAL",
      role,
      active: true,
      passwordHash,
    },
  });
}

// Logs in as `user` and returns a supertest agent that carries the
// resulting session cookie on every subsequent request.
async function loginAs(app: Express, user: { email: string }) {
  const agent = request.agent(app);
  const res = await agent.post("/auth/local-login").send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("route-level authorization (§45)", () => {
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
    await runsQueue.close();
    await redisClient.quit();
    await prisma.$disconnect();
  });

  describe("IDOR: API key ownership on Job create/update", () => {
    it("rejects a Job referencing another user's personal API key", async () => {
      const owner = await makeUser();
      const ownerKey = await prisma.apiKey.create({
        data: { ownerType: "USER", ownerUserId: owner.id, encryptedKey: encryptSecret("k", config.API_KEY_ENCRYPTION_KEY) },
      });

      const attacker = await makeUser();
      const project = await prisma.project.create({ data: { name: "P", ownerId: attacker.id, visibility: "PRIVATE" } });
      const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });

      const agent = await loginAs(app, attacker);
      const res = await agent.post(`/api/projects/${project.id}/jobs`).send({
        name: "Job",
        promptId: prompt.id,
        agentId: "agent-1",
        apiKeyId: ownerKey.id,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/apiKeyId/);
    });

    it("rejects a Job referencing a Team API key for a Team the requester doesn't belong to", async () => {
      const teamOwnerUser = await makeUser();
      const team = await prisma.team.create({ data: { name: "T", createdById: teamOwnerUser.id } });
      const teamKey = await prisma.apiKey.create({
        data: { ownerType: "TEAM", ownerTeamId: team.id, encryptedKey: encryptSecret("k", config.API_KEY_ENCRYPTION_KEY) },
      });

      const attacker = await makeUser();
      const project = await prisma.project.create({ data: { name: "P", ownerId: attacker.id, visibility: "PRIVATE" } });
      const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });

      const agent = await loginAs(app, attacker);
      const res = await agent.post(`/api/projects/${project.id}/jobs`).send({
        name: "Job",
        promptId: prompt.id,
        agentId: "agent-1",
        apiKeyId: teamKey.id,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/apiKeyId/);
    });

    it("allows a Job referencing the requester's own personal API key", async () => {
      const user = await makeUser();
      const key = await prisma.apiKey.create({
        data: { ownerType: "USER", ownerUserId: user.id, encryptedKey: encryptSecret("k", config.API_KEY_ENCRYPTION_KEY) },
      });
      const project = await prisma.project.create({ data: { name: "P", ownerId: user.id, visibility: "PRIVATE" } });
      const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });

      const agent = await loginAs(app, user);
      const res = await agent.post(`/api/projects/${project.id}/jobs`).send({
        name: "Job",
        promptId: prompt.id,
        agentId: "agent-1",
        apiKeyId: key.id,
      });

      expect(res.status).toBe(201);
    });
  });

  describe("cross-project prompt-version disclosure via Schedule PATCH", () => {
    it("rejects pinning a Schedule to a PromptVersion from a different project's prompt", async () => {
      const victim = await makeUser();
      const victimProject = await prisma.project.create({ data: { name: "Victim P", ownerId: victim.id, visibility: "PRIVATE" } });
      const victimPrompt = await prisma.prompt.create({ data: { projectId: victimProject.id, name: "Secret Prompt" } });
      const victimVersion = await prisma.promptVersion.create({
        data: { promptId: victimPrompt.id, versionNumber: 1, content: "top secret content", createdById: victim.id },
      });

      const attacker = await makeUser();
      const attackerProject = await prisma.project.create({ data: { name: "Attacker P", ownerId: attacker.id, visibility: "PRIVATE" } });
      const attackerPrompt = await prisma.prompt.create({ data: { projectId: attackerProject.id, name: "Own Prompt" } });
      await prisma.promptVersion.create({
        data: { promptId: attackerPrompt.id, versionNumber: 1, content: "own content", createdById: attacker.id },
      });
      const attackerKey = await prisma.apiKey.create({
        data: { ownerType: "USER", ownerUserId: attacker.id, encryptedKey: encryptSecret("k", config.API_KEY_ENCRYPTION_KEY) },
      });
      const attackerJob = await prisma.job.create({
        data: {
          projectId: attackerProject.id,
          name: "Job",
          promptId: attackerPrompt.id,
          agentId: "agent-1",
          apiKeyId: attackerKey.id,
          createdById: attacker.id,
        },
      });
      const schedule = await prisma.schedule.create({
        data: {
          jobId: attackerJob.id,
          type: "ONE_TIME",
          runAt: new Date(Date.now() + 3600_000),
          timezone: "UTC",
          approvalStatus: "APPROVED",
          createdById: attacker.id,
        },
      });

      const agent = await loginAs(app, attacker);
      const res = await agent
        .patch(`/api/schedules/${schedule.id}`)
        .send({ versionPinMode: "PINNED", pinnedPromptVersionId: victimVersion.id });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pinnedPromptVersionId/);
    });

    it("allows pinning a Schedule to a PromptVersion belonging to the Job's own prompt", async () => {
      const user = await makeUser();
      const project = await prisma.project.create({ data: { name: "P", ownerId: user.id, visibility: "PRIVATE" } });
      const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });
      const version = await prisma.promptVersion.create({
        data: { promptId: prompt.id, versionNumber: 1, content: "content", createdById: user.id },
      });
      const key = await prisma.apiKey.create({
        data: { ownerType: "USER", ownerUserId: user.id, encryptedKey: encryptSecret("k", config.API_KEY_ENCRYPTION_KEY) },
      });
      const job = await prisma.job.create({
        data: { projectId: project.id, name: "Job", promptId: prompt.id, agentId: "agent-1", apiKeyId: key.id, createdById: user.id },
      });
      const schedule = await prisma.schedule.create({
        data: {
          jobId: job.id,
          type: "ONE_TIME",
          runAt: new Date(Date.now() + 3600_000),
          timezone: "UTC",
          approvalStatus: "APPROVED",
          createdById: user.id,
        },
      });

      const agent = await loginAs(app, user);
      const res = await agent
        .patch(`/api/schedules/${schedule.id}`)
        .send({ versionPinMode: "PINNED", pinnedPromptVersionId: version.id });

      expect(res.status).toBe(200);
      expect(res.body.pinnedPromptVersionId).toBe(version.id);
    });
  });

  describe("Project ACL / ownership gating", () => {
    it("404s a non-owner, non-shared-to user trying to read or edit a private Project", async () => {
      const owner = await makeUser();
      const project = await prisma.project.create({ data: { name: "Private", ownerId: owner.id, visibility: "PRIVATE" } });

      const outsider = await makeUser();
      const agent = await loginAs(app, outsider);

      const getRes = await agent.get(`/api/projects/${project.id}`);
      expect(getRes.status).toBe(404);

      const patchRes = await agent.patch(`/api/projects/${project.id}`).send({ name: "Renamed" });
      expect(patchRes.status).toBe(404);
    });

    it("grants READ but not EDIT once a READ ACL is added, and EDIT once upgraded", async () => {
      const owner = await makeUser();
      const project = await prisma.project.create({ data: { name: "Shared", ownerId: owner.id, visibility: "PRIVATE" } });
      const grantee = await makeUser();

      await prisma.projectAcl.create({
        data: { projectId: project.id, granteeType: "USER", granteeUserId: grantee.id, accessLevel: "READ" },
      });

      const agent = await loginAs(app, grantee);
      const getRes = await agent.get(`/api/projects/${project.id}`);
      expect(getRes.status).toBe(200);

      const patchRes = await agent.patch(`/api/projects/${project.id}`).send({ name: "Renamed by grantee" });
      expect(patchRes.status).toBe(403);

      await prisma.projectAcl.updateMany({ where: { projectId: project.id, granteeUserId: grantee.id }, data: { accessLevel: "EDIT" } });

      const patchRes2 = await agent.patch(`/api/projects/${project.id}`).send({ name: "Renamed by grantee" });
      expect(patchRes2.status).toBe(200);
    });

    it("blocks Job/Prompt creation in a Project the requester only has READ on", async () => {
      const owner = await makeUser();
      const project = await prisma.project.create({ data: { name: "Shared", ownerId: owner.id, visibility: "PRIVATE" } });
      const reader = await makeUser();
      await prisma.projectAcl.create({
        data: { projectId: project.id, granteeType: "USER", granteeUserId: reader.id, accessLevel: "READ" },
      });

      const agent = await loginAs(app, reader);
      const res = await agent.post(`/api/projects/${project.id}/prompts`).send({
        name: "New Prompt",
        content: "hello",
        variables: [],
      });

      expect(res.status).toBe(403);
    });
  });

  describe("admin-only routes", () => {
    it("rejects a non-admin from the user-management route", async () => {
      const nonAdmin = await makeUser("EDITOR");
      const target = await makeUser("VIEW");
      const agent = await loginAs(app, nonAdmin);

      const res = await agent.patch(`/api/users/${target.id}`).send({ role: "ADMIN" });
      expect(res.status).toBe(403);
    });

    it("allows an admin to change another user's role", async () => {
      const admin = await makeUser("ADMIN");
      const target = await makeUser("VIEW");
      const agent = await loginAs(app, admin);

      const res = await agent.patch(`/api/users/${target.id}`).send({ role: "EDITOR" });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("EDITOR");
    });
  });
});
