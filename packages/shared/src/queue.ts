// Shared between the API (enqueues "Run Now" manual triggers, §2.1) and
// the Worker (enqueues scheduled runs, and is the only consumer) — one
// definition of the queue name and job payload shape so the two can
// never drift apart. Deliberately doesn't import bullmq here: this
// package has no business depending on a queue library, just agreeing
// on the wire shape.
export const RUNS_QUEUE_NAME = "nexus-scheduler:runs";

export interface RunJobData {
  runId: string;
}
