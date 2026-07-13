import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Queue, Worker } from "bullmq";
import { encryptSecret } from "@nexus-scheduler/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { prisma } from "./db.js";
import type { Logger } from "./logger.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { createRunProcessor } from "./processor.js";
import { createRunsQueue, RUNS_QUEUE_NAME, type RunJobData } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";

// Real Redis + real Postgres + a real in-process HTTP server standing in
// for LibreChat's Agents API — same "no mocking the system under test"
// posture as the rest of this suite. The one thing genuinely infeasible
// to run for real is LibreChat itself (no live deployment in this
// sandbox), so a local HTTP stub plays that external-boundary role,
// analogous to syslog.test.ts's real sockets or webhookDelivery.test.ts's
// real HTTP receiver.
const REDIS_URL = process.env.WORKER_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const ENCRYPTION_KEY = "processor-test-encryption-key-32-chars!!";
const connection = parseRedisConnectionOptions(REDIS_URL);

const config = {
  API_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY,
  LIBRECHAT_BASE_URL: "http://placeholder.invalid",
  PDF_SERVICE_URL: "http://placeholder.invalid",
  GLOBAL_MAX_CONCURRENT_RUNS: 10,
  PER_USER_MAX_CONCURRENT_RUNS: 5,
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
async function makeFixture(agentBaseUrl: string) {
  userCounter += 1;
  const user = await prisma.user.create({
    data: { email: `owner-${userCounter}@example.test`, authSource: "LOCAL", role: "EDITOR" },
  });
  const project = await prisma.project.create({ data: { name: "P", ownerId: user.id, visibility: "PRIVATE" } });
  const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });
  await prisma.promptVersion.create({
    data: { promptId: prompt.id, versionNumber: 1, content: "Hello {{run_id}}", createdById: user.id },
  });
  const apiKey = await prisma.apiKey.create({
    data: { ownerType: "USER", ownerUserId: user.id, encryptedKey: encryptSecret("librechat-key", ENCRYPTION_KEY) },
  });
  const job = await prisma.job.create({
    data: {
      projectId: project.id,
      name: "Job",
      promptId: prompt.id,
      agentId: "agent-1",
      apiKeyId: apiKey.id,
      createdById: user.id,
      timeoutSeconds: 30,
    },
  });
  return { user, job, agentBaseUrl };
}

async function makeRun(jobId: string, status: "PENDING" | "SUCCESS" = "PENDING") {
  return prisma.run.create({
    data: {
      jobId,
      triggerType: "MANUAL",
      status,
      output: status === "SUCCESS" ? "already done" : null,
    },
  });
}

function listenLibreChat(
  handler: (body: unknown) => { status: number; body: unknown },
): Promise<{ server: Server; baseUrl: string; callCount: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        calls += 1;
        const parsedBody = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const { status, body } = handler(parsedBody);
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, callCount: () => calls });
    });
  });
}

function waitForJobOutcome(worker: Worker<RunJobData>, jobId: string): Promise<"completed" | "failed"> {
  return new Promise((resolve) => {
    worker.on("completed", (job) => {
      if (job.id === jobId) resolve("completed");
    });
    worker.on("failed", (job) => {
      if (job?.id === jobId) resolve("failed");
    });
  });
}

describe("processRun (via createRunProcessor)", () => {
  let queue: Queue<RunJobData>;
  let worker: Worker<RunJobData> | undefined;
  let metrics: Metrics;
  let libreChatServer: Server | undefined;

  beforeEach(async () => {
    await resetDb();
    queue = createRunsQueue(connection);
    await queue.obliterate({ force: true }).catch(() => {});
    metrics = createMetrics(queue);
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    await queue.close();
    if (libreChatServer) {
      const s = libreChatServer;
      libreChatServer = undefined;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it("marks a run SUCCESS and records token usage from a successful LibreChat response", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 200,
      body: {
        choices: [{ message: { content: "the answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      },
    }));
    libreChatServer = server;
    const { job } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    const outcome = await waitForJobOutcome(worker, bullJob.id!);

    expect(outcome).toBe("completed");
    expect(callCount()).toBe(1);
    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("SUCCESS");
    expect(updated.output).toContain("the answer");
    expect(updated.promptTokens).toBe(12);
    expect(updated.completionTokens).toBe(34);
    expect(updated.completedAt).not.toBeNull();

    const events = await prisma.auditEvent.findMany({ where: { correlationId: run.id, action: "run.complete" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe("SUCCESS");
  });

  it("marks a run FAILED without retrying on a non-transient (4xx) LibreChat error", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 400,
      body: { error: "bad request" },
    }));
    libreChatServer = server;
    const { job } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    // Even with retries budgeted, a non-transient error must not consume them.
    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 3 });
    const outcome = await waitForJobOutcome(worker, bullJob.id!);

    expect(outcome).toBe("completed"); // resolves normally so BullMQ doesn't retry
    expect(callCount()).toBe(1);
    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.errorMessage).toMatch(/400/);

    const events = await prisma.auditEvent.findMany({ where: { correlationId: run.id, action: "run.complete" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe("FAILURE");
  });

  it("marks a run FAILED after a transient (5xx) LibreChat error exhausts retries", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 503,
      body: { error: "unavailable" },
    }));
    libreChatServer = server;
    const { job } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    // attempts: 1 means the first attempt is also the final attempt, so
    // this proves FAILED-on-exhaustion without waiting through a real
    // exponential backoff delay.
    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    const outcome = await waitForJobOutcome(worker, bullJob.id!);

    expect(outcome).toBe("failed"); // rethrown so BullMQ records the queue job itself as failed
    expect(callCount()).toBe(1);
    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.errorMessage).toMatch(/503/);
  });

  it("does not reprocess a run that is already in a terminal state", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 200,
      body: { choices: [{ message: { content: "should never be seen" }, finish_reason: "stop" }] },
    }));
    libreChatServer = server;
    const { job } = await makeFixture(baseUrl);
    const run = await makeRun(job.id, "SUCCESS");

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    const outcome = await waitForJobOutcome(worker, bullJob.id!);

    expect(outcome).toBe("completed");
    expect(callCount()).toBe(0); // never called the agent a second time
    const unchanged = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.status).toBe("SUCCESS");
    expect(unchanged.output).toBe("already done");
  });

  it("releases the per-user concurrency slot after a run completes", async () => {
    const { server, baseUrl } = await listenLibreChat(() => ({
      status: 200,
      body: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    }));
    libreChatServer = server;
    const { job, user } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    await waitForJobOutcome(worker, bullJob.id!);

    const redisClient = await worker.client;
    const remaining = await (redisClient as unknown as { zcard(key: string): Promise<number> }).zcard(
      `nexus:concurrency:user:${user.id}`,
    );
    expect(remaining).toBe(0);
  });
});
