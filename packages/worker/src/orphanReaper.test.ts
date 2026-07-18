import type { Queue } from "bullmq";
import { encryptSecret } from "@nexus-scheduler/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { prisma } from "./db.js";
import type { Logger } from "./logger.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { createRunsQueue, type RunJobData } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";
import { runOrphanReaperSweep } from "./orphanReaper.js";

// Regression coverage for issue #123: a run whose worker crashed or
// restarted mid-processing has nothing else watching it — BullMQ's own
// stalled-job recovery didn't reliably reclaim these in practice, so the
// reaper is a direct DB-side sweep instead. Real Postgres + real Redis/
// BullMQ, same "no mocking the system under test" posture as the rest of
// this suite.
interface RawTestClient {
  zadd(key: string, score: number, member: string): Promise<number>;
  zcard(key: string): Promise<number>;
}

const REDIS_URL = process.env.WORKER_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const ENCRYPTION_KEY = "orphan-reaper-test-encryption-key-32ch!";
const connection = parseRedisConnectionOptions(REDIS_URL);

const config = {
  API_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY,
  LIBRECHAT_BASE_URL: "http://placeholder.invalid",
  PDF_SERVICE_URL: "http://placeholder.invalid",
  ORPHAN_REAPER_PENDING_GRACE_MS: 60_000,
} as WorkerConfig;

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

async function resetDb() {
  await prisma.auditEvent.deleteMany({});
  await prisma.jobWebhookDestination.deleteMany({});
  await prisma.webhookDestination.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.promptVersion.deleteMany({});
  await prisma.prompt.deleteMany({});
  await prisma.apiKey.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.user.deleteMany({});
}

let userCounter = 0;
async function makeJob(timeoutSeconds = 30) {
  userCounter += 1;
  const user = await prisma.user.create({
    data: { email: `orphan-owner-${userCounter}@example.test`, authSource: "LOCAL", role: "EDITOR" },
  });
  const project = await prisma.project.create({ data: { name: "P", ownerId: user.id, visibility: "PRIVATE" } });
  const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });
  await prisma.promptVersion.create({
    data: { promptId: prompt.id, versionNumber: 1, content: "hello", createdById: user.id },
  });
  const apiKey = await prisma.apiKey.create({
    data: { ownerType: "USER", ownerUserId: user.id, encryptedKey: encryptSecret("k", ENCRYPTION_KEY) },
  });
  const job = await prisma.job.create({
    data: {
      projectId: project.id,
      name: "Job",
      promptId: prompt.id,
      agentId: "agent-1",
      apiKeyId: apiKey.id,
      createdById: user.id,
      timeoutSeconds,
    },
  });
  return { user, job };
}

describe("runOrphanReaperSweep (issue #123)", () => {
  let queue: Queue<RunJobData>;
  let metrics: Metrics;

  beforeEach(async () => {
    await resetDb();
    queue = createRunsQueue(connection);
    await queue.obliterate({ force: true }).catch(() => {});
    metrics = createMetrics(queue);
  });

  afterEach(async () => {
    await queue.close();
  });

  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("reaps a RUNNING run left stale past its timeout + grace by a crashed worker", async () => {
    const { job, user } = await makeJob(30); // staleAfterMs = 30_000 + 300_000
    const run = await prisma.run.create({
      data: {
        jobId: job.id,
        triggerType: "MANUAL",
        status: "RUNNING",
        startedAt: new Date(Date.now() - (330_000 + 5_000)),
      },
    });

    const raw = (await queue.client) as unknown as RawTestClient;
    const slotKey = `nexus:concurrency:user:${user.id}`;
    await raw.zadd(slotKey, Date.now() + 60_000, run.id);

    await runOrphanReaperSweep(queue, config, logger, metrics);

    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.errorMessage).toMatch(/orphan reaper/i);
    expect(updated.completedAt).not.toBeNull();

    expect(await raw.zcard(slotKey)).toBe(0);

    const events = await prisma.auditEvent.findMany({ where: { correlationId: run.id, action: "run.complete" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe("FAILURE");
  });

  it("leaves a RUNNING run alone while it's still within its timeout + grace", async () => {
    const { job } = await makeJob(30);
    const run = await prisma.run.create({
      data: { jobId: job.id, triggerType: "MANUAL", status: "RUNNING", startedAt: new Date(Date.now() - 1000) },
    });

    await runOrphanReaperSweep(queue, config, logger, metrics);

    const unchanged = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.status).toBe("RUNNING");
  });

  it("reaps a PENDING run past the grace period with no corresponding BullMQ job", async () => {
    const { job } = await makeJob();
    const run = await prisma.run.create({
      data: {
        jobId: job.id,
        triggerType: "MANUAL",
        status: "PENDING",
        createdAt: new Date(Date.now() - (config.ORPHAN_REAPER_PENDING_GRACE_MS + 5_000)),
      },
    });

    await runOrphanReaperSweep(queue, config, logger, metrics);

    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.errorMessage).toMatch(/orphan reaper/i);
  });

  it("leaves a PENDING run alone within the grace period, even with no BullMQ job yet", async () => {
    const { job } = await makeJob();
    const run = await prisma.run.create({
      data: { jobId: job.id, triggerType: "MANUAL", status: "PENDING" },
    });

    await runOrphanReaperSweep(queue, config, logger, metrics);

    const unchanged = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.status).toBe("PENDING");
  });

  it("leaves a PENDING run alone past the grace period if its BullMQ job still exists", async () => {
    const { job } = await makeJob();
    const run = await prisma.run.create({
      data: {
        jobId: job.id,
        triggerType: "MANUAL",
        status: "PENDING",
        createdAt: new Date(Date.now() - (config.ORPHAN_REAPER_PENDING_GRACE_MS + 5_000)),
      },
    });
    await queue.add("run", { runId: run.id } satisfies RunJobData, { jobId: run.id, attempts: 1 });

    await runOrphanReaperSweep(queue, config, logger, metrics);

    const unchanged = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.status).toBe("PENDING");
  });
});
