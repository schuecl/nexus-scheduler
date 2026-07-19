// In-app Knowledge Base content (§42). Plain data, not fetched from the
// API — bundled into the SPA so it works fully offline (this app targets
// air-gapped deployments, REQUIREMENTS §3) and ships in lockstep with the
// features it documents. Rendered with the same react-markdown + remark-gfm
// pipeline already used for run output (RunHistoryDialog.tsx), so styling
// stays consistent across the app.
export interface KbArticle {
  slug: string;
  title: string;
  category: "Getting Started" | "Modules" | "Admin" | "Architecture" | "Troubleshooting";
  summary: string;
  content: string;
}

export const KB_ARTICLES: KbArticle[] = [
  {
    slug: "overview",
    title: "What is Nexus Scheduler?",
    category: "Getting Started",
    summary: "What the app does, and why it's useful.",
    content: `
Nexus Scheduler is a web application for **scheduling and managing agentic
AI tasks against a LibreChat Agents API**. Instead of running an agent by
hand every time, you define a reusable prompt, bind it to an agent and a
LibreChat API key as a **Job**, and run it on demand or on a schedule —
with results, cost, notifications, audit logging, and team-based access
control built in.

## Why it's useful

- **Unattended, recurring work.** Daily/weekly reports, monitoring checks,
  batch generation — anything an agent should do on a timer without a
  human kicking it off.
- **Shareable, governed automation.** Prompts and jobs live in shared
  Projects with real access control (§ [Projects & sharing](/help/projects)),
  not "whoever has the script." Schedules shared beyond their owner go
  through an approval step before they run unattended.
- **Full visibility.** Every run's output, timing, token usage, and cost is
  stored and viewable — nothing runs silently in the background with no
  record.
- **Built for a regulated environment.** Classification banners, an audit
  trail, SSO/OIDC, and an entirely offline-capable deployment model.

## Where to go next

- New here? Start with the [Quickstart](/help/quickstart).
- Want the vocabulary first? See [Core concepts & glossary](/help/concepts).
- Looking for a specific screen? Every module has its own article — see the
  Knowledge Base index.
`,
  },
  {
    slug: "quickstart",
    title: "Quickstart: your first scheduled job",
    category: "Getting Started",
    summary: "The shortest path from nothing to a running schedule.",
    content: `
This walks through the minimum steps to get an agent running on a
schedule, in the order you'll actually do them.

## 1. Add an API key

Go to **API Keys** and add your LibreChat API key. This is what lets Nexus
Scheduler call LibreChat's Agents API on your behalf. Keys are stored
encrypted, and can be personal (yours only) or owned by a Team you belong
to. See [API Keys](/help/api-keys).

**Where the key comes from:** in LibreChat, open **Settings → API Keys**
and create one — you get a durable \`sk-…\` token, shown once. That is
the value to paste here. (A login token/JWT from your browser session is
**not** an API key: the Agents API rejects it. Access tokens expire after
15 minutes by default, though LibreChat deployments can configure this.)

## 2. Create a Project

Go to **Projects** and create one. A Project is just a shared container
for related prompts and jobs — private to you by default. See
[Projects & sharing](/help/projects).

## 3. Create a Prompt

Inside the Project, create a **Prompt** — a name and the text you want the
agent to receive. **This step doesn't need an API key at all** — a Prompt
is just saved text. See [Prompt Library & saved prompts](/help/prompts).

## 4. Create a Job

Still inside the Project, create a **Job**: pick the Prompt, pick an agent
(discovered automatically once an API key is selected), pick the API key
to run under, and set a timeout/retry policy if the defaults don't fit.
**This is the step that needs an API key** — without one selected, the
agent list stays empty. See [Jobs, notifications & webhooks](/help/jobs).

## 5. Run it, or schedule it

- Click **Run Now** to fire it immediately and see the result right away —
  good for testing a prompt/agent pairing before trusting it to a
  schedule.
- Or add a **Schedule**: one-time, or recurring (every N minutes/hours,
  specific days of the week, etc.), in an explicit time zone. If the
  Project is shared, the schedule needs approval before it goes live. See
  [Schedules & approvals](/help/schedules).

## 6. Check the result

Open the run from **Runs** (or the Dashboard) to see its output, status,
token usage, and cost, and to download a PDF if you want one. See
[Runs, output & PDF reports](/help/runs).

That's the whole loop. Everything else — Teams, webhooks, custom
notification emails, admin settings — layers on top of this once you need
it.
`,
  },
  {
    slug: "concepts",
    title: "Core concepts & glossary",
    category: "Getting Started",
    summary: "How Projects, Prompts, Jobs, Schedules, and Runs relate.",
    content: `
Nexus Scheduler has a handful of interrelated concepts. Once these click,
the rest of the app is mostly just forms.

## The mental model

A **Project** contains **Prompts** and **Jobs**. A **Job** pairs one Prompt
with one agent and one API key. A **Schedule** says when a Job runs. Every
time it fires (or you click Run Now), that's a **Run**.

\`\`\`
Project
├── Prompt   (reusable text, with {{variables}}, versioned)
├── Prompt
└── Job      (Prompt + agent + API key + timeout/retries)
    └── Schedule   (when it fires: one-time / recurring)
        └── Run    (one execution: output, status, cost)
\`\`\`

## Glossary

- **Project** — a shared workspace grouping related Prompts and Jobs.
  Private by default; can be shared read/edit with specific users, Teams,
  or everyone.
- **Prompt** — a saved, reusable block of text sent to the agent, with
  optional \`{{variable}}\` placeholders. Every edit creates a new
  **version**; old versions stay viewable and a Job/Schedule can pin to a
  specific version or always track the latest.
- **Agent** — a LibreChat agent (identified by an agent ID) that actually
  processes the prompt via LibreChat's Agents API.
- **API Key** — your (or your Team's) credential for calling LibreChat.
  Stored encrypted. Required for Jobs; not required for Prompts.
- **Job** — a Prompt bound to an agent, an API key, and execution settings
  (timeout, max retries). The unit you actually run or schedule.
- **Schedule** — when a Job fires: one-time at a specific date/time, or
  recurring (every N minutes/hours, specific days of week, etc.) in an
  explicit time zone. Can be paused/resumed without losing history.
- **Run** — one execution of a Job, whether triggered by a schedule or
  Run Now. Has a status (\`PENDING\`/\`RUNNING\`/\`SUCCESS\`/\`FAILED\`/
  \`CANCELLED\`/\`SKIPPED\`), the agent's output, timing, token usage, and
  computed cost.
- **Team** — a local (not OIDC-sourced) grouping of users, used only for
  sharing Projects and API keys — not for permissions/roles. Teams can
  nest; membership in a parent Team includes all its sub-Teams.
- **Role** — your system-wide permission level: **Admin**, **Editor**, or
  **View**. Separate from Teams entirely. See
  [Admin settings](/help/admin) for what each role can do.
- **ACL (access control)** — the read/edit grants on a Project: to a
  specific user, a Team, or everyone.
- **Approval** — the maker-checker step a schedule needs before it goes
  live, if it lives in a Project shared beyond its owner.
`,
  },
  {
    slug: "dashboard",
    title: "Dashboard",
    category: "Modules",
    summary: "Run counts, recent activity, and upcoming schedules at a glance.",
    content: `
The Dashboard is the landing page — a quick summary of activity across
every Project you can see.

## What's on it

- **Run counts by status** — how many runs are \`SUCCESS\`, \`FAILED\`,
  \`RUNNING\`, and \`PENDING\` right now.
- **Recent runs** — the latest runs across your Projects, with a link into
  each one's detail view.
- **Upcoming schedules** — approved, unpaused schedules due to fire soon.

It's read-only and scoped to the same Projects you can otherwise see — the
Dashboard never shows activity from a Project you don't have access to.

If it looks empty, that usually means you don't have any Projects yet, or
none of your Jobs have run — see the [Quickstart](/help/quickstart).
`,
  },
  {
    slug: "projects",
    title: "Projects & sharing",
    category: "Modules",
    summary: "Organizing and sharing Prompts and Jobs.",
    content: `
A **Project** is a shared container for related Prompts and Jobs. It's the
unit of access control — you don't share an individual Prompt or Job,
you share the Project it lives in.

## Creating a Project

Give it a name. It's **private** (visible only to you) by default. If your
deployment uses classification labels, a default label may be applied
automatically — you can change it if you have an appropriate label
available.

## Sharing a Project

As the owner (or with OWNER-level access), you can grant access to:

- **A specific user** — read or edit.
- **A Team** — read or edit, inherited by every member (including nested
  sub-Team members). See [Teams](/help/teams).
- **Everyone** (org-wide) — read or edit for every authenticated user.

**Read** access lets someone view and run/copy what's in the Project.
**Edit** access lets them create and modify Prompts and Jobs in it, and
approve schedule changes.

## Ownership

A Project has exactly one owner. Ownership can be **transferred** to
another user (e.g. before the current owner leaves). The owner (and any
Team/user with EDIT) can revoke or change access grants at any time.

## Deleting a Project

Deleting a Project deletes everything in it — its Prompts, Jobs, and
Schedules, and their run history. This can't be undone, so the UI asks for
confirmation first.

## Why sharing here matters

Sharing a Project is what turns a personal script into governed team
automation: everyone with access sees the same Prompts and Jobs, edits are
versioned, and a schedule that goes live in a shared Project needs a
second person to approve it first — see
[Schedules & approvals](/help/schedules).
`,
  },
  {
    slug: "prompts",
    title: "Prompt Library & saved prompts",
    category: "Modules",
    summary: "Reusable prompt templates, versioning, and variables.",
    content: `
A **Prompt** is a saved, reusable piece of text sent to an agent as part of
a Job. **Creating a Prompt only needs a Project — no API key required.**
(An API key is needed when you build a *Job* from it — see
[Jobs, notifications & webhooks](/help/jobs).)

## Creating a Prompt

Inside a Project, add a Prompt with a name and its content. That's it —
nothing here talks to LibreChat yet.

## Versioning

Every edit to a Prompt's content creates a new **version**. Older versions
stay viewable, and you can revert to one. This matters because a Job or
Schedule references a *specific* version, not "whatever the Prompt
currently says" — so editing a shared Prompt never silently changes what
an already-running schedule does. When creating or editing a Schedule, you
choose whether it should:

- **pin** to the version in effect right now, or
- **always use the latest version** of the Prompt.

## Variables

A Prompt can contain \`{{variable}}\` placeholders, resolved when a Job
actually runs:

- **Built-in variables** are filled in automatically: \`{{date}}\`,
  \`{{datetime}}\`, \`{{schedule_name}}\`, \`{{run_id}}\`, and the owner's
  name/email.
- **Your own variables** — declare a name, type (text/number/date), and a
  default value on the Prompt. A Job built from it can override the
  default per-schedule.

This lets one shared Prompt serve many contexts instead of near-duplicate
copies with one word changed.

## Finding prompts (Prompt Library)

The **Prompt Library** page is a searchable browse view across every
Prompt you have access to — filter by tag, owner, or Team, and sort by
most-used or recently updated. Prompts (and Projects) can be tagged with
free-text tags to make this useful once you have more than a handful.
`,
  },
  {
    slug: "jobs",
    title: "Jobs, notifications & webhooks",
    category: "Modules",
    summary: "Binding a Prompt to an agent and API key, plus how you hear about results.",
    content: `
A **Job** is what actually runs: a Prompt, bound to a LibreChat agent and
an API key, with its own timeout and retry settings. Jobs live inside a
Project, alongside the Prompts they use.

## Creating a Job

You need, in order:

1. **A Prompt** already saved in the Project.
2. **An API key** — pick yours or, if the Project is Team-shared, a
   Team's key. **This is the step that needs a key** — the agent picker
   stays empty until one is selected.
3. **An agent** — discovered automatically from the selected API key
   (falls back to typing an agent ID manually if discovery isn't
   available).
4. Optionally, a **timeout** (default 10 minutes, admin-configurable
   ceiling) and **max retries** (default 2, with exponential backoff —
   only for transient failures like a network error or a 5xx; a bad
   request or invalid key is never retried).

## Running it

- **Run Now** fires an immediate, one-off execution — useful for testing
  before trusting a Job to a recurring schedule. It's recorded in run
  history just like a scheduled run, tagged as manual.
- Or attach a **Schedule** — see [Schedules & approvals](/help/schedules).

## Email notifications

Per Job, you can turn on an email when a run succeeds and/or fails:

- Sent to the **Job owner**, plus up to **10 additional recipients** you
  list.
- Optionally **attach a PDF report** of the run instead of inline text.
- Optionally set a **custom subject and body** instead of the default —
  supports \`{{job_name}}\`, \`{{status}}\`, \`{{run_id}}\`,
  \`{{started_at}}\`, \`{{completed_at}}\`, \`{{output}}\`,
  \`{{error_message}}\`, \`{{owner_email}}\`, \`{{owner_full_name}}\`,
  \`{{date}}\`, and \`{{datetime}}\`. The custom body is written as
  Markdown and rendered properly in the email — useful for a report aimed
  at a specific audience (e.g. a daily summary for a manager) rather than
  a generic "Job X — SUCCESS" alert.

## Webhooks

A Job can also \`POST\` its result (status, output, timing, run ID) to an
internal system on completion and/or failure. For security, webhook
destinations aren't arbitrary URLs — they're chosen from an
**admin-maintained allow-list** (see [Admin settings](/help/admin)), and
payloads are signed (HMAC) so the receiver can verify they're genuine.
`,
  },
  {
    slug: "schedules",
    title: "Schedules & approvals",
    category: "Modules",
    summary: "When a Job runs, and the maker-checker approval step for shared schedules.",
    content: `
A **Schedule** says when a Job runs on its own, without you clicking Run
Now. (This module is labeled **Approvals** in the navigation, since that's
often the reason you're there — but it's where all schedules, pending or
active, live.)

## Types

- **One-time** — fires once at a specific date and time.
- **Recurring** — every N minutes/hours, or on specific days of the week
  at a time of day. Every schedule has an explicit **time zone**; times
  are also shown converted to your browser's local time zone for
  convenience.

## Pause / resume

A schedule can be paused without deleting it or losing its run history —
useful for "stop this while I'm out" without having to recreate it later.

## Missed runs

If the scheduler is down across a fire time, that occurrence is
**skipped**, not caught up later — you won't get a burst of stale runs
after an outage. A skipped fire still shows up in history as \`SKIPPED\`
for visibility.

## Approval workflow (shared schedules only)

A schedule in a Project shared with anyone else must be **approved**
before it goes live, and again after a substantive edit (target agent,
prompt/version, or timing — a description-only edit doesn't need
re-approval). This is a deliberate second set of eyes before an unattended
recurring task starts running.

- **Eligible approvers**: the Project owner, or anyone with EDIT access —
  excluding whoever made the change, unless they're the Project's only
  owner with no other collaborators (in which case self-approval is
  allowed, so a single-owner Project isn't stuck).
- **Admins** can always approve directly.
- Pending schedules sit in a visible approval queue; approving or
  rejecting is logged, and the requester is notified either way.
- **Private schedules never need approval** — only ones shared beyond
  their owner.
`,
  },
  {
    slug: "runs",
    title: "Runs, output & PDF reports",
    category: "Modules",
    summary: "Viewing what happened, and exporting it as a PDF.",
    content: `
A **Run** is one execution of a Job — whether it fired from a Schedule or
you clicked Run Now.

## Status

A run moves through \`PENDING\` → \`RUNNING\` → a terminal state:
\`SUCCESS\`, \`FAILED\`, \`CANCELLED\` (stopped mid-flight), or \`SKIPPED\`
(a missed schedule fire, never actually attempted).

## What you can see

- The agent's full output, rendered as Markdown.
- Timing: started/completed timestamps and duration.
- **Token usage and cost** — prompt/completion token counts from
  LibreChat's response, and a cost computed from admin-configured
  per-token rates (§ [Admin settings](/help/admin)). Runs from before any
  rate was configured show as "not costed" rather than a wrong number.
- The error message, for a failed run.

## Cancelling

A \`PENDING\` or \`RUNNING\` run can be cancelled by anyone with EDIT access
to its Project — the same access Run Now itself requires. A queued run is
stopped before it ever reaches the agent; an in-flight one has its request
to LibreChat aborted. Either way it's marked \`CANCELLED\`, which fires the
same webhook/notification delivery a completed or failed run would.

## PDF export

Any run can be downloaded as a formatted PDF report (job name, run
metadata, and the full output), on demand from the run's detail view — the
same PDF a Job's completion email can optionally attach automatically. PDFs
carry the same branding and classification banner as the web UI.
`,
  },
  {
    slug: "teams",
    title: "Teams",
    category: "Modules",
    summary: "Local groupings of users for sharing — not permissions.",
    content: `
A **Team** is a group of users, managed entirely inside Nexus Scheduler —
not synced from your SSO provider. Teams exist for exactly one purpose:
**sharing** Projects and API keys with a group instead of one person at a
time.

## What Teams are *not*

Teams are **not** your role/permission system. Whether you're an Admin,
Editor, or Viewer is decided by your account role (or your SSO group
mapping), completely separately from any Team you belong to. Being on a
Team doesn't change what you're allowed to do in general — it changes
*which Projects and keys you can see*, because a Project or API key was
shared with your Team.

## Nesting

A Team can have sub-Teams. Membership is inherited downward: if you're a
member of a parent Team, you're automatically treated as a member of every
Team beneath it for sharing purposes.

## Team-owned API keys

In addition to personal keys, a Team can hold its own LibreChat API key,
enterable by any member with edit rights on the Team. A Job in a
Team-shared Project can run under the **Team's** key instead of its
creator's personal one — so shared automation keeps working if the person
who set it up leaves the Team or rotates their own key. Team keys are
detected as expired/revoked and paused the same way personal keys are; the
notification goes to the Team's editors instead of one person.

## Managing a Team

A Team owner (or an admin) can rename it, manage its membership, and
create/adjust sub-Teams.
`,
  },
  {
    slug: "api-keys",
    title: "API Keys",
    category: "Modules",
    summary: "Your LibreChat credential — required for Jobs, not for Prompts.",
    content: `
An **API Key** is what Nexus Scheduler uses to call LibreChat's Agents API
on your behalf. It's created on the LibreChat side and entered here.

## Creating one in LibreChat

LibreChat **Settings → API Keys → Create** mints a durable \`sk-…\`
token (also available programmatically: \`POST /api/api-keys\` with a
logged-in session). Copy it when shown — LibreChat doesn't display it
again. Do **not** paste a browser login token/JWT: the Agents API
rejects those. Access tokens expire after 15 minutes by default, though
LibreChat deployments can configure this.

## Personal vs. Team keys

- A **personal** key belongs to you and is only usable in your own Jobs
  (or Jobs you create in a Project, using your key).
- A **Team** key belongs to a Team you have edit rights on, and can be used
  by any Job in a Project that Team has access to — see
  [Teams](/help/teams) for why that matters for shared automation.

## Storage

Keys are stored **encrypted at rest** — never in plain text, and never
shown again in full once saved (only revealed once, at creation).

## Expiration & revocation

If LibreChat rejects a key (expired, revoked), Nexus Scheduler detects the
failure, marks the key invalid, and **pauses** — rather than silently
failing — any schedules depending on it, notifying the owner (personal
key) or the Team's editors (Team key). Add a replacement key and re-enable
the affected schedules once it's working again.

## Why a Job needs one, but a Prompt doesn't

A **Prompt** is just saved text — no key required to create or edit one. A
**Job** is what actually calls LibreChat, so it needs a key selected
before the agent list will even populate. If you're stuck on an empty
agent picker while creating a Job, this is almost always why — see
[Jobs, notifications & webhooks](/help/jobs) and
[Troubleshooting & FAQ](/help/troubleshooting).
`,
  },
  {
    slug: "admin",
    title: "Admin settings",
    category: "Admin",
    summary: "Branding, SMTP, syslog, users & roles, cost rates, classification labels, webhooks.",
    content: `
The **Admin** page (visible only to Admin-role users) is a single page of
independent settings panels.

## Branding & appearance

Product name, logo, and primary color — shown throughout the UI and on
generated PDFs, changeable without a rebuild. Also where the system-wide
**classification banner** (fixed at the top/bottom of every page, for
deployments that need one) and its colors are set. This banner is
independent of, and never affected by, per-object classification labels
below.

## SMTP

Host, port, TLS, authentication, and from-address for all outbound email —
job notifications, password resets, and recurring usage reports all use
this one configuration.

## Syslog / SIEM forwarding

Optionally mirror the audit trail to an external syslog server (with TLS
support), for deployments that centralize logging in a SIEM.

## Recurring usage reports

Configure a recurring (weekly/monthly) usage-summary PDF — run counts,
success/failure rates, token usage, cost — emailed to a list of
recipients, over the same SMTP configuration above. On-demand export
doesn't require this to be turned on.

## Users & roles

Manage user accounts and their role — **Admin**, **Editor**, or **View**:

- **Admin** — everything, including this page.
- **Editor** — create/edit Jobs, Schedules, Projects, Prompts, and manage
  their own API key connections.
- **View** — read-only: can see and copy shared Prompts/Projects, view
  run history and audit logs, but can't create schedules or run jobs.

Roles are separate from Teams entirely (see [Teams](/help/teams)) — a Team
is about sharing, a role is about what you're allowed to do at all.

## Cost rates

Set the internal per-token cost rate (prompt vs. completion tokens) used
to compute each run's cost — a global default, with optional per-agent
overrides. Rates apply going forward only: changing a rate never rewrites
the cost already recorded on past runs.

## Classification labels

Define the ordered list of classification labels available in this
deployment (text, abbreviation, badge colors) for tagging Projects and
Prompts. This is separate from the system-wide banner above — labels mark
individual objects; the banner marks the whole deployment.

## Webhook destinations

Maintain the allow-list of internal endpoints a Job's webhook delivery can
target (see [Jobs, notifications & webhooks](/help/jobs)) — destinations
aren't arbitrary user-supplied URLs, precisely so a Job can't be used to
exfiltrate data to an unapproved endpoint. Includes a test-send button and
signing-secret rotation.
`,
  },
  {
    slug: "architecture",
    title: "Architecture: live system map",
    category: "Architecture",
    summary: "Which components are set up, and which connections are working right now.",
    content: `
This page answers "which components are set up, and which connections are
working right now" — normally something you'd have to piece together from
compose files, Helm values, and logs. The live diagram above this text
(rendered by the app, not part of this article) shows every component this
deployment actually depends on and whether it's currently reachable.

## How it's determined

Two different mechanisms feed the same diagram, because reachability isn't
always knowable from one side:

- **Postgres, Redis, and the PDF service** are probed directly by the API
  on every page load — there's exactly one true status per link, so the
  API checking it once is enough.
- **LibreChat**, and the Worker's own liveness, can only be checked by the
  Worker itself (nothing else in this app calls LibreChat directly). The
  Worker publishes what it finds to Redis every 30 seconds with a short
  expiry. If the Worker crashes, is restarted, or is scaled to zero, that
  published status simply expires — the diagram shows **"No recent
  report"** rather than a stale last-known-good value that might no longer
  be true.

## Reading the colors

- **Green** — reachable right now.
- **Red** — configured, but the last check failed.
- **Grey ("No recent report")** — no reachability data has arrived
  recently. For the Worker-reported components, this almost always means
  the Worker process itself isn't currently running or hasn't completed a
  publish cycle yet, not that LibreChat is actually down.

## What isn't on this map yet

This is deliberately scoped to the components this deployment actually
talks to today. A model gateway (e.g. LiteLLM) sitting behind LibreChat,
and an OCR pipeline, are both planned but not yet wired into the app as
direct dependencies — see the open architecture work for where those
stand before expecting to see them here.
`,
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting & FAQ",
    category: "Troubleshooting",
    summary: "Common mix-ups and what's actually going on.",
    content: `
## "I can't create a Prompt — do I need an API key first?"

No. A Prompt only needs a **Project** and a name/content — see
[Prompt Library & saved prompts](/help/prompts). API keys are needed when
you build a **Job** from a Prompt, not for the Prompt itself.

## "The agent list is empty when I'm creating a Job"

Select (or add) an **API key** first — the agent picker is populated by
asking LibreChat which agents that key can use, so it stays empty until a
key is chosen. See [API Keys](/help/api-keys).

## "My test email / syslog / webhook test-send fails"

Save the relevant settings (SMTP, syslog, or the webhook destination)
before using its test-send button — a test-send uses whatever is currently
saved, not what's typed into the form but not yet submitted.

## "My schedule shows SKIPPED instead of running"

That means the scheduler was down across that particular fire time, and
missed fires are deliberately not caught up afterward (to avoid a burst of
stale runs) — the schedule will fire normally at its next regular
occurrence. See [Schedules & approvals](/help/schedules).

## "My schedule is stuck waiting for approval"

Schedules in a Project shared with anyone besides you need approval before
they go live (and again after a substantive edit). Ask another user or
Team with edit access on that Project to approve it, or an admin — see
[Schedules & approvals](/help/schedules).

## "A run's cost shows as 'not costed'"

That run happened before an admin configured a cost rate for that agent
(or a global default rate). Costs are computed at run time using whatever
rate was in effect then, and are never recalculated retroactively once a
rate is added or changed later.

## "My API key stopped working and schedules paused themselves"

That's intentional, not a bug — Nexus Scheduler detected LibreChat
rejecting the key (expired or revoked) and paused schedules that depend on
it rather than letting them keep failing silently. Add a working
replacement key, then re-enable the paused schedules. See
[API Keys](/help/api-keys).
`,
  },
];

export function findKbArticle(slug: string): KbArticle | undefined {
  return KB_ARTICLES.find((a) => a.slug === slug);
}
