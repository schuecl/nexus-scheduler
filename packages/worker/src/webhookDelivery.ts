import {
  decryptSecret,
  signWebhookPayload,
  buildWebhookDeliveryHeaders,
  type WebhookPayload,
} from "@nexus-scheduler/shared";
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
    // Explicit select: the webhook payload is metadata + output — never
    // the run's OCR extractedText.
    prisma.run.findUniqueOrThrow({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        output: true,
        errorMessage: true,
      },
    }),
    prisma.job.findUniqueOrThrow({ where: { id: jobId } }),
  ]);

  if (run.status !== "SUCCESS" && run.status !== "FAILED" && run.status !== "CANCELLED") {
    return; // only terminal states are ever delivered
  }

  // Per-destination event selection (§27) — a destination can opt out
  // of some terminal states (e.g. success-only) without disabling it
  // entirely, which would also stop it from being attachable to a Job.
  const eligibleLinks = links.filter((link) => {
    const destination = link.webhookDestination;
    if (run.status === "SUCCESS") return destination.notifyOnSuccess;
    if (run.status === "FAILED") return destination.notifyOnFailure;
    return destination.notifyOnCancelled;
  });
  if (eligibleLinks.length === 0) {
    return;
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
    eligibleLinks.map((link) => deliverOne(link.webhookDestination, rawBody, runId, config, logger)),
  );
}

async function deliverOne(
  destination: { id: string; name: string; url: string; encryptedHmacSecret: string; headers: unknown },
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
        headers: buildWebhookDeliveryHeaders(destination.headers, signature),
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
        category: "governance",
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
    category: "governance",
    result: "FAILURE",
    errorMessage: lastError,
    correlationId: runId,
  });
}
