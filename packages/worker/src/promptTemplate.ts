// Resolves {{variable}} placeholders in a saved prompt at execution time
// (REQUIREMENTS.md §2.3). Built-ins are always available; declared
// variables fall back to their default value.
//
// TODO: per-run/per-schedule variable *overrides* (a user filling in a
// value when creating a schedule) aren't modeled yet — this only
// resolves built-ins and declared defaults.
export function renderPromptTemplate(
  content: string,
  context: { scheduleName?: string; runId: string },
  declaredVariables: Array<{ name: string; defaultValue?: string }>,
): string {
  const now = new Date();
  const builtins: Record<string, string> = {
    date: now.toISOString().slice(0, 10),
    datetime: now.toISOString(),
    schedule_name: context.scheduleName ?? "",
    run_id: context.runId,
  };

  const values: Record<string, string> = { ...builtins };
  for (const variable of declaredVariables) {
    if (!(variable.name in values)) {
      values[variable.name] = variable.defaultValue ?? "";
    }
  }

  return content.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => {
    return name in values ? values[name]! : match;
  });
}
