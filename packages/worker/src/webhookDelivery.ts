import {
  decryptSecret,
  signWebhookPayload,
  buildWebhookDeliveryHeaders,
  renderWebhookPayloadTemplate,
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
// Retries are deliberately few, not the job's own 30s/120s policy
// (§2.1) — this runs synchronously inside the run's BullMQ job, so a
// slow or dead receiver shouldn't hold a worker concurrency slot for
// minutes. A failed delivery is logged and audited but never fails the
// run itself or causes BullMQ to retry the run.
//
// Worst case is 3 attempts x 10s plus 7s of sleep = 37s. The timeout is
// per attempt, not a total budget.
const DELIVERY_RETRY_DELAYS_MS = [2000, 5000];

// Retrying a permanent rejection cannot succeed and costs a worker slot
// on every single run: a destination with a stale token would burn all
// three attempts forever. Retry transport failures, 5xx, and the two
// status codes that explicitly mean "later" — nothing else.
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

// Thrown for a non-2xx so the retry loop can tell a permanent rejection
// from a transient one; plain transport errors stay retryable.
class WebhookResponseError extends Error {
  constructor(readonly status: number) {
    super(`destination responded ${status}`);
    this.name = "WebhookResponseError";
  }
}

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

  // Body is now per-destination (issue #224: each destination can have
  // its own custom payload template), so it moved from a single
  // rawBody computed once to an argument built inside deliverOne.
  await Promise.all(
    eligibleLinks.map((link) => deliverOne(link.webhookDestination, payload, runId, config, logger)),
  );
}

async function deliverOne(
  destination: {
    id: string;
    name: string;
    url: string;
    encryptedHmacSecret: string;
    headers: unknown;
    signPayload: boolean;
    customPayloadEnabled: boolean;
    payloadTemplate: string | null;
  },
  payload: WebhookPayload,
  runId: string,
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  // customPayloadEnabled without a usable template shouldn't be
  // reachable — the API validates the effective state on every
  // POST/PATCH — but a row can predate that validation or be edited
  // directly, so fall back to the fixed shape rather than sending an
  // empty/broken body.
  let rawBody: string;
  if (destination.customPayloadEnabled && destination.payloadTemplate) {
    rawBody = renderWebhookPayloadTemplate(destination.payloadTemplate, payload);
  } else {
    if (destination.customPayloadEnabled) {
      logger.warn(
        { destinationId: destination.id, runId },
        "webhook destination has customPayloadEnabled but no payloadTemplate — sending the default payload shape",
      );
    }
    rawBody = JSON.stringify(payload);
  }

  const signature = destination.signPayload
    ? signWebhookPayload(rawBody, decryptSecret(destination.encryptedHmacSecret, config.API_KEY_ENCRYPTION_KEY))
    : null;

  let lastError: string | undefined;
  let delivered = false;
  for (let attempt = 0; attempt <= DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(destination.url, {
        method: "POST",
        headers: buildWebhookDeliveryHeaders(destination.headers, signature),
        body: rawBody,
        // A destination is an admin-approved URL, and following a
        // redirect would hand the decision of which host we actually
        // contact to whoever operates it. Node's fetch replays the full
        // POST — body, signature, and the receiver's own auth header —
        // to the redirect target, and only Authorization/Cookie are
        // stripped cross-origin, so a custom token travels. Treat any
        // 3xx as a failed delivery instead; if a receiver really must
        // move, an admin updates the allow-listed URL.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      // With redirect: "manual" a 3xx arrives as an ordinary response,
      // and !response.ok already covers it.
      if (!response.ok) {
        throw new WebhookResponseError(response.status);
      }
      // Leaving the body unread keeps the connection out of undici's
      // pool until GC; a chatty receiver would accumulate sockets in a
      // long-lived worker.
      await response.body?.cancel();
      delivered = true;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown delivery error";
      if (err instanceof WebhookResponseError && !isRetryableStatus(err.status)) {
        break; // permanent rejection — more attempts cannot change it
      }
      const delay = DELIVERY_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Audited outside the request loop on purpose. This write can fail on
  // its own (a pool blip, a constraint error), and inside the try that
  // failure was caught by the retry handler — so a delivery the receiver
  // had already accepted was sent again, up to three times, and the run
  // ended with a FAILURE event claiming it never arrived.
  if (delivered) {
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
