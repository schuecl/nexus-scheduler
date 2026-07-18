import { Worker, DelayedError, type ConnectionOptions, type Job as BullJob, type RedisClient } from "bullmq";
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
import { isCancelRequested, clearCancelRequest, registerActiveRun, unregisterActiveRun } from "./cancellation.js";
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
export async function deliverTerminalSideEffects(
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

// Single writer of the CANCELLED terminal state (issue #111), called
// from both places a cancellation can be discovered: before the agent
// was ever called (still queued/delayed) and after an in-flight call
// was aborted mid-flight. Mirrors the SUCCESS/FAILED terminal handling
// below — same metric, audit event, and webhook/notification delivery
// (notifyOnCancelled is the entire reason this exists) — just its own
// status and a fixed message instead of the agent's own error.
async function markRunCancelled(
  runId: string,
  jobName: string,
  jobId: string,
  startedAt: Date | null,
  stopRunTimer: ReturnType<Metrics["runDuration"]["startTimer"]>,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
): Promise<void> {
  metrics.runsTotal.inc({ status: "cancelled" });
  stopRunTimer({ status: "cancelled" });
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: "CANCELLED",
      startedAt: startedAt ?? undefined,
      completedAt: new Date(),
      errorMessage: "Cancelled by user request",
    },
  });
  await recordAuditEvent({
    actorType: "SERVICE",
    actorId: "system:scheduler",
    actorEmail: "system:scheduler",
    action: "run.complete",
    targetType: "run",
    targetId: runId,
    targetName: jobName,
    category: "lifecycle",
    result: "SUCCESS",
    correlationId: runId,
    details: { status: "CANCELLED" },
  });
  await deliverTerminalSideEffects(runId, jobId, config, logger);
}

// Best-effort release used on every exit path that can follow a prior
// (possibly crashed) worker's successful acquire for this exact runId —
// see the two early-return call sites below and issue #124. A plain
// ZREM, so calling it when there was never anything to release (the
// overwhelming majority of the time) is a harmless no-op; never allowed
// to fail processing, since the TTL self-heals a leaked slot regardless.
export async function releaseUserSlotSafely(
  redisClient: RedisClient,
  userId: string,
  runId: string,
  logger: Logger,
): Promise<void> {
  await releaseUserSlot(redisClient, userId, runId).catch((releaseErr: unknown) => {
    logger.warn({ runId, userId, err: releaseErr }, "failed to release concurrency slot — will self-expire via TTL");
  });
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

  const userId = run.job.createdById;
  const redisClient = await worker.client;

  // Idempotency guard: a Run already in a terminal state has already
  // been fully processed — re-running it would call the agent a second
  // time (duplicate cost/side effects) or overwrite a SUCCESS result.
  // This can happen via BullMQ redelivery after a worker crash between
  // finishing the DB update and acking the job, not just the specific
  // webhook/notification-failure scenario below. Also releases this
  // run's slot on the way out (issue #124): a worker that crashed after
  // writing the terminal status but before its own `finally` ran would
  // otherwise leave that slot held until TTL expiry.
  if (run.status === "SUCCESS" || run.status === "FAILED" || run.status === "CANCELLED" || run.status === "SKIPPED") {
    logger.warn({ runId, status: run.status }, "run already in a terminal state, skipping reprocessing");
    await releaseUserSlotSafely(redisClient, userId, runId, logger);
    return;
  }

  // A Run cancelled while still queued/delayed (never yet reached this
  // point before) — checked before doing any of the real work below
  // (concurrency slot, prompt rendering, decrypting the API key) so a
  // cancelled Run never actually calls the agent (issue #111). A Run
  // cancelled *during* the agent call is handled separately, further
  // down, since by then this check has already passed.
  //
  // Also releases this run's slot on the way out (issue #124): if a
  // prior worker acquired it and crashed before releasing, this run
  // never reaches the slot-acquisition block below to trigger the usual
  // release-on-finally, so nothing else would clean it up before its
  // TTL — a stale slot otherwise throttles that user's *other* runs for
  // however long was left on a run that is no longer even executing.
  if (await isCancelRequested(redisClient, runId)) {
    await clearCancelRequest(redisClient, runId);
    logger.info({ runId }, "run cancelled before it started");
    await markRunCancelled(
      runId,
      run.job.name,
      run.jobId,
      run.startedAt,
      metrics.runDuration.startTimer(),
      config,
      logger,
      metrics,
    );
    await releaseUserSlotSafely(redisClient, userId, runId, logger);
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
  const slotTtlMs = run.job.timeoutSeconds * 1000 + 5 * 60_000;
  const acquired = await tryAcquireUserSlot(
    redisClient,
    userId,
    runId,
    config.PER_USER_MAX_CONCURRENT_RUNS,
    slotTtlMs,
  );
  if (!acquired) {
    // Without this, a throttled run is indistinguishable from a slow one: both
    // simply take longer to start. This is what says the ceiling was hit.
    metrics.runsThrottledTotal.inc({ scope: "user" });
    logger.info({ runId, userId }, "run throttled — per-user concurrency limit reached, delaying");
    await bullJob.moveToDelayed(Date.now() + 5000, token);
    throw new DelayedError();
  }

  // Enqueue -> pickup, measured against BullMQ's own enqueue stamp. Observed
  // once the slot is held, so a throttled job — re-delayed and re-entering
  // here — contributes the whole wait, not just its last attempt. That is
  // deliberate: this is the delay a user actually experiences before their run
  // starts, and whether it came from a busy worker or a concurrency ceiling is
  // not a distinction they can feel. runs_throttled_total attributes the cause;
  // this measures the cost.
  metrics.queueWait.observe((Date.now() - bullJob.timestamp) / 1000);

  const stopRunTimer = metrics.runDuration.startTimer();
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

      // Re-checked here (not just once, above) to close most of the gap
      // between "not cancelled yet" and "now listening for a live
      // cancel" below — a cancellation landing in that narrow window
      // would otherwise go unnoticed until this call finishes on its
      // own. registerActiveRun immediately after is what a cancel
      // arriving *during* the call itself aborts (issue #111).
      if (await isCancelRequested(redisClient, runId)) {
        await clearCancelRequest(redisClient, runId);
        throw new LibreChatError("run cancelled before the agent call started", 0, false, "cancelled");
      }
      const cancelController = registerActiveRun(runId);

      const stopLibrechatTimer = metrics.librechatCallDuration.startTimer();
      let response;
      try {
        try {
          response = await callAgent(run.job.agentId, renderedPrompt, apiKey, {
            baseUrl: config.LIBRECHAT_BASE_URL,
            timeoutMs: run.job.timeoutSeconds * 1000,
            abortSignal: cancelController.signal,
          });
          // Labels are only known once the response is in hand: which model
          // served this is decided by the Agent inside LibreChat, not by us.
          // That is why the timer is stopped here and in the catch rather
          // than in a finally — a finally runs before either fact is
          // available.
          stopLibrechatTimer({ model: response.model ?? UNKNOWN_MODEL, outcome: "success" });
        } catch (err) {
          // A failed call never reports a model, so attributing the failure to
          // one would be a guess. `unknown` is the honest label, and it keeps
          // failures from silently vanishing out of the latency histogram —
          // dropping them would make a model that always times out look like a
          // model with no traffic.
          const kind = err instanceof LibreChatError ? err.kind : "network_error";
          stopLibrechatTimer({ model: UNKNOWN_MODEL, outcome: kind });
          // A cancellation is not a failure of the API — LibreChat did nothing
          // wrong, a user chose to stop. Counting it here would page whoever
          // alerts on the error rate every time someone cancels a run, and put
          // a deliberate human action next to timeouts and outages, which call
          // for the opposite response. It stays on the histogram above:
          // the call really happened and really took time, `outcome` already
          // tells it apart from success, and runs_total{status="cancelled"}
          // counts the runs themselves — so nothing goes unmeasured, it just
          // stops being measured as the wrong thing.
          if (kind !== "cancelled") {
            metrics.librechatErrorsTotal.inc({ kind, model: UNKNOWN_MODEL });
          }
          throw err;
        }
      } finally {
        unregisterActiveRun(runId);
        // Idempotent: a durable request only ever reaches here when the
        // live pub/sub abort fired without going through either
        // isCancelRequested check above — clear it so it doesn't outlive
        // the Run it named. A no-op the vast majority of the time (no
        // cancellation happened at all).
        await clearCancelRequest(redisClient, runId);
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
      stopRunTimer({ status: "success" });
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
      // Checked first, ahead of the generic transient/retry handling
      // below: a cancellation is deliberately never retried regardless
      // of attempt count, and must land as CANCELLED, not FAILED
      // (issue #111).
      if (err instanceof LibreChatError && err.kind === "cancelled") {
        logger.info({ runId }, "run cancelled mid-flight");
        await markRunCancelled(runId, run.job.name, run.jobId, run.startedAt, stopRunTimer, config, logger, metrics);
        return; // swallow — BullMQ marks the job completed, not failed/retried
      }

      const transient = err instanceof LibreChatError ? err.transient : true;
      const errorMessage = err instanceof Error ? err.message : "unknown error";

      if (!transient || isFinalAttempt) {
        metrics.runsTotal.inc({ status: "failed" });
        // Only on the terminal attempt. Observing every failed attempt would
        // fill the histogram with the duration of retries rather than the
        // duration of runs, and make a heavily-retried run look like several
        // fast failures.
        stopRunTimer({ status: "failed" });
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
    await releaseUserSlotSafely(redisClient, userId, runId, logger);
  }
}
