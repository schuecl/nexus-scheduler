import { Worker, DelayedError, type ConnectionOptions, type Job as BullJob } from "bullmq";
import { decryptSecret } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import { RUNS_QUEUE_NAME, type RunJobData } from "./queue.js";
import { callAgent, LibreChatError } from "./librechatClient.js";
import { renderPromptTemplate } from "./promptTemplate.js";
import { computeCost } from "./costCalculator.js";
import { deliverWebhooksForRun } from "./webhookDelivery.js";
import { sendRunNotificationEmail } from "./notifications.js";
import { recordAuditEvent } from "./audit.js";
import { tryAcquireUserSlot, releaseUserSlot } from "./concurrency.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";
import type { Metrics } from "./metrics.js";

// BullMQ's own `concurrency` option enforces the *global* ceiling
// (§2.1); the per-user layer on top (concurrency.ts) needs a handle to
// this same Worker's Redis connection, which only exists once the
// Worker itself has been constructed — `worker` is referenced inside
// its own processor callback via closure, safe because job processing
// is always asynchronous relative to the constructor call returning.
export function createRunProcessor(
  connection: ConnectionOptions,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
) {
  const worker: Worker<RunJobData> = new Worker<RunJobData>(
    RUNS_QUEUE_NAME,
    async (bullJob: BullJob<RunJobData>, token?: string) => {
      await processRun(bullJob, token, worker, config, logger, metrics);
    },
    { connection, concurrency: config.GLOBAL_MAX_CONCURRENT_RUNS },
  );
  return worker;
}

async function processRun(
  bullJob: BullJob<RunJobData>,
  token: string | undefined,
  worker: Worker<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
): Promise<void> {
  const { runId } = bullJob.data;
  const isFinalAttempt = bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1);

  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: {
      job: { include: { apiKey: true, prompt: { include: { versions: true } } } },
      schedule: true,
    },
  });

  // Per-user concurrency limiting (§2.1) — attributed to the Job's
  // owner, the only "user" identity available on every Run regardless
  // of trigger type (scheduled or manual). A throttled run is delayed
  // and retried later via BullMQ's own DelayedError mechanism, which
  // does *not* count against the job's retry/backoff budget — being
  // throttled isn't a failure, it's just waiting for a slot. The slot
  // TTL is generous (job timeout + 5min buffer) so a crashed worker
  // that never releases its slot self-heals instead of permanently
  // shrinking that user's effective limit.
  const userId = run.job.createdById;
  const redisClient = await worker.client;
  const slotTtlMs = run.job.timeoutSeconds * 1000 + 5 * 60_000;
  const acquired = await tryAcquireUserSlot(
    redisClient,
    userId,
    runId,
    config.PER_USER_MAX_CONCURRENT_RUNS,
    slotTtlMs,
  );
  if (!acquired) {
    logger.info({ runId, userId }, "run throttled — per-user concurrency limit reached, delaying");
    await bullJob.moveToDelayed(Date.now() + 5000, token);
    throw new DelayedError();
  }

  try {
    await prisma.run.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } });

    try {
      const promptVersion =
        run.schedule?.versionPinMode === "PINNED" && run.schedule.pinnedPromptVersionId
          ? run.job.prompt.versions.find((v) => v.id === run.schedule!.pinnedPromptVersionId)
          : [...run.job.prompt.versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];

      if (!promptVersion) {
        throw new Error(`no prompt version available for job ${run.jobId}`);
      }

      const declaredVariables = Array.isArray(promptVersion.variables)
        ? (promptVersion.variables as Array<{ name: string; defaultValue?: string }>)
        : [];
      const variableValues = (run.schedule?.variableValues as Record<string, string> | null) ?? {};
      const renderedPrompt = renderPromptTemplate(
        promptVersion.content,
        { scheduleName: run.job.name, runId },
        declaredVariables,
        variableValues,
      );

      const apiKey = decryptSecret(run.job.apiKey.encryptedKey, config.API_KEY_ENCRYPTION_KEY);

      const stopLibrechatTimer = metrics.librechatCallDuration.startTimer();
      let response;
      try {
        response = await callAgent(run.job.agentId, renderedPrompt, apiKey, {
          baseUrl: config.LIBRECHAT_BASE_URL,
          timeoutMs: run.job.timeoutSeconds * 1000,
        });
      } finally {
        stopLibrechatTimer();
      }

      const outputText = response.choices[0]?.message.content ?? "";
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;
      const computedCost = response.usage
        ? await computeCost(run.job.agentId, promptTokens, completionTokens, new Date())
        : null;

      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "SUCCESS",
          completedAt: new Date(),
          output: outputText,
          promptTokens: response.usage ? promptTokens : null,
          completionTokens: response.usage ? completionTokens : null,
          computedCost: computedCost ?? undefined,
        },
      });

      metrics.runsTotal.inc({ status: "success" });
      await recordAuditEvent({
        actorType: "SERVICE",
        actorId: "system:scheduler",
        actorEmail: "system:scheduler",
        action: "run.complete",
        targetType: "run",
        targetId: runId,
        result: "SUCCESS",
        correlationId: runId,
      });

      await deliverWebhooksForRun(runId, run.jobId, config, logger);
      await sendRunNotificationEmail(runId, run.jobId, config, logger);
    } catch (err) {
      const transient = err instanceof LibreChatError ? err.transient : true;
      const errorMessage = err instanceof Error ? err.message : "unknown error";

      if (!transient || isFinalAttempt) {
        metrics.runsTotal.inc({ status: "failed" });
        await prisma.run.update({
          where: { id: runId },
          data: { status: "FAILED", completedAt: new Date(), errorMessage },
        });
        await recordAuditEvent({
          actorType: "SERVICE",
          actorId: "system:scheduler",
          actorEmail: "system:scheduler",
          action: "run.complete",
          targetType: "run",
          targetId: runId,
          result: "FAILURE",
          errorMessage,
          correlationId: runId,
        });

        await deliverWebhooksForRun(runId, run.jobId, config, logger);
        await sendRunNotificationEmail(runId, run.jobId, config, logger);

        if (!transient) {
          logger.warn({ runId, errorMessage }, "non-transient failure, not retrying");
          return; // swallow — BullMQ won't retry a job that resolves normally
        }
      }

      logger.warn({ runId, errorMessage, attempt: bullJob.attemptsMade + 1 }, "run failed, may retry");
      throw err; // rethrow so BullMQ applies the configured retry/backoff (§2.1)
    }
  } finally {
    await releaseUserSlot(redisClient, userId, runId).catch((releaseErr: unknown) => {
      logger.warn(
        { runId, userId, err: releaseErr },
        "failed to release concurrency slot — will self-expire via TTL",
      );
    });
  }
}
