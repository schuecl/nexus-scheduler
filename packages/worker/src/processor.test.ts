import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Queue, Worker } from "bullmq";
import { encryptSecret, RUN_CANCEL_CHANNEL, RUN_CANCEL_REQUESTED_KEY } from "@nexus-scheduler/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { prisma } from "./db.js";
import type { Logger } from "./logger.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { createRunProcessor } from "./processor.js";
import { createRunsQueue, type RunJobData } from "./queue.js";
import { parseRedisConnectionOptions } from "./redisConnection.js";
import { startCancellationSubscriber } from "./cancellation.js";

// Same cast-through-the-narrow-BullMQ-type pattern concurrency.ts/
// cancellation.ts use — the runtime object really is a full ioredis
// instance, so this stands in for what the API does with its own
// (separately-dependency'd) ioredis instance in production.
interface RawTestClient {
  sadd(key: string, member: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zcard(key: string): Promise<number>;
}

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

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("processRun (via createRunProcessor)", () => {
  let queue: Queue<RunJobData>;
  let worker: Worker<RunJobData> | undefined;
  let metrics: Metrics;
  let libreChatServer: Server | undefined;
  let ocrServer: Server | undefined;

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
    if (ocrServer) {
      const s = ocrServer;
      ocrServer = undefined;
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

  it("persists searchable PDFs one attachment at a time instead of retaining the whole batch", async () => {
    const { server, baseUrl } = await listenLibreChat(() => ({
      status: 200,
      body: { choices: [{ message: { content: "documents read" }, finish_reason: "stop" }] },
    }));
    libreChatServer = server;
    const { job, user } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);
    await prisma.jobAttachment.createMany({
      data: [
        {
          jobId: job.id,
          filename: "one.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
          data: Buffer.from("one"),
          createdById: user.id,
        },
        {
          jobId: job.id,
          filename: "two.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
          data: Buffer.from("two"),
          createdById: user.id,
        },
      ],
    });

    let ocrCalls = 0;
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    let releaseSecond: (() => void) | undefined;
    const secondRelease = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    ocrServer = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        ocrCalls += 1;
        const call = ocrCalls;
        const reply = () => {
          const pdf = Buffer.from(`searchable-${call}`).toString("base64");
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              markdown: `extracted-${call}`,
              searchable_pdf_base64: pdf,
              descriptions: [],
              meta: { ocr_reported: 1 },
            }),
          );
        };
        if (call === 1) {
          reply();
        } else {
          markSecondStarted?.();
          void secondRelease.then(reply);
        }
      });
    });
    await new Promise<void>((resolve) => ocrServer!.listen(0, "127.0.0.1", resolve));
    const { port } = ocrServer.address() as AddressInfo;

    worker = createRunProcessor(
      connection,
      {
        ...config,
        LIBRECHAT_BASE_URL: baseUrl,
        OCR_SERVICE_URL: `http://127.0.0.1:${port}`,
        OCR_DESCRIBE_IMAGES: false,
        OCR_EXTRACTED_TEXT_MAX_CHARS: 400_000,
      },
      logger,
      metrics,
    );
    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    const outcomePromise = waitForJobOutcome(worker, bullJob.id!);

    await secondStarted;
    try {
      const artifactsDuringSecondOcr = await prisma.runArtifact.findMany({ where: { runId: run.id } });
      expect(artifactsDuringSecondOcr).toHaveLength(1);
      expect(artifactsDuringSecondOcr[0]?.kind).toBe("searchable_pdf_pending");
      expect(artifactsDuringSecondOcr[0]?.filename).toBe("one.pdf.searchable.pdf");
      expect(Buffer.from(artifactsDuringSecondOcr[0]!.data).toString()).toBe("searchable-1");
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).extractedText).toBeNull();
    } finally {
      releaseSecond?.();
    }

    expect(await outcomePromise).toBe("completed");
    expect(await prisma.runArtifact.count({ where: { runId: run.id } })).toBe(2);
    expect(await prisma.runArtifact.count({ where: { runId: run.id, kind: "searchable_pdf" } })).toBe(2);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).extractedText).toContain("extracted-2");
  });

  it("preserves evidence from a dispatched attempt when replacement OCR fails before dispatch", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 503,
      body: { error: "agent unavailable after accepting the request" },
    }));
    libreChatServer = server;
    const { job, user } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);
    await prisma.jobAttachment.create({
      data: {
        jobId: job.id,
        filename: "evidence.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
        data: Buffer.from("evidence"),
        createdById: user.id,
      },
    });

    let ocrCalls = 0;
    ocrServer = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        ocrCalls += 1;
        if (ocrCalls === 1) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              markdown: "first dispatched extraction",
              searchable_pdf_base64: Buffer.from("first searchable PDF").toString("base64"),
              descriptions: [],
              meta: { ocr_reported: 1 },
            }),
          );
        } else {
          res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "ocr unavailable" }));
        }
      });
    });
    await new Promise<void>((resolve) => ocrServer!.listen(0, "127.0.0.1", resolve));
    const { port } = ocrServer.address() as AddressInfo;

    worker = createRunProcessor(
      connection,
      {
        ...config,
        LIBRECHAT_BASE_URL: baseUrl,
        OCR_SERVICE_URL: `http://127.0.0.1:${port}`,
        OCR_DESCRIBE_IMAGES: false,
        OCR_EXTRACTED_TEXT_MAX_CHARS: 400_000,
      },
      logger,
      metrics,
    );
    await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 2 });
    await waitForCondition(async () => {
      const current = await prisma.run.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } });
      return ocrCalls === 2 && current.status === "FAILED";
    });

    expect(callCount()).toBe(1);
    expect(ocrCalls).toBe(2);
    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.extractedText).toContain("first dispatched extraction");
    const artifacts = await prisma.runArtifact.findMany({ where: { runId: run.id } });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe("searchable_pdf");
    expect(Buffer.from(artifacts[0]!.data).toString()).toBe("first searchable PDF");
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

  // Regression tests for issue #111: CANCELLED existed in the schema and
  // every downstream consumer already handled it, but nothing could ever
  // set it. Both of the ways a Run can be cancelled per the design in
  // cancellation.ts are exercised end to end (real Redis, no mocking).

  it("cancels a run before it ever calls the agent, when cancellation was requested while still queued", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 200,
      body: { choices: [{ message: { content: "should never be seen" }, finish_reason: "stop" }] },
    }));
    libreChatServer = server;
    const { job } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const raw = (await worker.client) as unknown as RawTestClient;
    // Simulates what the API's POST /api/runs/:id/cancel does — recorded
    // before the job is even enqueued, exactly like a cancel request
    // arriving while a Run is still sitting in the queue.
    await raw.sadd(RUN_CANCEL_REQUESTED_KEY, run.id);

    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    const outcome = await waitForJobOutcome(worker, bullJob.id!);

    expect(outcome).toBe("completed"); // not failed/retried — cancellation is terminal, not an error
    expect(callCount()).toBe(0); // the agent was never called
    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("CANCELLED");
    expect(updated.errorMessage).toMatch(/cancelled/i);

    const events = await prisma.auditEvent.findMany({ where: { correlationId: run.id, action: "run.complete" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe("SUCCESS");
  });

  it("preserves committed evidence but clears staging when a retry is cancelled before it starts", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 200,
      body: { choices: [{ message: { content: "should never be seen" }, finish_reason: "stop" }] },
    }));
    libreChatServer = server;
    const { job } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);
    await prisma.run.update({ where: { id: run.id }, data: { extractedText: "stale text" } });
    await prisma.runArtifact.create({
      data: {
        runId: run.id,
        kind: "searchable_pdf",
        filename: "stale.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("stale"),
      },
    });
    await prisma.runArtifact.create({
      data: {
        runId: run.id,
        kind: "searchable_pdf_pending",
        filename: "replacement.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("replacement"),
      },
    });
    await prisma.runArtifact.create({
      data: {
        runId: run.id,
        kind: "searchable_pdf_previous",
        filename: "abandoned-backup.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("abandoned backup"),
      },
    });

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const raw = (await worker.client) as unknown as RawTestClient;
    await raw.sadd(RUN_CANCEL_REQUESTED_KEY, run.id);

    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    await waitForJobOutcome(worker, bullJob.id!);

    expect(callCount()).toBe(0);
    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("CANCELLED");
    expect(updated.extractedText).toBe("stale text");
    expect(await prisma.runArtifact.count({ where: { runId: run.id, kind: "searchable_pdf" } })).toBe(1);
    expect(await prisma.runArtifact.count({ where: { runId: run.id, kind: "searchable_pdf_pending" } })).toBe(0);
    expect(await prisma.runArtifact.count({ where: { runId: run.id, kind: "searchable_pdf_previous" } })).toBe(0);
  });

  // Regression tests for issue #124: a worker that acquires a run's
  // concurrency slot and then crashes before its own `finally` runs
  // leaves a stale member in the user's ZSET — self-healing eventually
  // via TTL, but not before throttling that user's *other* runs for
  // however long was left on a run that isn't even executing anymore.
  // Both early-return paths that can follow such a crash now release it
  // immediately instead of waiting. Simulated here by seeding the ZSET
  // member directly (standing in for "a prior worker acquired this and
  // died") rather than actually crashing a worker mid-run.

  it("releases a stale concurrency slot when skipping a run that's already terminal", async () => {
    const { server, baseUrl, callCount } = await listenLibreChat(() => ({
      status: 200,
      body: { choices: [{ message: { content: "should never be seen" }, finish_reason: "stop" }] },
    }));
    libreChatServer = server;
    const { job, user } = await makeFixture(baseUrl);
    const run = await makeRun(job.id, "SUCCESS");

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const raw = (await worker.client) as unknown as RawTestClient;
    const slotKey = `nexus:concurrency:user:${user.id}`;
    await raw.zadd(slotKey, Date.now() + 60_000, run.id);
    expect(await raw.zcard(slotKey)).toBe(1);

    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    await waitForJobOutcome(worker, bullJob.id!);

    expect(callCount()).toBe(0); // the idempotency guard returned before ever calling the agent
    expect(await raw.zcard(slotKey)).toBe(0);
  });

  it("releases a stale concurrency slot when cancelling a run before it starts", async () => {
    const { server, baseUrl } = await listenLibreChat(() => ({
      status: 200,
      body: { choices: [{ message: { content: "should never be seen" }, finish_reason: "stop" }] },
    }));
    libreChatServer = server;
    const { job, user } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const raw = (await worker.client) as unknown as RawTestClient;
    const slotKey = `nexus:concurrency:user:${user.id}`;
    await raw.zadd(slotKey, Date.now() + 60_000, run.id);
    await raw.sadd(RUN_CANCEL_REQUESTED_KEY, run.id);

    const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
    await waitForJobOutcome(worker, bullJob.id!);

    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("CANCELLED");
    expect(await raw.zcard(slotKey)).toBe(0);
  });

  it("aborts an in-flight agent call when cancellation is requested while it's running", async () => {
    let onRequestReceived: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      onRequestReceived = resolve;
    });
    // Deliberately never responds — the point is to hold the connection
    // open long enough to prove the client aborts it client-side rather
    // than waiting for a server response or its own timeout.
    const server = http.createServer((req) => {
      req.resume();
      onRequestReceived?.();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    libreChatServer = server;
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const { job } = await makeFixture(baseUrl);
    const run = await makeRun(job.id);

    worker = createRunProcessor(connection, { ...config, LIBRECHAT_BASE_URL: baseUrl }, logger, metrics);
    const stopSubscriber = await startCancellationSubscriber(await worker.client, logger);
    try {
      const bullJob = await queue.add("run", { runId: run.id } satisfies RunJobData, { attempts: 1 });
      const outcomePromise = waitForJobOutcome(worker, bullJob.id!);

      // Only resolves once processRun's fetch has actually reached the
      // server — i.e. strictly after registerActiveRun has already run,
      // so this publish is guaranteed to find a live controller waiting.
      await requestReceived;
      const raw = (await worker.client) as unknown as RawTestClient;
      await raw.publish(RUN_CANCEL_CHANNEL, run.id);

      const outcome = await outcomePromise;
      expect(outcome).toBe("completed");
      const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      expect(updated.status).toBe("CANCELLED");

      // A cancellation is not an API failure: LibreChat behaved correctly and a
      // user chose to stop. Counting it would page whoever alerts on the error
      // rate every time someone cancels. Only the in-flight path can reach the
      // error counter — a run cancelled while still queued throws before the
      // call is ever timed — so this is the case that has to assert it.
      const errorSamples = (await metrics.librechatErrorsTotal.get()).values;
      expect(errorSamples.filter((s) => s.labels.kind === "cancelled")).toHaveLength(0);

      // ...but the call itself did happen and did take time, so it stays in the
      // latency histogram, distinguishable from success by `outcome`. Dropping
      // it would hide real latency.
      const callSamples = (await metrics.librechatCallDuration.get()).values;
      expect(callSamples.some((s) => s.labels.outcome === "cancelled")).toBe(true);

      // And the run itself is still counted — cancellations are not going
      // unmeasured, they are just not being measured as errors.
      const runSamples = (await metrics.runsTotal.get()).values;
      expect(runSamples.find((s) => s.labels.status === "cancelled")?.value).toBe(1);
    } finally {
      await stopSubscriber();
    }
  });
});
