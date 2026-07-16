import { Worker, DelayedError, type ConnectionOptions, type Job as BullJob } from "bullmq";
import { decryptSecret } from "@nexus-scheduler/shared";
import { prisma } from "./db.js";
import { RUNS_QUEUE_NAME, type RunJobData } from "./queue.js";
import { callAgent, describeUnexecutedToolCall, extractTokenUsage, LibreChatError } from "./librechatClient.js";
import { renderPromptTemplate } from "./promptTemplate.js";
import { computeCost } from "./costCalculator.js";
import { deliverWebhooksForRun } from "./webhookDelivery.js";
import { sendRunNotificationEmail } from "./notifications.js";
import { recordAuditEvent } from "./audit.js";
import { tryAcquireUserSlot, releaseUserSlot } from "./concurrency.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";
import type { Metrics } from "./metrics.js";

// A failed call reports no model, and not every deployment returns one on
// success either. A fixed placeholder keeps those observations in the
// histogram — dropping them would hide the worst cases, since a model that
// always fails would simply have no series at all — while staying a single
// bounded label value rather than a hole in the data.
const UNKNOWN_MODEL = "unknown";

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

// Both calls have their own internal best-effort error handling, but not
// around every early lookup (e.g. deliverWebhooksForRun's initial
// Prisma queries) — wrapping them here too means a failure in either can
// never escape into processRun's outer catch, which would otherwise
// misclassify an already-successful run as a retryable failure and
// either re-run the agent or overwrite a SUCCESS result to FAILED.
async function deliverTerminalSideEffects(
  runId: string,
  jobId: string,
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  try {
    await deliverWebhooksForRun(runId, jobId, config, logger);
  } catch (err) {
    logger.error({ runId, err }, "webhook delivery threw unexpectedly — run outcome is unaffected");
  }
  try {
    await sendRunNotificationEmail(runId, jobId, config, logger);
  } catch (err) {
    logger.error({ runId, err }, "run notification email threw unexpectedly — run outcome is unaffected");
  }
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
      job: {
        include: {
          apiKey: true,
          createdBy: { select: { email: true, givenName: true, familyName: true, displayName: true } },
          prompt: { include: { versions: true } },
        },
      },
      schedule: true,
    },
  });

  // Idempotency guard: a Run already in a terminal state has already
  // been fully processed — re-running it would call the agent a second
  // time (duplicate cost/side effects) or overwrite a SUCCESS result.
  // This can happen via BullMQ redelivery after a worker crash between
  // finishing the DB update and acking the job, not just the specific
  // webhook/notification-failure scenario below.
  if (run.status === "SUCCESS" || run.status === "FAILED" || run.status === "CANCELLED" || run.status === "SKIPPED") {
    logger.warn({ runId, status: run.status }, "run already in a terminal state, skipping reprocessing");
    return;
  }

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
        { scheduleName: run.job.name, runId, owner: run.job.createdBy },
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
        // Labels are only known once the response is in hand: which model
        // served this is decided by the Agent inside LibreChat, not by us.
        // That is why the timer is stopped here and in the catch rather than
        // in a finally — a finally runs before either fact is available.
        stopLibrechatTimer({ model: response.model ?? UNKNOWN_MODEL, outcome: "success" });
      } catch (err) {
        // A failed call never reports a model, so attributing the failure to
        // one would be a guess. `unknown` is the honest label, and it keeps
        // failures from silently vanishing out of the latency histogram —
        // dropping them would make a model that always times out look like a
        // model with no traffic.
        const kind = err instanceof LibreChatError ? err.kind : "network_error";
        stopLibrechatTimer({ model: UNKNOWN_MODEL, outcome: kind });
        metrics.librechatErrorsTotal.inc({ kind, model: UNKNOWN_MODEL });
        throw err;
      }

      const responseChoice = response.choices[0];
      const toolCallNote = describeUnexecutedToolCall(responseChoice?.message, responseChoice?.finish_reason);
      if (toolCallNote) {
        logger.warn(
          { runId, agentId: run.job.agentId, toolCalls: responseChoice?.message.tool_calls },
          "LibreChat agent response left a tool call unresolved — the run's stored output is a diagnostic note, not a real answer from the agent",
        );
      }
      const outputText = [toolCallNote, responseChoice?.message.content].filter(Boolean).join("\n\n");
      const tokenUsage = extractTokenUsage(response.usage);
      if (!tokenUsage) {
        // Three distinct cases collapsed into one null return by design
        // (extractTokenUsage), but they need different log messages: no
        // usage object at all, one in an unrecognized shape, or the
        // all-zero sentinel — verified live against LibreChat v0.8.7
        // (issue #38), whose Agents API returns well-formed zeros
        // because it doesn't meter headless API-key calls. Either way
        // this is the only signal an operator has to root-cause "token
        // usage always shows zero" from real production traffic.
        const allZero =
          response.usage !== undefined &&
          (response.usage.prompt_tokens === 0 || response.usage.input_tokens === 0) &&
          (response.usage.completion_tokens === 0 || response.usage.output_tokens === 0);
        logger.warn(
          { runId, agentId: run.job.agentId, hasUsageField: response.usage !== undefined, usage: response.usage },
          response.usage
            ? allZero
              ? "LibreChat returned an all-zero usage object — its Agents API doesn't meter this call (LibreChat limitation, issue #38); token counts not recorded for this run"
              : "LibreChat returned a usage object in an unrecognized shape — token counts not recorded for this run"
            : "LibreChat response had no usage object at all — token counts not recorded for this run",
        );
      }
      const computedCost = tokenUsage
        ? await computeCost(run.job.agentId, tokenUsage.promptTokens, tokenUsage.completionTokens, new Date())
        : null;

      // These are already computed and written to Postgres above; exposing
      // them costs nothing and is the difference between a cost question that
      // can be alerted on and one that needs a SQL query after the fact.
      // Left unrecorded when usage is absent rather than counted as zero:
      // LibreChat's Agents API returns all-zero usage for headless API-key
      // calls (#38), and a zero would read as "this run was free" instead of
      // "we were never told".
      const servingModel = response.model ?? UNKNOWN_MODEL;
      if (tokenUsage) {
        metrics.runTokensTotal.inc({ model: servingModel, type: "prompt" }, tokenUsage.promptTokens);
        metrics.runTokensTotal.inc({ model: servingModel, type: "completion" }, tokenUsage.completionTokens);
      }
      if (computedCost !== null) {
        metrics.runCostTotal.inc({ model: servingModel }, Number(computedCost));
      }

      await prisma.run.update({
        where: { id: runId },
        data: {
          status: "SUCCESS",
          completedAt: new Date(),
          output: outputText,
          promptTokens: tokenUsage?.promptTokens ?? null,
          completionTokens: tokenUsage?.completionTokens ?? null,
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
        targetName: run.job.name,
        category: "lifecycle",
        result: "SUCCESS",
        correlationId: runId,
      });

      await deliverTerminalSideEffects(runId, run.jobId, config, logger);
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
          targetName: run.job.name,
          category: "lifecycle",
          result: "FAILURE",
          errorMessage,
          correlationId: runId,
        });

        await deliverTerminalSideEffects(runId, run.jobId, config, logger);

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
