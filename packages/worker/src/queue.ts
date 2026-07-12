import { Queue, type ConnectionOptions } from "bullmq";

export const RUNS_QUEUE_NAME = "nexus-scheduler:runs";

export interface RunJobData {
  runId: string;
}

export function createRunsQueue(connection: ConnectionOptions): Queue<RunJobData> {
  return new Queue<RunJobData>(RUNS_QUEUE_NAME, { connection });
}
