import { decryptSecret, signWebhookPayload, type WebhookPayload } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import { recordAuditEvent } from "./audit.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";

// Delivers a run's result to every active webhook destination attached
// to its Job (REQUIREMENTS §2.2). Destinations always come from the
// admin allow-list (WebhookDestination rows) — there is no way to reach
// an arbitrary URL through this path.
//
// Retries here are intentionally short (a few seconds total), not the
// job's own 30s/120s policy (§2.1) — this runs synchronously inside the
// run's BullMQ job, so a slow/dead receiver shouldn't hold a worker
// concurrency slot for minutes. A failed delivery is logged and audited
// but never fails the run itself or causes BullMQ to retry the run.
const DELIVERY_RETRY_DELAYS_MS = [2000, 5000];

export async function deliverWebhooksForRun(
  runId: string,
  jobId: string,
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  const links = await prisma.jobWebhookDestination.findMany({
    where: { jobId, webhookDestination: { active: true } },
    include: { webhookDestination: true },
  });
  if (links.length === 0) {
    return;
  }

  const [run, job] = await Promise.all([
    prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    prisma.job.findUniqueOrThrow({ where: { id: jobId } }),
  ]);

  if (run.status !== "SUCCESS" && run.status !== "FAILED" && run.status !== "CANCELLED") {
    return; // only terminal states are ever delivered
  }

  const payload: WebhookPayload = {
    runId: run.id,
    jobId: job.id,
    jobName: job.name,
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    output: run.output,
    errorMessage: run.errorMessage,
  };
  const rawBody = JSON.stringify(payload);

  await Promise.all(
    links.map((link) => deliverOne(link.webhookDestination, rawBody, runId, config, logger)),
  );
}

async function deliverOne(
  destination: { id: string; name: string; url: string; encryptedHmacSecret: string },
  rawBody: string,
  runId: string,
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  const secret = decryptSecret(destination.encryptedHmacSecret, config.API_KEY_ENCRYPTION_KEY);
  const signature = signWebhookPayload(rawBody, secret);

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(destination.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nexus-Signature": `sha256=${signature}` },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`destination responded ${response.status}`);
      }
      await recordAuditEvent({
        actorType: "SERVICE",
        actorId: "system:scheduler",
        actorEmail: "system:scheduler",
        action: "webhook.deliver",
        targetType: "webhook",
        targetId: destination.id,
        targetName: destination.name,
        result: "SUCCESS",
        correlationId: runId,
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown delivery error";
      const delay = DELIVERY_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.warn({ destinationId: destination.id, runId, error: lastError }, "webhook delivery failed");
  await recordAuditEvent({
    actorType: "SERVICE",
    actorId: "system:scheduler",
    actorEmail: "system:scheduler",
    action: "webhook.deliver",
    targetType: "webhook",
    targetId: destination.id,
    targetName: destination.name,
    result: "FAILURE",
    errorMessage: lastError,
    correlationId: runId,
  });
}
