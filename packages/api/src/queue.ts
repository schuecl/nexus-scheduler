import { Queue, type ConnectionOptions } from "bullmq";
import { RUNS_QUEUE_NAME, type RunJobData } from "@nexus-scheduler/shared";

// The API only ever enqueues here (manual "Run Now" triggers, §2.1); the
// Worker is the sole consumer. Same queue name/payload shape as the
// Worker's scheduled-run enqueueing, imported from shared so the two can
// never drift apart.
export function createRunsQueue(connection: ConnectionOptions): Queue<RunJobData> {
  return new Queue<RunJobData>(RUNS_QUEUE_NAME, { connection });
}
