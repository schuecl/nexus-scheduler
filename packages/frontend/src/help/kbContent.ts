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
internal system on completion and/or failure. For the payload format,
signature verification, and retry behaviour, see
[Webhooks: setup, payload & verifying signatures](/help/webhooks).
For security, webhook
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

Full walkthrough, message format, and transport trade-offs:
[Syslog & SIEM forwarding](/help/syslog).

Optionally mirror the audit trail to an external syslog server (with TLS
support), for deployments that centralize logging in a SIEM.

## Recurring usage reports

Configure a recurring (weekly/monthly) usage-summary PDF — run counts,
success/failure rates, token usage, cost — emailed to a list of
recipients, over the same SMTP configuration above. On-demand export
doesn't require this to be turned on. See
[Usage, cost & reporting](/help/usage-cost).

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
the cost already recorded on past runs. See
[Usage, cost & reporting](/help/usage-cost).

## Consent banner

Show a notice on the login page — a consent-to-monitor statement,
acceptable-use notice, or classification warning — optionally requiring
explicit acceptance before the sign-in form appears, with acceptance
audit-logged. See [Login consent banner](/help/consent-banner).

## Classification labels

Define the ordered list of classification labels available in this
deployment (text, abbreviation, badge colors) for tagging Projects and
Prompts. This is separate from the system-wide banner above — labels mark
individual objects; the banner marks the whole deployment.

## Webhook destinations

Setup walkthrough and what receivers must do:
[Webhooks: setup, payload & verifying signatures](/help/webhooks).

Maintain the allow-list of internal endpoints a Job's webhook delivery can
target (see [Jobs, notifications & webhooks](/help/jobs)) — destinations
aren't arbitrary user-supplied URLs, precisely so a Job can't be used to
exfiltrate data to an unapproved endpoint. Includes a test-send button and
signing-secret rotation.
`,
  },
  {
    slug: "architecture",
    title: "Architecture & data flow",
    category: "Architecture",
    summary: "How the components fit together and who talks to whom.",
    content: `
This article documents the system's shape: which components exist, who
talks to whom, and why. It is deliberately **static** — documentation for
understanding, not monitoring. Live reachability ("is Redis up right
now") is operational data owned by platform admins: see **Admin → System
Map** in this app, and the Grafana dashboards for history and alerting.

## Component flow

\`\`\`mermaid
flowchart TB
  Browser --> Nginx[nginx] --> API
  API -->|"jobs, runs, audit"| PG[(Postgres)]
  API -->|enqueue runs| R[(Redis)]
  API -->|report downloads| PDF[PDF Service]
  W[Worker] -->|"pick up runs, cancel flags,<br/>status publish"| R
  W -->|"runs, audit, extracted text"| PG
  W -->|"email report PDFs"| PDF
  W -->|agent calls| LC[LibreChat]
  W -->|job-attachment OCR| OCR[OCR Service]
  LC -->|"chat uploads (built-in OCR config)"| OCR
  LC -->|model calls| LL[LiteLLM] --> OL[Ollama]
\`\`\`

## Who talks to whom, and why

- **nginx** is the single entry point: TLS termination and body-size
  limits, proxying to the API and the frontend bundle.
- The **API** owns Postgres (jobs, runs, audit trail), enqueues runs into
  Redis, and calls the PDF service for on-demand report downloads. It
  never calls LibreChat or the OCR service itself.
- The **Worker** picks runs up from Redis, extracts job attachments
  through the **OCR service** (the text goes into the agent prompt; the
  searchable PDF is kept as a run artifact), then calls **LibreChat**'s
  Agents API to execute the run. It writes results and audit events back
  to Postgres and renders email-report PDFs via the PDF service.
- **LibreChat** routes model calls through **LiteLLM** (the gateway that
  owns keys, quotas, and model routing) to **Ollama**. Chat uploads use
  the same OCR service via LibreChat's built-in OCR support — so both
  doors, scheduler jobs and ad-hoc chat, share one OCR pipeline.
- The **OCR service** and the model plane have no egress: everything
  above runs air-gapped.

## Two doors into OCR

| | Scheduler job | LibreChat chat |
|---|---|---|
| Files per request | up to 10, 50MB total | up to 10 per message, 15MB each |
| Results kept | extracted text + searchable PDF on the run (auditable) | conversation only |
| Best for | recurring/batch document work | quick ad-hoc questions |

Details, setup, and troubleshooting: see **Document OCR & attachments**
in this Knowledge Base.
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
  {
    slug: "webhooks",
    title: "Webhooks: setup, payload & verifying signatures",
    category: "Modules",
    summary: "Send run results to another system, and prove the request really came from Nexus Scheduler.",
    content: `
When a run reaches a terminal state, Nexus Scheduler can POST the result
to a URL you control — a ticketing system, a chat bridge, your own
service. Every delivery is **HMAC-signed**, so the receiver can prove it
came from here and was not tampered with in transit.

## 1. An admin adds the destination

Webhook URLs are **admin-managed on purpose**. Anyone able to point a
webhook anywhere could use this app to reach internal services it can see
and they cannot. So the destination list *is* the allow-list, and Job
owners choose from it rather than typing URLs.

**Admin → Webhook destinations → New**:

| Field | Notes |
|---|---|
| Name | What Job owners see in the picker |
| URL | Where deliveries are POSTed |
| Extra headers | Optional. Merged into every delivery — e.g. an auth token the receiver expects |
| Notify on Success / Failure / Cancelled | Which run outcomes this destination receives |
| Active | Inactive destinations deliver nothing and disappear from the Job picker |

Two things to know:

- **The outcome toggles live on the destination, not the Job.** A
  "success-only" destination stays success-only for every Job attached to
  it. This is separate from a Job's *email* notification settings, which
  have their own Success/Failure switches.
- \`Content-Type\` and \`X-Nexus-Signature\` **cannot be overridden** by
  the extra-headers map — the sender fixes both.

Saving returns the **HMAC secret in plaintext exactly once**. Copy it
then and hand it to whoever operates the receiving endpoint; it is never
shown again. If it is lost or leaked, use **Rotate secret** — which also
shows the new value only once.

Use **Send test** to fire a sample delivery before wiring up a Job.

## 2. A Job owner attaches it

Open the Job → **Webhooks** and tick the destinations you want. A Job
with nothing ticked sends nothing.

## 3. What arrives

\`POST\` to your URL, \`Content-Type: application/json\`:

| Header | Value |
|---|---|
| \`X-Nexus-Signature\` | \`sha256=<hex>\` — HMAC-SHA256 of the **raw request body**. Note the \`sha256=\` prefix; it is part of the value |

\`\`\`json
{
  "runId": "3f8a1c92-5d4e-4b7a-9c31-0e2f6a8b4d15",
  "jobId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "jobName": "Nightly incident summary",
  "status": "SUCCESS",
  "startedAt": "2026-07-20T02:00:04.812Z",
  "completedAt": "2026-07-20T02:01:37.106Z",
  "output": "## Summary\\n\\nThree incidents were opened overnight...",
  "errorMessage": null
}
\`\`\`

\`status\` is one of \`SUCCESS\`, \`FAILED\`, \`CANCELLED\` — only terminal
states are ever delivered. On a failure \`output\` is typically \`null\`
and \`errorMessage\` carries the reason.

The payload is **metadata plus the run's output only**. Text extracted
from attachments by OCR is deliberately not included, so a webhook cannot
become a side channel for document contents.

## 4. Verifying the signature

Strip the \`sha256=\` prefix, compute HMAC-SHA256 over the **raw body
bytes** — not a re-serialized object, or whitespace differences change
the digest — and compare **in constant time**.

\`\`\`js
import crypto from "node:crypto";

// express: app.use(express.raw({ type: "application/json" }))
function verify(rawBody, headerValue, secret) {
  const received = (headerValue ?? "").replace(/^sha256=/, "");
  const expected = crypto.createHmac("sha256", secret)
                         .update(rawBody)
                         .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
\`\`\`

Reject anything that does not match: either the wrong secret or a
modified body. Treat both as hostile.

## What to expect operationally

- **Delivery never affects the run.** A receiver that is down, slow, or
  erroring does not fail the Job, does not re-run it, and does not change
  the stored result.
- **10-second timeout** per attempt, with **two short retries** (about 2s
  then 5s later). This covers a brief blip, not an outage — there is no
  long-tail retry queue, so a receiver down for minutes loses those
  deliveries.
- Make your receiver **idempotent on \`runId\`**: a response we never saw
  (timeout after you processed it) is retried.
- Delivery outcomes are **audit-logged**, so a receiver that quietly
  stopped accepting shows up in the audit trail.

## Troubleshooting

| Symptom | Usual cause |
|---|---|
| Nothing arrives | The destination is not ticked on the Job, is inactive, or its outcome toggle for that status is off |
| Signature never matches | Comparing against the full \`sha256=…\` value, or hashing a re-serialized body instead of the raw bytes |
| Lost the secret | **Rotate secret** — the old one stops working immediately |
| Duplicate deliveries | A retry after a timeout. De-duplicate on \`runId\` |
| Receiver sees no auth header | Extra headers are set per destination by an admin, not per Job |

See also [Jobs, notifications & webhooks](/help/jobs).
`,
  },

  {
    slug: "syslog",
    title: "Syslog & SIEM forwarding",
    category: "Admin",
    summary: "Mirror the audit trail to a SIEM over UDP, TCP, or TCP+TLS, and what the messages look like.",
    content: `
Every audit event — logins, permission changes, schedule approvals, run
completions — is stored in Postgres. Syslog forwarding **mirrors** those
same events to a SIEM as they happen. It is a mirror, not a move: turning
it off loses nothing from the in-app audit trail.

## Configuring it

**Admin → Syslog**:

| Field | Notes |
|---|---|
| Enabled | Off by default |
| Host | Hostname or IP. Anything resolvable from the app — not just localhost |
| Port | Conventionally 514 (UDP), 601 (TCP), 6514 (TCP+TLS) — any port works |
| Transport | UDP or TCP |
| Use TLS | TCP only (RFC 5425). Not available over UDP |
| CA certificate | Upload when the receiver's certificate chains to a private CA |

**Test connection** sends a real message before you save. Use it — a
wrong port on UDP fails silently forever otherwise, because UDP has no
acknowledgement.

Choosing a transport:

- **UDP** — fire-and-forget. Lowest overhead, no delivery guarantee, and
  a message larger than the network's limit is simply lost.
- **TCP** — acknowledged, and long messages are framed correctly
  (RFC 6587 octet-counting), so nothing is truncated mid-event.
- **TCP + TLS** — the same, encrypted. Use this if the audit trail
  crosses any untrusted network.

## What a message looks like

RFC 5424, facility \`local0\`, with the structured data a SIEM can index
on rather than regex out of a text blob:

\`\`\`
<134>1 2026-07-20T02:01:37.106Z nexus-01 nexus-scheduler-worker 42 run.complete [nexusAudit@32473 eventId="9c1f..." actorType="SERVICE" actorEmail="system:scheduler" targetType="run" targetId="3f8a1c92..." result="SUCCESS" correlationId="3f8a1c92..."] run.complete success (actor=system:scheduler, target=run:3f8a1c92...)
\`\`\`

Reading the header: \`<134>\` is facility 16 (local0) × 8 + severity 6;
\`1\` is the syslog version; then timestamp, hostname, **APP-NAME**
(\`nexus-scheduler-api\` or \`-worker\`, so you can tell which service
emitted it), PID, and **MSGID** — the audit action itself, e.g.
\`run.complete\`, \`user.login\`, \`schedule.approve\`.

Severity is meaningful, not fixed:

| Severity | When |
|---|---|
| 4 — warning | The action **failed** |
| 5 — notice | Security-relevant categories (auth, permissions) |
| 6 — informational | Everything else |

That distinction is the one signal a SIEM can alert on without parsing
the message body, so a failed login does not blend in with a successful
read.

\`SD-ID\` is \`nexusAudit@32473\`. That enterprise number is IANA's
documentation/example PEN — if your SIEM cares about enterprise-ID
uniqueness, substitute your organization's registered PEN.

## What to expect

- Forwarding is **best-effort**: a syslog receiver being down never fails
  a user action or a run. The event is still written to the database.
- Oversized messages are truncated to stay within limits rather than
  dropped.
- The audit trail in the app remains the system of record.

## Testing it locally

The Compose stack includes a \`syslog-test\` receiver with three
listeners — \`514\`/UDP, \`601\`/TCP, and \`6514\`/TCP+TLS. Point Admin →
Syslog at host \`syslog-test\`, pick a port, and watch delivered messages
with \`docker compose logs -f syslog-test\`. For the TLS listener, upload
\`docker/generated/syslog-test-certs/ca.pem\` as the CA certificate.

See also [Admin settings](/help/admin).
`,
  },

  {
    slug: "consent-banner",
    title: "Login consent banner",
    category: "Admin",
    summary: "Show a notice before sign-in, optionally requiring explicit acceptance, with acceptance audit-logged.",
    content: `
An optional notice shown **before authentication** — a consent-to-monitor
statement, an acceptable-use notice, a classification warning. Configured
in **Admin → Consent banner**.

## The two modes

**Informational** — the notice appears above the sign-in form. Users read
it and sign in as normal. Nothing is recorded.

**Require Accept/Reject** — the sign-in form is **not shown at all**
until the user accepts. Accepting reveals the form and is **audit-logged**
with who accepted and when. Rejecting leads to a dead-end page with no
way onward.

Use the second mode when you need to be able to demonstrate that a user
was shown a notice and agreed to it before being given access.

## Configuring it

| Field | Notes |
|---|---|
| Enabled | Off by default |
| Title | Heading shown above the body |
| Body | The notice itself |
| Require Accept/Reject | Off = informational; on = gate the sign-in form |

## What to expect

- **It re-shows on every visit to the login page**, not once per user.
  That is deliberate: consent-to-monitor notices are expected to be
  presented each time, not remembered and skipped.
- It applies to the **login page**, so it is shown before either sign-in
  method — SSO or local password.
- The break-glass local admin sees it too. Enabling Accept/Reject does
  not create a lockout risk, but it does mean an admin recovering access
  in a hurry must still accept.
- Acceptance is written to the audit trail and mirrors to syslog like any
  other audit event (see [Syslog & SIEM forwarding](/help/syslog)).

See also [Admin settings](/help/admin).
`,
  },

  {
    slug: "usage-cost",
    title: "Usage, cost & reporting",
    category: "Admin",
    summary: "See what runs are consuming, set the rates that price it, and export or schedule reports.",
    content: `
Every run records the tokens it used. Priced against rates you configure,
that becomes a spend figure per run, per job, and per period.

## 1. Set the rates

**Admin → Cost rates**. Rates are per **million tokens**, entered
separately for prompt and completion because providers price them
differently.

Leave **Agent ID** blank to set a global default; add an Agent-specific
rate to override it for that agent. A run is priced with the most
specific rate that matches.

Without any rate configured, token counts are still recorded — you simply
get usage without a currency figure.

## 2. Read the usage dashboard

**Admin → Usage** shows totals over a period: runs, prompt and completion
tokens, and computed cost, broken down so you can see which jobs are
responsible.

## 3. Export

Two formats, both from the same view:

- **CSV** — for a spreadsheet or a chargeback pipeline.
- **PDF** — a branded report carrying your product name, logo, accent
  colour, and classification banner if one is configured.

## 4. Recurring report emails

**Admin → Recurring usage reports** sends the same report on a schedule
to a list of recipients. Requires SMTP to be configured
([Admin settings](/help/admin)).

## What to expect

- **Token counts can be missing.** They come from the model provider's
  usage data via LibreChat. Some deployments return zeros or nothing at
  all for headless API-key calls — in that case the run is recorded with
  no token count rather than a fabricated one, and it contributes nothing
  to cost.
- **Cost is computed at run time** using the rate in force then. Changing
  a rate later does not retroactively reprice past runs, which is what
  you want for an auditable record.
- Usage is **admin-scoped** — ordinary users see their own runs' tokens
  and cost on the run record, not the organization-wide dashboard.

See also [Runs, output & PDF reports](/help/runs).
`,
  },

  {
    slug: "ocr",
    title: "Document OCR & attachments",
    category: "Modules",
    summary: "Attach documents to Jobs, get extracted text to your agent, and wire LibreChat chat uploads through the same pipeline.",
    content: `
Nexus Scheduler ships a **self-hosted, fully offline OCR pipeline**: one
Tesseract pass (via OCRmyPDF \`--skip-text\`) plus docling for layout and
tables. Digital PDFs pass through with **zero** OCR cost — only pages
without a text layer are recognized. Nothing is ever downloaded at
runtime; all models are baked into the OCR service image.

## Architecture

How a document flows, whichever door it enters through:

\`\`\`mermaid
flowchart LR
  B1[Browser] -->|"job attachments<br/>10 files / 50 MB"| NS[Nexus Scheduler] --> W[Worker]
  B2[Browser] -->|"'Upload as Text'<br/>up to 10 files per message, 15MB each"| LC[LibreChat]
  W -->|one request per document| OCR
  LC -->|built-in OCR config| OCR
  subgraph OCR ["OCR service — ocr-net (isolated, no internet egress)"]
    direction TB
    I[img2pdf] --> O["OCRmyPDF --skip-text<br/>Tesseract runs ONCE, only on<br/>pages with no text layer"]
    O --> D["docling (do_ocr=False)<br/>layout + tables, no second OCR pass"]
  end
  OCR --> MD["markdown → agent input"]
  OCR --> PDF["searchable PDF → audit artifact"]
\`\`\`

The extracted markdown goes to the model; the searchable PDF (your
original pages plus an invisible text layer) is kept as the audit
artifact. The model itself is reached through LibreChat → LiteLLM →
Ollama — the OCR service never talks to the internet, and only the
Worker and LibreChat can talk to it.

**Which door should you use?**

| | Scheduler job | LibreChat chat |
|---|---|---|
| Capacity | up to 10 files / 50 MB per job | up to 10 files per message, 15MB each |
| Repeatability | Run Now or any schedule, same attachments every run | one-off |
| Record | extracted text + searchable PDF on every run, audit-logged | conversation context only |
| Best for | recurring document workloads, anything you must audit | quick "what does this say?" questions |

There are two ways to use it.

## 1. Job attachments (scheduled / repeatable)

1. Open a Job on its Project page and click **Files**.
2. Upload PDF, PNG, JPEG, TIFF, BMP or WebP — by default up to
   15&nbsp;MB per file, 10 files / 50&nbsp;MB per Job. Those are
   **defaults, not hard limits**: an operator can raise them (see
   *Limits and tuning* below) without rebuilding anything.
3. Run the Job (**Run Now** or a schedule). Before the agent is called,
   every attachment is extracted and the markdown is appended to the
   prompt — the agent sees text, never the binary.
4. On the finished run you get:
   - the **extracted text** stored on the run record,
   - a **searchable PDF** per attachment (your original pages plus an
     invisible text layer) as a downloadable artifact,
   - the agent's answer, informed by the documents.

Every upload, delete, and artifact download is audit-logged. If the OCR
service is not deployed, Jobs with attachments still run — without
extraction, and each run logs a warning saying so.

## 2. LibreChat chat uploads (ad-hoc Q&A)

LibreChat's built-in OCR support can point at this same pipeline, so a
file attached in chat is extracted into the conversation context — any
text model can then answer questions about it (the bundled local models
cannot see images, but they read extracted text just fine).

Configuration (already wired in this repo's compose stack —
\`docker/librechat/librechat.yaml\`):

\`\`\`yaml
ocr:
  strategy: "mistral_ocr"
  baseURL: "http://ocr:4200/v1"
  apiKey: "network-isolated-no-key"
  mistralModel: "nexus-ocr"
\`\`\`

Why it works: LibreChat's \`mistral_ocr\` strategy speaks the Mistral
OCR API, and the OCR service implements that exact surface —
\`POST /v1/files\`, \`GET /v1/files/{id}/url\`, \`POST /v1/ocr\`,
\`DELETE /v1/files/{id}\`. The "signed URL" it returns is a \`data:\` URL,
so no network fetch ever happens; remote URLs are rejected outright. The
apiKey is a placeholder — access control is the OCR network itself
(internal-only; LibreChat is a member), not a credential. Note:
\`custom_ocr\` appears in LibreChat's config schema but current builds
implement no strategy for it — use \`mistral_ocr\`.

To use it in chat: attach a file with the paperclip and choose **Upload
as Text**. The extracted markdown lands in the conversation context.

## Image descriptions (optional)

OCR reads text. It cannot tell you what a photograph *is* — a diagram, a
whiteboard, a damaged part. Turning on **image descriptions** adds a
one-paragraph summary from a multimodal model, appended to the extracted
text so the agent gets both.

This is the one part of the pipeline that calls a model. Extraction is
local and deterministic; descriptions go out through the LiteLLM gateway,
same as any other model call.

Two things to know before enabling it:

- **The model must actually be multimodal.** The bundled local models
  (\`gemma3:1b\`, \`codegemma:2b\`, \`phi4-mini-reasoning\`) are text-only.
  Pointing at one does not fail loudly — descriptions are best-effort, so
  you get silently missing descriptions and gateway 400s in the logs.
- **Each door has its own switch.** Scheduler attachments and LibreChat
  chat uploads are enabled independently, because LibreChat's request
  shape carries no per-request flag. In Compose one service instance
  serves both, so a single variable covers them; on Kubernetes they are
  separate releases and therefore separate settings.

| | Compose | Kubernetes |
|---|---|---|
| Scheduler attachments | \`OCR_DESCRIBE_IMAGES\` | \`ocr.describeImages\` (app chart) |
| LibreChat chat uploads | \`OCR_DESCRIBE_IMAGES\` | \`gateway.describeImages\` (OCR chart) |

Left off (the default), no gateway call is ever made and extraction stays
text-only.

## Limits and tuning

Every limit below is a **default an operator can change**, in Compose via
an environment variable and on Kubernetes via the OCR chart's values. None
require rebuilding the image.

| What | Compose | Chart value | Default |
|---|---|---|---|
| Per-file upload size | \`OCR_FILE_MAX_BYTES\` | \`fileMaxBytes\` | 15 MB |
| Files per Job run | \`OCR_PROCESS_MAX_FILES\` | \`processMaxFiles\` | 10 |
| Total bytes per Job run | \`OCR_PROCESS_MAX_TOTAL_BYTES\` | \`processMaxTotalBytes\` | 50 MB |
| LibreChat upload store | \`OCR_FILE_STORE_MAX_BYTES\` | \`fileStoreMaxBytes\` | 256 MB |
| Time limit on one extraction | \`OCR_MAX_PROCESS_SECONDS\` | \`maxProcessSeconds\` | 900 s |
| Scan resolution | \`IMAGE_DPI\` | \`imageDpi\` | 300 |

**When you would change these.** A large scanned drawing exceeds 15 MB —
raise the per-file limit. A long document on CPU-only hardware takes more
than 15 minutes — raise the time limit. Uploading a file over the limit
returns a clear "too large" error rather than failing halfway through, so
the symptom names the cause.

Two of these are linked and the deployment refuses inconsistent values:
the LibreChat upload store and the per-run total must each be at least as
large as a single permitted file, otherwise one allowed file would be
rejected by an aggregate limit and the error would name the wrong ceiling.

## Kubernetes

Deploy the \`helm/ocr\` chart, then point the app chart's worker at it
(\`ocr.serviceUrl\`) and add one OCR-chart \`networkPolicy.clientPeers\`
entry for the Worker's namespace/labels and another for LibreChat's. The
separate selectors matter because Worker and LibreChat do not share labels.

\`\`\`yaml
networkPolicy:
  clientPeers:
    - name: worker
      namespaces: [nexus-scheduler]
      podMatchLabels:
        app.kubernetes.io/name: nexus-scheduler
        app.kubernetes.io/component: worker
    - name: librechat
      namespaces: [test-ai]
      podMatchLabels:
        app.kubernetes.io/name: librechat
\`\`\`

For the bundled \`helm/test-ai\`
LibreChat, set \`librechat.ocr.baseUrl\` to the OCR Service's cluster URL
including \`/v1\`; the chart renders the same \`mistral_ocr\` block shown
above. The app chart's \`ocr.maxPromptChars\` caps the complete user prompt
(rendered template plus extracted documents); its 80,000-character default
leaves headroom in the bundled model's 32k-token context. If Grafana Alloy
runs in a separate \`observability\` namespace,
allow it independently from application callers:

\`\`\`yaml
metrics:
  scraperNamespaces: [observability]
  scraperPodMatchLabels:
    app.kubernetes.io/name: alloy
\`\`\`

## Seeing it work

- The [Architecture & data flow](/help/architecture) article shows where the
  OCR service sits in the system. Whether it's deployed and reachable
  *right now* is on the admin System Map (Admin area) — grey "Not
  configured" there means \`OCR_SERVICE_URL\` isn't set on the Worker.
- The Grafana dashboard **OCR Service — Document Extraction** shows
  requests, pages OCR'd vs passed through (the \`--skip-text\`
  dividend), file types, pages per document, and stage latencies.
`,
  },
];

export function findKbArticle(slug: string): KbArticle | undefined {
  return KB_ARTICLES.find((a) => a.slug === slug);
}
