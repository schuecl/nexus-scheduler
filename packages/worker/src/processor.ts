import { Worker, type ConnectionOptions, type Job as BullJob } from "bullmq";
import { decryptSecret } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import { RUNS_QUEUE_NAME, type RunJobData } from "./queue.js";
import { callAgent, LibreChatError } from "./librechatClient.js";
import { renderPromptTemplate } from "./promptTemplate.js";
import { computeCost } from "./costCalculator.js";
import { deliverWebhooksForRun } from "./webhookDelivery.js";
import { recordAuditEvent } from "./audit.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";

// One BullMQ Worker enforces the *global* concurrency ceiling (§2.1) via
// its `concurrency` option. Per-user concurrency limiting is not yet
// implemented — BullMQ's open-source edition has no native per-group
// concurrency primitive; tracking it will need an explicit counter (e.g.
// a Redis-backed semaphore keyed by user id) as a follow-up.
export function createRunProcessor(connection: ConnectionOptions, config: WorkerConfig, logger: Logger) {
  return new Worker<RunJobData>(
    RUNS_QUEUE_NAME,
    async (bullJob: BullJob<RunJobData>) => {
      await processRun(bullJob, config, logger);
    },
    { connection, concurrency: config.GLOBAL_MAX_CONCURRENT_RUNS },
  );
}

async function processRun(bullJob: BullJob<RunJobData>, config: WorkerConfig, logger: Logger): Promise<void> {
  const { runId } = bullJob.data;
  const isFinalAttempt = bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1);

  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: {
      job: { include: { apiKey: true, prompt: { include: { versions: true } } } },
      schedule: true,
    },
  });

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

    const response = await callAgent(run.job.agentId, renderedPrompt, apiKey, {
      baseUrl: config.LIBRECHAT_BASE_URL,
      timeoutMs: run.job.timeoutSeconds * 1000,
    });

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

    // TODO: §2.2 email/PDF-report delivery hooks fire from here once
    // notification preferences and the PDF renderer (§2.5) exist.
  } catch (err) {
    const transient = err instanceof LibreChatError ? err.transient : true;
    const errorMessage = err instanceof Error ? err.message : "unknown error";

    if (!transient || isFinalAttempt) {
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

      if (!transient) {
        logger.warn({ runId, errorMessage }, "non-transient failure, not retrying");
        return; // swallow — BullMQ won't retry a job that resolves normally
      }
    }

    logger.warn({ runId, errorMessage, attempt: bullJob.attemptsMade + 1 }, "run failed, may retry");
    throw err; // rethrow so BullMQ applies the configured retry/backoff (§2.1)
  }
}
