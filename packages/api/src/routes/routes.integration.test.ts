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

describe("project ACL grantee labels (issue #228)", () => {
  it("resolves USER/TEAM/ORG grants to a human-readable label instead of the raw type", async () => {
    const owner = await makeLocalUser();
    const grantee = await makeLocalUser();
    await prisma.user.update({ where: { id: grantee.user.id }, data: { displayName: "Jane Grantee" } });
    const team = await prisma.team.create({ data: { name: "Platform Team" } });

    const ownerAgent = await agentFor(owner.email, owner.password);
    const project = await ownerAgent.post("/api/projects").send({ name: "Shared" });
    expect(project.status).toBe(201);
    const projectId = project.body.id as string;

    const userGrant = await ownerAgent
      .post(`/api/projects/${projectId}/acl`)
      .send({ granteeType: "USER", granteeUserId: grantee.user.id, accessLevel: "READ" });
    expect(userGrant.status).toBe(201);
    const teamGrant = await ownerAgent
      .post(`/api/projects/${projectId}/acl`)
      .send({ granteeType: "TEAM", granteeTeamId: team.id, accessLevel: "EDIT" });
    expect(teamGrant.status).toBe(201);
    const orgGrant = await ownerAgent
      .post(`/api/projects/${projectId}/acl`)
      .send({ granteeType: "ORG", accessLevel: "READ" });
    expect(orgGrant.status).toBe(201);

    const list = await ownerAgent.get(`/api/projects/${projectId}/acl`);
    expect(list.status).toBe(200);
    const labels = (list.body as { granteeType: string; granteeLabel: string }[]).map((a) => ({
      type: a.granteeType,
      label: a.granteeLabel,
    }));
    expect(labels).toEqual(
      expect.arrayContaining([
        { type: "USER", label: "Jane Grantee" },
        { type: "TEAM", label: "Platform Team" },
        { type: "ORG", label: "Everyone in the organization" },
      ]),
    );
  });

  it("falls back to the grantee's email when no displayName is set", async () => {
    const owner = await makeLocalUser();
    const grantee = await makeLocalUser();

    const ownerAgent = await agentFor(owner.email, owner.password);
    const project = await ownerAgent.post("/api/projects").send({ name: "Shared 2" });
    await ownerAgent
      .post(`/api/projects/${project.body.id}/acl`)
      .send({ granteeType: "USER", granteeUserId: grantee.user.id, accessLevel: "READ" });

    const list = await ownerAgent.get(`/api/projects/${project.body.id}/acl`);
    expect(list.body[0].granteeLabel).toBe(grantee.email);
  });
});

// Regression tests for issue #111: the API's half of run cancellation
// only ever records a request (a durable Redis Set entry + a best-effort
// pub/sub nudge) — it never writes the Run's terminal state itself, so
// these assert exactly that boundary rather than a status change that
// belongs to the Worker (covered end to end in packages/worker's own
// processor.test.ts).
async function makeRunFixture() {
  const { user, email, password } = await makeLocalUser();
  const agent = await agentFor(email, password);
  const project = await prisma.project.create({ data: { name: "Run Test", ownerId: user.id, visibility: "PRIVATE" } });
  const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });
  await prisma.promptVersion.create({
    data: { promptId: prompt.id, versionNumber: 1, content: "hi", createdById: user.id },
  });
  const apiKey = await makeApiKeyForUser(user.id);
  const job = await prisma.job.create({
    data: { projectId: project.id, name: "Job", promptId: prompt.id, agentId: "agent-1", apiKeyId: apiKey.id, createdById: user.id },
  });
  return { agent, job };
}

describe("attachment upload size ceiling (#109)", () => {
  it("answers an over-limit body with 413, not a masked 500", async () => {
    const { user, email, password } = await makeLocalUser();
    const agent = await agentFor(email, password);
    const project = await prisma.project.create({ data: { name: "Attach 413", ownerId: user.id, visibility: "PRIVATE" } });
    const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });
    await prisma.promptVersion.create({
      data: { promptId: prompt.id, versionNumber: 1, content: "hi", createdById: user.id },
    });
    const apiKey = await makeApiKeyForUser(user.id);
    const job = await prisma.job.create({
      data: { projectId: project.id, name: "Job", promptId: prompt.id, agentId: "agent-1", apiKeyId: apiKey.id, createdById: user.id },
    });

    // Larger than the route's 21mb parser limit: body-parser throws
    // entity.too.large BEFORE the handler's own explicit 413 check can
    // run, so this exercises the errorHandler mapping.
    const oversized = "A".repeat(22 * 1024 * 1024);
    const res = await agent
      .post(`/api/jobs/${job.id}/attachments`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ filename: "big.pdf", mimeType: "application/pdf", dataBase64: oversized }));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/);
  });
});

describe("job attachment content (#229)", () => {
  it("streams the raw file inline with an RFC 5987-safe filename, and 404s for a foreign job", async () => {
    const { agent, job } = await makeRunFixture();
    const { user: otherUser } = await makeLocalUser();
    const attachment = await prisma.jobAttachment.create({
      data: {
        jobId: job.id,
        filename: "résumé's (scan)*.png",
        mimeType: "image/png",
        sizeBytes: 3,
        data: Buffer.from([1, 2, 3]),
        createdById: otherUser.id,
      },
    });

    const res = await agent.get(`/api/jobs/${job.id}/attachments/${attachment.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.headers["content-disposition"]).toContain(
      "filename*=UTF-8''r%C3%A9sum%C3%A9%27s%20%28scan%29%2A.png",
    );
    expect(Buffer.from(res.body as Buffer)).toEqual(Buffer.from([1, 2, 3]));

    // A real attachment id under the wrong jobId must not leak content.
    const otherJob = await prisma.job.create({
      data: {
        projectId: job.projectId,
        name: "Other job",
        promptId: job.promptId,
        agentId: "agent-1",
        apiKeyId: job.apiKeyId,
        createdById: job.createdById,
      },
    });
    const crossJob = await agent.get(`/api/jobs/${otherJob.id}/attachments/${attachment.id}/content`);
    expect(crossJob.status).toBe(404);
  });

  it("records a data_access audit event for the view", async () => {
    const { agent, job } = await makeRunFixture();
    const attachment = await prisma.jobAttachment.create({
      data: {
        jobId: job.id,
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        data: Buffer.from("pdf"),
        createdById: job.createdById,
      },
    });

    const res = await agent.get(`/api/jobs/${job.id}/attachments/${attachment.id}/content`);
    expect(res.status).toBe(200);

    const events = await prisma.auditEvent.findMany({ where: { action: "job.attachment_view" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(job.id);
    expect(events[0]!.targetName).toBe("report.pdf");
    expect(events[0]!.category).toBe("data_access");
  });
});

describe("run artifacts (#109)", () => {
  it("hides staged artifacts until the run is terminal and emits an RFC 5987-safe filename", async () => {
    const { agent, job } = await makeRunFixture();
    const run = await prisma.run.create({ data: { jobId: job.id, triggerType: "MANUAL", status: "RUNNING" } });
    const artifact = await prisma.runArtifact.create({
      data: {
        runId: run.id,
        kind: "searchable_pdf",
        filename: "résumé's (final)*.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("pdf"),
      },
    });
    const pendingArtifact = await prisma.runArtifact.create({
      data: {
        runId: run.id,
        kind: "searchable_pdf_pending",
        filename: "replacement.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("pending"),
      },
    });

    const stagedList = await agent.get(`/api/runs/${run.id}/artifacts`);
    expect(stagedList.status).toBe(200);
    expect(stagedList.body).toEqual([]);
    expect((await agent.get(`/api/runs/${run.id}/artifacts/${artifact.id}`)).status).toBe(404);

    await prisma.run.update({ where: { id: run.id }, data: { status: "SUCCESS", completedAt: new Date() } });
    const terminalList = await agent.get(`/api/runs/${run.id}/artifacts`);
    expect(terminalList.body).toHaveLength(1);
    expect(terminalList.body[0].id).toBe(artifact.id);
    expect((await agent.get(`/api/runs/${run.id}/artifacts/${pendingArtifact.id}`)).status).toBe(404);
    const download = await agent.get(`/api/runs/${run.id}/artifacts/${artifact.id}`);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain(
      "filename*=UTF-8''r%C3%A9sum%C3%A9%27s%20%28final%29%2A.pdf",
    );
  });
});

describe("run cancellation (issue #111)", () => {

  it("records a cancellation request for a pending run without writing its status", async () => {
    const { agent, job } = await makeRunFixture();
    const run = await prisma.run.create({ data: { jobId: job.id, triggerType: "MANUAL", status: "PENDING" } });

    const res = await agent.post(`/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(202);

    // Status is untouched — that's the Worker's job, not the API's.
    const unchanged = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.status).toBe("PENDING");

    const redisClient = app.get("redisClient") as { sismember(key: string, member: string): Promise<number> };
    const requested = await redisClient.sismember("nexus:run-cancel-requested", run.id);
    expect(requested).toBe(1);

    const events = await prisma.auditEvent.findMany({ where: { targetId: run.id, action: "run.cancel_request" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe("SUCCESS");
  });

  it("rejects cancelling a run that's already in a terminal state", async () => {
    const { agent, job } = await makeRunFixture();
    const run = await prisma.run.create({ data: { jobId: job.id, triggerType: "MANUAL", status: "SUCCESS" } });

    const res = await agent.post(`/api/runs/${run.id}/cancel`);
    expect(res.status).toBe(409);

    const redisClient = app.get("redisClient") as { sismember(key: string, member: string): Promise<number> };
    const requested = await redisClient.sismember("nexus:run-cancel-requested", run.id);
    expect(requested).toBe(0);
  });

  it("does not let a user cancel a run in another user's private project", async () => {
    const { job } = await makeRunFixture();
    const run = await prisma.run.create({ data: { jobId: job.id, triggerType: "MANUAL", status: "PENDING" } });

    const outsider = await makeLocalUser();
    const outsiderAgent = await agentFor(outsider.email, outsider.password);
    const res = await outsiderAgent.post(`/api/runs/${run.id}/cancel`);
    expect([403, 404]).toContain(res.status);
  });
});
