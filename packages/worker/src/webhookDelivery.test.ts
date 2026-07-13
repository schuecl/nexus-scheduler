import { createHmac } from "node:crypto";
import http, { type IncomingMessage, type Server } from "node:http";
import { encryptSecret } from "@nexus-scheduler/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { prisma } from "./db.js";
import type { Logger } from "./logger.js";
import { deliverWebhooksForRun } from "./webhookDelivery.js";

const ENCRYPTION_KEY = "webhook-delivery-test-key-32-chars!!";

const config = { API_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY } as WorkerConfig;
const logger = { warn: () => {}, info: () => {}, error: () => {} } as unknown as Logger;

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

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function makeJobAndRun(status: "SUCCESS" | "FAILED" | "CANCELLED" | "PENDING" = "SUCCESS") {
  const user = await prisma.user.create({
    data: { email: `owner-${Date.now()}-${Math.random()}@example.test`, authSource: "LOCAL", role: "EDITOR" },
  });
  const project = await prisma.project.create({
    data: { name: "P", ownerId: user.id, visibility: "PRIVATE" },
  });
  const prompt = await prisma.prompt.create({ data: { projectId: project.id, name: "Prompt" } });
  await prisma.promptVersion.create({
    data: { promptId: prompt.id, versionNumber: 1, content: "hi", createdById: user.id },
  });
  const apiKey = await prisma.apiKey.create({
    data: { ownerType: "USER", ownerUserId: user.id, encryptedKey: encryptSecret("key", ENCRYPTION_KEY) },
  });
  const job = await prisma.job.create({
    data: {
      projectId: project.id,
      name: "Job",
      promptId: prompt.id,
      agentId: "agent-1",
      apiKeyId: apiKey.id,
      createdById: user.id,
    },
  });
  const run = await prisma.run.create({
    data: {
      jobId: job.id,
      triggerType: "MANUAL",
      status,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:05.000Z"),
      output: status === "SUCCESS" ? "the output" : null,
      errorMessage: status === "FAILED" ? "boom" : null,
    },
  });
  return { user, project, job, run };
}

async function makeDestination(url: string, active = true) {
  const secret = "a-real-plaintext-webhook-secret";
  const destination = await prisma.webhookDestination.create({
    data: { name: "Dest", url, encryptedHmacSecret: encryptSecret(secret, ENCRYPTION_KEY), active },
  });
  return { destination, secret };
}

function listen(handler: (req: IncomingMessage, body: string) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        handler(req, Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200).end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook` });
    });
  });
}

describe("deliverWebhooksForRun", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    const sock = server;
    server = undefined;
    await new Promise<void>((resolve) => sock.close(() => resolve()));
  });

  it("does nothing when the job has no active webhook destinations", async () => {
    const { job, run } = await makeJobAndRun();
    await expect(deliverWebhooksForRun(run.id, job.id, config, logger)).resolves.toBeUndefined();
  });

  it("does not deliver for a non-terminal run status", async () => {
    const { job, run } = await makeJobAndRun("PENDING");
    let called = false;
    const { server: s, url } = await listen(() => {
      called = true;
    });
    server = s;
    const { destination } = await makeDestination(url);
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: destination.id } });

    await deliverWebhooksForRun(run.id, job.id, config, logger);
    expect(called).toBe(false);
  });

  it("does not deliver to an inactive destination", async () => {
    const { job, run } = await makeJobAndRun();
    let called = false;
    const { server: s, url } = await listen(() => {
      called = true;
    });
    server = s;
    const { destination } = await makeDestination(url, false);
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: destination.id } });

    await deliverWebhooksForRun(run.id, job.id, config, logger);
    expect(called).toBe(false);
  });

  it("POSTs the run payload with a valid HMAC-SHA256 signature header", async () => {
    const { job, run } = await makeJobAndRun("SUCCESS");
    let received: { method?: string; contentType?: string; signature?: string; body?: string } = {};
    const { server: s, url } = await listen((req, body) => {
      received = {
        method: req.method,
        contentType: req.headers["content-type"],
        signature: req.headers["x-nexus-signature"] as string,
        body,
      };
    });
    server = s;
    const { destination, secret } = await makeDestination(url);
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: destination.id } });

    await deliverWebhooksForRun(run.id, job.id, config, logger);

    expect(received.method).toBe("POST");
    expect(received.contentType).toBe("application/json");
    const expectedSignature = `sha256=${createHmac("sha256", secret).update(received.body ?? "").digest("hex")}`;
    expect(received.signature).toBe(expectedSignature);

    const payload = JSON.parse(received.body ?? "{}");
    expect(payload).toMatchObject({
      runId: run.id,
      jobId: job.id,
      jobName: job.name,
      status: "SUCCESS",
      output: "the output",
      errorMessage: null,
    });
  });

  it("records a SUCCESS audit event for a successful delivery", async () => {
    const { job, run } = await makeJobAndRun();
    const { server: s, url } = await listen(() => {});
    server = s;
    const { destination } = await makeDestination(url);
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: destination.id } });

    await deliverWebhooksForRun(run.id, job.id, config, logger);

    const events = await prisma.auditEvent.findMany({ where: { correlationId: run.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "webhook.deliver",
      targetId: destination.id,
      result: "SUCCESS",
    });
  });

  it("records a FAILURE audit event after retries are exhausted against an unreachable destination", async () => {
    const { job, run } = await makeJobAndRun();
    // Nothing listening on this port — connection is refused immediately,
    // so the two built-in retry delays (2s + 5s) still run for real but
    // don't need a live server to prove exhaustion + audit behavior.
    const { destination } = await makeDestination("http://127.0.0.1:1/hook");
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: destination.id } });

    await deliverWebhooksForRun(run.id, job.id, config, logger);

    const events = await prisma.auditEvent.findMany({ where: { correlationId: run.id } });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      action: "webhook.deliver",
      targetId: destination.id,
      result: "FAILURE",
    });
    expect(event?.errorMessage).toBeTruthy();
  }, 15_000);

  it("records a FAILURE audit event when the destination responds with a non-2xx status", async () => {
    const { job, run } = await makeJobAndRun();
    const { server: s, url } = await listen(() => {});
    // Override the 200 response with a 500 for this test.
    s.removeAllListeners("request");
    s.on("request", (req, res) => {
      req.resume();
      res.writeHead(500).end("nope");
    });
    server = s;
    const { destination } = await makeDestination(url);
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: destination.id } });

    await deliverWebhooksForRun(run.id, job.id, config, logger);

    const events = await prisma.auditEvent.findMany({ where: { correlationId: run.id } });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.result).toBe("FAILURE");
    expect(event?.errorMessage).toMatch(/500/);
  }, 15_000);

  it("delivers independently to multiple active destinations for the same run", async () => {
    const { job, run } = await makeJobAndRun();
    const seen: string[] = [];
    const { server: s1, url: url1 } = await listen(() => seen.push("one"));
    const { server: s2, url: url2 } = await listen(() => seen.push("two"));
    const { destination: dest1 } = await makeDestination(url1);
    const { destination: dest2 } = await makeDestination(url2);
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: dest1.id } });
    await prisma.jobWebhookDestination.create({ data: { jobId: job.id, webhookDestinationId: dest2.id } });

    await deliverWebhooksForRun(run.id, job.id, config, logger);

    expect(new Set(seen)).toEqual(new Set(["one", "two"]));
    await Promise.all([
      new Promise<void>((resolve) => s1.close(() => resolve())),
      new Promise<void>((resolve) => s2.close(() => resolve())),
    ]);
  });
});
