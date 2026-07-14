import { expect, test, type Page } from "@playwright/test";

// Critical-path smoke (issue #48): login → create project → create
// prompt → create job → create schedule → trigger and view a run.
// Runs against the real containerized stack (api/worker/pdf +
// Postgres/Redis); LibreChat is deliberately absent, so agent discovery
// falls back to manual Agent-ID entry, and the triggered run may end
// FAILED once the worker can't reach it — the smoke asserts the run
// EXISTS and is visible with a status, not that the agent call
// succeeds.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@nexus-scheduler.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";

// Unique suffix so reruns against a non-reset database never collide.
const runTag = `e2e-${Date.now().toString(36)}`;

function dialog(page: Page, title: string) {
  return page.getByRole("dialog").filter({ hasText: title });
}

test("critical path: login → project → prompt → job → schedule → run", async ({ page }) => {
  // ---- Login through the real local-auth flow ----
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  // Successful login navigates into the app shell.
  await expect(page.getByRole("button", { name: "Sign in with password" })).toBeHidden();

  // ---- Prerequisite: an API key (Jobs require one) ----
  await page.goto("/api-keys");
  await page.getByRole("button", { name: "New Key" }).click();
  const keyDialog = dialog(page, "New API Key");
  await keyDialog.getByLabel("Label (optional)").fill(`${runTag} key`);
  await keyDialog.getByLabel("LibreChat API key").fill("e2e-not-a-real-key");
  await keyDialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`${runTag} key`)).toBeVisible();

  // ---- Project ----
  await page.goto("/projects");
  await page.getByRole("button", { name: "New Project" }).click();
  const projectDialog = dialog(page, "New Project");
  await projectDialog.getByLabel("Name").fill(`${runTag} project`);
  await projectDialog.getByRole("button", { name: "Create" }).click();
  await page.getByText(`${runTag} project`).click();

  // ---- Prompt ----
  await page.getByRole("button", { name: "New Prompt" }).click();
  const promptDialog = dialog(page, "New Prompt");
  await promptDialog.getByLabel("Name").fill(`${runTag} prompt`);
  await promptDialog.getByLabel("Prompt content").fill("Say hello to {{owner_email}}.");
  await promptDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(`${runTag} prompt`)).toBeVisible();

  // ---- Job (prompt + API key + manually-entered agent id) ----
  await page.getByRole("button", { name: "New Job" }).click();
  const jobDialog = dialog(page, "New Job");
  // The dialog's disabled-Create tooltip ("Name the Job.") also carries
  // an aria-label containing "Name" — target the textbox specifically.
  await jobDialog.getByRole("textbox", { name: "Name", exact: true }).fill(`${runTag} job`);
  await jobDialog.getByRole("combobox", { name: "Prompt", exact: true }).click();
  await page.getByRole("option", { name: `${runTag} prompt` }).click();
  await jobDialog.getByRole("combobox", { name: "API Key" }).click();
  await page.getByRole("option", { name: new RegExp(`${runTag} key`) }).click();
  // No LibreChat behind the stack — discovery fails and the dialog
  // falls back to the manual Agent-ID field.
  await jobDialog.getByLabel("LibreChat Agent ID").fill("agent_e2e_manual");
  await jobDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(`${runTag} job`)).toBeVisible();

  // ---- Schedule (defaults; private project auto-approves) ----
  // The create form is inline inside the "Schedules" manager dialog —
  // clicking New Schedule swaps the button for the form.
  await page.getByRole("button", { name: "Schedules" }).click();
  const scheduleDialog = dialog(page, "Schedules");
  await scheduleDialog.getByRole("button", { name: "New Schedule" }).click();
  await scheduleDialog.getByRole("button", { name: "Create" }).click();
  await expect(scheduleDialog.getByText("APPROVED")).toBeVisible();
  await scheduleDialog.getByRole("button", { name: "Close" }).click();

  // ---- Run: trigger manually, then see it in the history ----
  await page.getByRole("button", { name: "Runs" }).click();
  await page.getByRole("button", { name: "Run Now" }).click();
  const historyDialog = dialog(page, "Run History");
  await expect(historyDialog.getByText("Manual")).toBeVisible({ timeout: 30_000 });
  await expect(
    historyDialog.getByText(/PENDING|RUNNING|SUCCESS|FAILED/).first(),
  ).toBeVisible();
});
