// Resolves {{placeholder}} substitutions in a Job's custom notification
// subject/body (§61) — same `{{name}}` syntax as promptTemplate.ts, but a
// distinct, smaller set of built-ins scoped to what's known about a run at
// notification time. An unrecognized placeholder is left as-is (matching
// promptTemplate.ts's behavior) rather than erroring, since a typo in a
// custom template shouldn't block the run's actual notification email.
export interface NotificationTemplateContext {
  jobName: string;
  status: string;
  runId: string;
  startedAt: string | null;
  completedAt: string | null;
  output: string | null;
  errorMessage: string | null;
  ownerEmail: string;
  ownerFullName: string;
}

export function renderNotificationTemplate(template: string, context: NotificationTemplateContext): string {
  const now = new Date();
  const values: Record<string, string> = {
    job_name: context.jobName,
    status: context.status,
    run_id: context.runId,
    started_at: context.startedAt ?? "",
    completed_at: context.completedAt ?? "",
    output: context.output ?? "",
    error_message: context.errorMessage ?? "",
    owner_email: context.ownerEmail,
    owner_full_name: context.ownerFullName,
    date: now.toISOString().slice(0, 10),
    datetime: now.toISOString(),
  };

  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => {
    return name in values ? values[name]! : match;
  });
}
