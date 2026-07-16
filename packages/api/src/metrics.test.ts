import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Express } from "express";
import { prisma } from "./db.js";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import type { AppConfig } from "./config.js";

// Regression test for #108: a router mounted with a param in its own
// mount path (e.g. "/api/projects/:projectId/jobs", mergeParams: true)
// resolves req.baseUrl to the real id, not the pattern — so the naive
// `${req.baseUrl}${req.route.path}` route label fanned out into one
// metrics series per project/job id instead of staying bounded.

const ENCRYPTION_KEY = "ci-test-encryption-key-32-characters!!";
const config = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://ci:ci@localhost:5432/ci?schema=public",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  SESSION_SECRET: "metrics-test-session-secret-0000000000",
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
  const runsQueue = app.get("runsQueue") as { close: () => Promise<void> } | undefined;
  const redisClient = app.get("redisClient") as { disconnect: () => void } | undefined;
  try {
    if (runsQueue) await runsQueue.close();
  } finally {
    redisClient?.disconnect();
  }
  await prisma.$disconnect();
});

describe("HTTP route metrics label (§108)", () => {
  it("substitutes mount-path params so nested routes stay bounded", async () => {
    const password = "correct-horse-battery-staple";
    const user = await prisma.user.create({
      data: {
        email: "metrics-user@example.test",
        authSource: "LOCAL",
        role: "EDITOR",
        active: true,
        passwordHash: bcrypt.hashSync(password, 12),
      },
    });
    const project = await prisma.project.create({
      data: { name: "Metrics Test Project", ownerId: user.id, visibility: "PRIVATE" },
    });

    const agent = request.agent(app);
    const loginRes = await agent.post("/auth/local-login").send({ email: user.email, password });
    expect(loginRes.status).toBe(200);

    // Hits the four routers mounted with a param in their own mount
    // path — the exact shapes the issue reported fanning out.
    await agent.get(`/api/projects/${project.id}/jobs`).expect(200);
    await agent.get(`/api/projects/${project.id}/prompts`).expect(200);
    // A route matched entirely inside a single router (param on the
    // route, not the mount) — this one was already correct; kept as a
    // control so the fix can't accidentally break it.
    await agent.get(`/api/projects/${project.id}`).expect(200);
    // No route matches at all (404) — req.path is raw and
    // attacker-controlled, so this must not leak into the label either.
    await agent.get(`/api/projects/${project.id}/definitely-not-a-real-sub-route`);

    const metricsRes = await agent.get("/metrics").expect(200);
    const body: string = metricsRes.text;

    expect(body).toContain('route="/api/projects/:projectId/jobs/"');
    expect(body).toContain('route="/api/projects/:projectId/prompts/"');
    expect(body).toContain('route="/api/projects/:id"');
    expect(body).toContain('route="unmatched"');

    expect(body).not.toContain(project.id);
  });
});
