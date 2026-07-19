import type { Queue, RedisClient } from "bullmq";
import { prisma } from "./db.js";
import {
  deliverTerminalSideEffects,
  PENDING_SEARCHABLE_PDF_KIND,
  PREVIOUS_SEARCHABLE_PDF_KIND,
  releaseUserSlotSafely,
} from "./processor.js";
import { recordAuditEvent } from "./audit.js";
import type { RunJobData } from "./queue.js";
import type { Logger } from "./logger.js";
import type { WorkerConfig } from "./config.js";
import type { Metrics } from "./metrics.js";

// BullMQ's own stalled-job detection (Worker's stalledInterval/
// maxStalledCount) is meant to reclaim a job whose lock stops being
// renewed after its worker dies, but issue #123 was filed against
// exactly that not happening reliably in practice: a run left RUNNING
// (or PENDING, orphaned in the create-Run/enqueue-job gap — the two
// aren't a transaction) by a crashed or restarted worker, with nothing
// else watching it, stays that way forever — no retry, no failure
// notification, no freed concurrency slot. This is the DB-side
// reconciliation sweep the issue asks for: a periodic pass that finds
// runs stuck past a generous staleness threshold and force-terminates
// them the same way a normal failure would, rather than a second,
// inconsistent code path.
async function reapRun(
  runId: string,
  jobName: string,
  jobId: string,
  userId: string,
  errorMessage: string,
  previousStatus: "RUNNING" | "PENDING",
  redisClient: RedisClient,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
): Promise<void> {
  // Committed extraction crossed the agent-dispatch boundary and remains
  // valid evidence even when the response was lost with the worker. Only
  // the explicitly staged rows are known to be pre-dispatch and removable.
  // Keep terminalization and that cleanup in one transaction so artifact
  // routes never expose staging data after FAILED becomes visible.
  await prisma.$transaction([
    prisma.run.update({
      where: { id: runId },
      data: { status: "FAILED", completedAt: new Date(), errorMessage },
    }),
    prisma.runArtifact.deleteMany({
      where: { runId, kind: { in: [PENDING_SEARCHABLE_PDF_KIND, PREVIOUS_SEARCHABLE_PDF_KIND] } },
    }),
  ]);
  metrics.runsTotal.inc({ status: "failed" });
  metrics.orphanRunsReapedTotal.inc({ previousStatus: previousStatus.toLowerCase() });
  await recordAuditEvent({
    actorType: "SERVICE",
    actorId: "system:orphan-reaper",
    actorEmail: "system:orphan-reaper",
    action: "run.complete",
    targetType: "run",
    targetId: runId,
    targetName: jobName,
    category: "lifecycle",
    result: "FAILURE",
    errorMessage,
    correlationId: runId,
  });
  await releaseUserSlotSafely(redisClient, userId, runId, logger);
  await deliverTerminalSideEffects(runId, jobId, config, logger);
  logger.warn({ runId, previousStatus }, "orphaned run reaped");
}

// One sweep. Exported standalone (mirrors runSchedulerTick) so a test
// can invoke it directly without waiting on real setInterval timing.
export async function runOrphanReaperSweep(
  queue: Queue<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
): Promise<void> {
  const redisClient = await queue.client;
  const now = Date.now();

  // RUNNING: staleness measured against the same TTL formula the
  // concurrency slot itself uses (job timeout + 5min grace) — a run
  // still legitimately executing never gets anywhere near this, and a
  // run whose worker died mid-flight has no other mechanism moving it
  // out of RUNNING at all.
  // Explicit select, not include: the sweep only needs ids and
  // timestamps, and `include` would drag every Run scalar along —
  // including a retry's persisted extractedText — on every interval.
  const runningCandidates = await prisma.run.findMany({
    where: { status: "RUNNING" },
    select: {
      id: true,
      startedAt: true,
      createdAt: true,
      job: { select: { id: true, name: true, timeoutSeconds: true, createdById: true } },
    },
  });
  for (const run of runningCandidates) {
    const staleAfterMs = run.job.timeoutSeconds * 1000 + 5 * 60_000;
    const startedAtMs = run.startedAt?.getTime() ?? run.createdAt.getTime();
    if (now - startedAtMs < staleAfterMs) {
      continue;
    }
    await reapRun(
      run.id,
      run.job.name,
      run.job.id,
      run.job.createdById,
      "Run left RUNNING past its timeout with no worker still processing it — reaped by the orphan reaper (issue #123), most likely caused by a worker crash or restart mid-run.",
      "RUNNING",
      redisClient,
      config,
      logger,
      metrics,
    );
  }

  // PENDING: a Run row created but never (or no longer) backed by a
  // live BullMQ job — either the worker crashed between creating the
  // Run and enqueuing its job (the two calls aren't transactional), or
  // the job existed and finished but somehow never wrote back a
  // terminal status. The grace period exists solely to not race the
  // ordinary gap between those two calls on a healthy, un-orphaned run.
  const pendingCandidates = await prisma.run.findMany({
    where: {
      status: "PENDING",
      createdAt: { lte: new Date(now - config.ORPHAN_REAPER_PENDING_GRACE_MS) },
    },
    select: {
      id: true,
      job: { select: { id: true, name: true, createdById: true } },
    },
  });
  for (const run of pendingCandidates) {
    const bullJob = await queue.getJob(run.id);
    if (bullJob) {
      continue;
    }
    await reapRun(
      run.id,
      run.job.name,
      run.job.id,
      run.job.createdById,
      "Run left PENDING with no corresponding BullMQ job — reaped by the orphan reaper (issue #123), most likely caused by a worker crash between creating the run and enqueuing it.",
      "PENDING",
      redisClient,
      config,
      logger,
      metrics,
    );
  }
}

// Periodic loop, same shape as startSchedulerLoop: setInterval with a
// reentrancy guard (a sweep slow enough to overlap the next tick would
// otherwise double-process the same stale runs) plus tick-result
// metrics, and an immediate first sweep at startup rather than waiting
// out a full interval.
export function startOrphanReaperLoop(
  queue: Queue<RunJobData>,
  config: WorkerConfig,
  logger: Logger,
  metrics: Metrics,
): NodeJS.Timeout {
  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) {
      metrics.orphanReaperTicksTotal.inc({ result: "skipped_reentrant" });
      logger.warn("previous orphan reaper sweep still running, skipping this interval");
      return;
    }
    tickInProgress = true;
    const stopTimer = metrics.orphanReaperTickDuration.startTimer();
    try {
      await runOrphanReaperSweep(queue, config, logger, metrics);
      metrics.orphanReaperTicksTotal.inc({ result: "ok" });
    } catch (err) {
      metrics.orphanReaperTicksTotal.inc({ result: "error" });
      logger.error({ err }, "orphan reaper sweep failed");
    } finally {
      stopTimer();
      tickInProgress = false;
    }
  };

  const interval = setInterval(() => void tick(), config.ORPHAN_REAPER_INTERVAL_MS);
  void tick();
  return interval;
}
