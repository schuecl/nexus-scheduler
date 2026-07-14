import type { Queue } from "bullmq";
import { encryptSecret } from "@nexus-scheduler/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { prisma } from "./db.js";
import type { Logger } from "./logger.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { createRunsQueue, type RunJobData } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";
import { runSchedulerTick } from "./scheduler.js";

// Regression test for the duplicate-scheduled-run race (§51): two
// overlapping scheduler ticks (or two worker replicas polling at the
// same moment) must never both create a Run for the same Schedule fire.
// Real Postgres + real Redis/BullMQ, same "no mocking the system under
// test" posture as processor.test.ts — the race protection lives in a
// real conditional UPDATE, which a mocked Prisma client can't exercise.
const REDIS_URL = process.env.WORKER_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const ENCRYPTION_KEY = "scheduler-test-encryption-key-32-chars!";
const connection = parseRedisConnectionOptions(REDIS_URL);

const config = {
  SCHEDULER_TICK_MS: 15_000,
} as WorkerConfig;

const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

async function resetDb() {
  await prisma.auditEvent.deleteMany({});
  await prisma.run.deleteMany({});
  await prisma.schedule.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.promptVersion.deleteMany({});
  await prisma.prompt.deleteMany({});
  await prisma.apiKey.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.user.deleteMany({});
}

let userCounter = 0;
async function makeDueSchedule(overdueMs = 1000) {
  userCounter += 1;
  const user = await prisma.user.create({
    data: { email: `sched-owner-${userCounter}@example.test`, authSource: "LOCAL", role: "EDITOR" },
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
    data: { projectId: project.id, name: "Job", promptId: prompt.id, agentId: "agent-1", apiKeyId: apiKey.id, createdById: user.id },
  });
  const schedule = await prisma.schedule.create({
    data: {
      jobId: job.id,
      type: "ONE_TIME",
      runAt: new Date(Date.now() - overdueMs),
      // Well within missedFireToleranceMs (2x SCHEDULER_TICK_MS = 30s
      // above) so both racing ticks take the "fire it" path, not
      // "skip as missed" — that's the path whose race this test targets.
      nextFireAt: new Date(Date.now() - overdueMs),
      timezone: "UTC",
      approvalStatus: "APPROVED",
      paused: false,
      createdById: user.id,
    },
  });
  return { user, job, schedule };
}

describe("runSchedulerTick concurrency (§51)", () => {
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

  it("creates exactly one Run when two ticks race on the same due schedule", async () => {
    const { schedule } = await makeDueSchedule();

    // Two "ticks" firing concurrently — simulates either the same
    // process's guard failing to serialize them, or two worker replicas
    // polling at the same instant. The atomic conditional UPDATE inside
    // runSchedulerTick (not the reentrancy guard in startSchedulerLoop,
    // which is deliberately bypassed here) is what must prevent both
    // from creating a Run.
    await Promise.all([
      runSchedulerTick(queue, config, logger, metrics),
      runSchedulerTick(queue, config, logger, metrics),
    ]);

    const runs = await prisma.run.findMany({ where: { scheduleId: schedule.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("PENDING");

    const updated = await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(updated.paused).toBe(true);
    expect(updated.nextFireAt).toBeNull();
  });

  it("enqueues exactly one BullMQ job for the racing ticks", async () => {
    const { schedule } = await makeDueSchedule();

    await Promise.all([
      runSchedulerTick(queue, config, logger, metrics),
      runSchedulerTick(queue, config, logger, metrics),
    ]);

    const jobCounts = await queue.getJobCounts();
    const total = Object.values(jobCounts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(1);

    const run = await prisma.run.findFirstOrThrow({ where: { scheduleId: schedule.id } });
    const bullJobs = await queue.getJobs();
    expect(bullJobs).toHaveLength(1);
    expect(bullJobs[0]?.data.runId).toBe(run.id);
  });

  it("fires once per schedule across five concurrent ticks with multiple due schedules", async () => {
    const fixtures = await Promise.all([makeDueSchedule(), makeDueSchedule(), makeDueSchedule()]);

    await Promise.all(
      Array.from({ length: 5 }, () => runSchedulerTick(queue, config, logger, metrics)),
    );

    for (const { schedule } of fixtures) {
      const runs = await prisma.run.findMany({ where: { scheduleId: schedule.id } });
      expect(runs).toHaveLength(1);
    }
  });
});
