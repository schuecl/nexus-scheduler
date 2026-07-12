# Nexus Scheduler

Web application for scheduling agentic AI tasks against LibreChat's
Agents API, part of the MPNexus platform. Built for an air-gapped
military Kubernetes deployment.

- **[REQUIREMENTS.md](./REQUIREMENTS.md)** — the source of truth for what
  this app does and why. Start here.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — diagrams of the system
  structure described in REQUIREMENTS.md.

This repo is an early scaffold: the shape of the system (packages,
schema, Docker/Helm deployment) is in place and builds cleanly, but most
route handlers and UI screens are stubs. Treat anything not explicitly
described below as "not yet implemented."

## Stack

TypeScript everywhere, npm workspaces monorepo (see REQUIREMENTS.md §11
for the full rationale):

| Package | What it is |
|---|---|
| `packages/shared` | Prisma schema/client, shared types, zod schemas, scheduling/crypto utilities |
| `packages/api` | Express backend — auth (OIDC/Keycloak + local fallback), CRUD, audit log |
| `packages/worker` | BullMQ-based scheduler/worker — fires due schedules, calls LibreChat, retries |
| `packages/frontend` | React + Vite + MUI SPA |

## Local development

Requires Node 20+, npm 10+, Docker.

```bash
npm install
npm run prisma:generate
npm run build       # builds shared -> api -> worker -> frontend, in order
```

### Full stack via Docker Compose

Stands up Postgres, Redis, Keycloak, Mailpit, a real local LibreChat
install (+ its own MongoDB), and the app itself — see REQUIREMENTS.md
§9.2 for what this is (and isn't) meant to validate.

```bash
./scripts/generate-local-env.sh   # writes .env + docker/librechat/.env — do this once
docker compose up --build
```

Then:
- App (behind local nginx): http://localhost:8080 — log in as the
  built-in admin via "Sign in with password" using `BOOTSTRAP_ADMIN_EMAIL`
  / `BOOTSTRAP_ADMIN_PASSWORD` from `.env` (defaults to
  `admin@nexus-scheduler.local`). From there, configure SMTP in Admin
  Settings and point it at Mailpit (`host: mailpit`, `port: 1025`, no
  auth/TLS) to test password-reset/account emails.
- Mailpit (catches outbound email): http://localhost:8025
- Keycloak admin console: http://localhost:8081 (`admin` / see `.env`)
- LibreChat: http://localhost:3080

Keycloak has no realm pre-provisioned yet — create a `nexus-scheduler`
realm and client manually to test the OIDC login flow end to end.

**LibreChat first-run setup** — none of this is scriptable, it's
LibreChat's own UI flow, and it's what actually makes a Job runnable
end to end rather than just erroring against a nonexistent backend:
1. Set `ANTHROPIC_API_KEY` in this repo's own root `.env` to a real key
   from https://console.anthropic.com/ — Claude/Anthropic is wired up
   as LibreChat's provider for local testing (`ENDPOINTS=anthropic` in
   `docker-compose.yml` keeps LibreChat's UI to just that one provider
   rather than a dropdown full of others with no key configured). Other
   providers (`OPENAI_API_KEY`, `AZURE_API_KEY`) can still be set
   directly in `docker/librechat/.env` if you'd rather test against
   those instead. Either way: `docker compose restart librechat` —
   LibreChat has nothing to call without at least one provider key.
2. Visit http://localhost:3080 and register an account (this is
   LibreChat's own local auth — `ALLOW_REGISTRATION=true` is set by
   default in the generated env file — separate from Nexus Scheduler's
   own users entirely).
3. Create an Agent in LibreChat's UI, backed by a Claude model.
4. Generate a LibreChat API key for that account (REQUIREMENTS §2.1:
   LibreChat API keys are created via `POST /api/api-keys` on the
   LibreChat side, outside Nexus Scheduler).
5. Back in Nexus Scheduler, add that key under **API Keys**, then pick
   the Agent from step 3 when creating a **Job** — Nexus Scheduler tries
   to auto-discover the Agents available to whichever key you select
   (REQUIREMENTS §2.1) via `GET /api/agents/v1/models` on LibreChat,
   the sibling of the `/chat/completions` endpoint it already calls to
   run a Job, following the same OpenAI-compatible convention. This
   hasn't been confirmed against a real LibreChat deployment — if the
   picker comes up empty, the Job form falls back to a plain "LibreChat
   Agent ID" text field automatically, and you can just paste the
   Agent's ID from LibreChat's UI directly.

This install is intentionally minimal: LibreChat's own default Compose
setup also runs Meilisearch (conversation search) and a RAG API +
pgvector (file-embedding search) — neither is needed for the Agents API
Nexus Scheduler actually calls, so both are omitted and search is
disabled (`SEARCH=false`) rather than left pointing at a service that
isn't running.

**If you already had a `.env` from before LibreChat was added**:
`generate-local-env.sh` never overwrites an existing `.env`, so it won't
pick up new variables added to the template later. Add these two lines
by hand:
```
LIBRECHAT_BASE_URL=http://librechat:3080
ANTHROPIC_API_KEY=
```
(fill in a real key on the second line to use Claude — re-running the
script will still create `docker/librechat/.env` alongside your
existing root `.env`, since that file didn't exist before).

**Postgres "password authentication failed"**: Postgres only sets its
user's password when its data directory is first initialized — if the
`postgres-data` volume was ever created against an *older* `.env` (e.g.
you regenerated or hand-edited `POSTGRES_PASSWORD` at some point), it
keeps that original password forever, regardless of what `.env` says on
later starts. `migrate` is usually the first thing to actually hit this,
since it's the first service to try authenticating. Fix by wiping the
stale volume so Postgres reinitializes from the current `.env` (this
also resets Redis and LibreChat's Mongo — fine for this dev/test stack,
not something to do against a deployment with real data):
```bash
docker compose down -v
docker compose up --build
```

### Running a single package against the Compose infra

```bash
npm run dev --workspace=packages/api      # or packages/worker, packages/frontend
```

Point `DATABASE_URL`/`REDIS_URL` at the Compose-exposed ports (5432/6379)
via a local `.env` in that package, or export them in your shell.

## Database schema changes

The schema lives at `packages/shared/prisma/schema.prisma`. While the
schema is still actively changing, use:

```bash
npm run prisma:push --workspace=packages/shared
```

Once the schema stabilizes, switch to real migrations
(`prisma migrate dev`) instead of `db push` so schema history is tracked.

## Deployment

- **Kubernetes**: `helm/nexus-scheduler/` — see REQUIREMENTS.md §9.1 and
  the chart's `NOTES.txt` for what Secrets must exist before installing.
  Not yet validated with `helm lint`/`helm template` in this environment
  (no Helm CLI available here) — run that before any real deployment.
- **Container images**: `packages/{api,worker,frontend}/Dockerfile`, all
  built from the **repo root** as build context, e.g.:
  ```bash
  docker build -f packages/api/Dockerfile -t nexus-scheduler-api .
  ```
  All three currently use `node:20-slim` / `nginx-unprivileged` as
  placeholder base images — REQUIREMENTS.md §3/§9.1/§10 call for Iron
  Bank images and DISA STIG hardening where available; swap the base
  images before this goes near a real environment.

## What's actually implemented vs. stubbed

Implemented (compiles, runs, has been exercised at least via typecheck/
build in this environment):
- Prisma schema modeling the full data model from ARCHITECTURE.md §4
- OIDC login flow (Keycloak client-role → app role mapping, session
  creation) — REQUIREMENTS.md §4
- Audit event writer (Postgres only — syslog/RFC 5424 mirror is a TODO)
- Scheduler tick loop (due-schedule polling, missed-fire skip logic,
  next-fire-time computation) and a BullMQ run processor with
  retry/backoff, cost calculation, and the LibreChat Agents API adapter
- **Teams** (§2.3): CRUD, nested hierarchy, membership management,
  including the "membership in a parent Team is inherited by every
  descendant Team" rule
- **Projects & ACLs** (§2.3): CRUD, classification-label tagging, and
  sharing by individual user / Team / org-wide with READ or EDIT access
  — `getProjectAccess()`/`listAccessibleProjects()` in
  `packages/api/src/access.ts` are the single source of truth for who
  can see/edit what, used by both the list endpoint and the
  `requireProjectAccess` route middleware. Sharing config itself
  (granting/revoking ACLs) is deliberately owner-only, per §2.3's "a
  Project owner can share a Project" — EDIT collaborators can change
  content but not decide who else gets in.
- **Prompts & Prompt Library** (§2.3): prompts live inside a Project,
  each edit creates a new immutable `PromptVersion` rather than mutating
  content in place (so schedules pinned to a version are never silently
  altered), plus favorites and a library-wide search/tag/favorites view
  (`GET /api/prompts`) scoped to every Project the user can see via
  `getAccessibleProjectIds()`. Access is entirely inherited from the
  containing Project (`requirePromptAccess` delegates straight to
  `getProjectAccess`) — prompts don't carry their own ACLs.
- **API Keys** (§2/§4): personal or Team-owned LibreChat API keys,
  encrypted at rest (AES-256-GCM, `packages/shared/src/crypto.ts`), raw
  key material never returned after creation. `GET /api/api-keys`
  returns every key a user can actually use — their own plus any
  Team-owned key for a Team they're effectively a member of.
- **Jobs**, properly Project-scoped (§2.3, §2.1): same access pattern as
  Prompts (`requireJobAccess` → `getProjectAccess`) — this replaces the
  earlier unscoped `jobs` CRUD stub, which listed every Job in the
  system to any authenticated user regardless of Project access. Job
  creation cross-checks that its `promptId` actually belongs to the same
  Project.
- **Schedules with the full maker-checker approval workflow** (§2.4):
  one-time and recurring (interval-picker, not cron), pause/resume,
  version pinning (`LATEST` vs. a specific `PromptVersion`). Schedules
  in a **private** Project auto-approve; schedules in a **shared**
  Project start `PENDING` and need approval before the Worker will ever
  pick them up. `getEligibleApprovers()` in `access.ts` resolves who
  that is (owner + every EDIT grantee, Team grants expanded through
  membership, including inheritance) and enforces "you can't approve
  your own change unless you're the only eligible approver," per §2.4's
  exact wording. Editing a substantive field (timing, version pin) on an
  already-approved shared schedule resets it to `PENDING` and
  recomputes `nextFireAt` on (re-)approval; pause/resume are separate
  endpoints so an operational toggle never accidentally re-triggers
  approval.
- **Admin: classification taxonomy** (§6): list/create labels (text,
  abbreviation, badge colors, sort order, default-for-new-Projects) —
  the UI for the classification-labels backend that already existed but
  had no way to actually populate it.
- **Prompt variable substitution, end to end** (§2.3): declaring
  `{{variable}}` placeholders (name/type/default) is now a real UI —
  `VariableEditor` on both "New Prompt" and "Save as new version," not
  just a zod schema nothing ever populated. More importantly, a
  **per-schedule value override** now actually exists: `Schedule` grew a
  `variableValues` column (it had nowhere to store this before), the
  create-Schedule form shows an editable input per variable declared on
  the *effective* prompt version (the pinned one, or latest — recomputed
  live as you change the pin selector), pre-filled with its default, and
  the Worker's `renderPromptTemplate()` now takes those overrides as a
  third precedence tier above declared defaults (built-ins still always
  win). This closes a gap the Worker code had an explicit `TODO` for.
- Frontend, fully wired end to end: create an API key → create a
  Project → add a Prompt (with declared variables) → create a Job
  against that Prompt and key → create a Schedule for that Job
  (one-time or recurring, with a live interval-picker UI and per-run
  variable value inputs) → see it in the cross-Project **Approvals**
  queue if its Project is shared → approve/reject. Plus the
  Teams/Projects pages (create, browse, manage membership, manage
  sharing), a Prompts panel inside each Project's detail view, and a
  top-level Prompt Library page for org-wide search/tag/favorites
  discovery.

Known simplification: the one-time schedule picker uses an HTML
`datetime-local` input, always interpreted in the browser's local time
zone — the schedule's separate `timezone` field is honored for display
and for recurring-schedule math, but not (yet) for re-interpreting a
one-time `runAt` in a zone other than the browser's. Correct for the
common case; a dedicated cross-zone one-time picker is a follow-up if
that turns out to matter.

- **Outbound webhook delivery** (§2.2/§10): `WebhookDestination` and the
  `JobWebhookDestination` join table existed in the schema since the
  original scaffold, but nothing ever read or wrote them. Now:
  - Admin-only allow-list (`packages/api/src/routes/
    webhookDestinations.ts`) — a Job can only ever attach one of these
    rows, never an arbitrary URL, which is what keeps this from becoming
    an SSRF/exfiltration path. The signing secret is generated
    server-side (`generateWebhookSecret()`) and AES-256-GCM encrypted at
    rest; it's never entered or displayed in the UI, only used
    server-side to sign deliveries.
  - `PUT /api/jobs/:id/webhooks` lets a Job pick which allow-listed
    destinations to notify (replaces the full set per call).
  - The Worker's `deliverWebhooksForRun()` fires after every terminal
    run (success or failure), POSTing a JSON payload with an
    `X-Nexus-Signature: sha256=<hmac>` header so receivers can verify
    authenticity. Every attempt (success or exhausted-retry failure) is
    audited (`webhook.deliver`).
  - Frontend: an Admin panel for the allow-list, and a "Webhooks" button
    per Job (next to "Schedules") to pick which destinations apply.
  - **Fixed in passing**: the shared `auditEventSchema`'s action-string
    regex only allowed exactly one dot, but REQUIREMENTS §7.1's own
    examples (and several actions already in use — `team.membership.add`,
    `project.acl.grant`, `prompt.version.create`) have two. Loosened it
    to allow one or more dot-separated segments.

Known simplification: webhook delivery retries with short, fixed delays
(a few seconds total) rather than the job's own 30s/120s exponential
policy — delivery runs synchronously inside the run's BullMQ job, so a
slow or dead receiver holding that up for minutes would cost real
worker throughput. A failed delivery is logged and audited but never
fails the run itself or triggers a BullMQ retry of the run. Also, every
attached destination is notified on every terminal outcome (success and
failure both) — there's no per-destination success/failure toggle yet,
though the payload's `status` field lets a receiver filter client-side.

- **Admin UI, the rest of it**: branding + the system-wide classification
  banner, user/role management, and cost rates.
  - **Branding & classification banner** (§5/§6): a new `AppSettings`
    singleton row (product name, logo URL, primary color, banner
    text/colors). `GET /api/settings` is deliberately unauthenticated —
    the banner has to render before/independent of login resolving — and
    defaults to the same loud "UNCONFIGURED" placeholder the frontend
    used to hardcode, on purpose (REQUIREMENTS §6: a plausible-looking
    default like "UNCLASSIFIED" would risk masking a deployment that
    never actually set it). The frontend's theme and `AppLayout` banner
    are now both driven by a `SettingsContext` fetched at app root,
    replacing the hardcoded values entirely.
  - **User/role management** (§4): admin-only list of every user with
    role and active-status toggles, plus provisioning new local accounts
    (see below). A user can't demote or deactivate their own account
    (enforced both client- and server-side).
  - **Cost rates** (§8): same "consumer with no producer" shape as the
    recent Prompt-variable and webhook gaps — the Worker's
    `costCalculator.ts` has looked up `CostRate` rows since the Usage &
    Reporting work, but there was no way to create one, so every run's
    cost was silently "not costed." Admin CRUD now exists (global
    default or per-agent rate, $ per million prompt/completion tokens).
- **Local accounts, login, and SMTP** (§4/§5) — the `passwordHash`/
  `AuthSource.LOCAL` fields had existed since the original scaffold with
  no way to actually create or use one. Now:
  - **Built-in break-glass admin**: `BOOTSTRAP_ADMIN_EMAIL`/
    `BOOTSTRAP_ADMIN_PASSWORD` env vars. The password is **re-synced on
    every API startup**, not just seeded once — the env var is the
    ongoing source of truth (same pattern as Grafana's
    `GF_SECURITY_ADMIN_PASSWORD`), so an operator recovers admin access
    by changing the env var and restarting, no DB access needed. Always
    works regardless of `LOCAL_AUTH_ENABLED` — a break-glass account
    that can be locked out by a config toggle defeats the point.
  - **Local login** (`POST /auth/local-login`) with a timing-safe
    comparison — a login attempt against a nonexistent email runs
    `bcrypt.compare` against a dummy hash rather than short-circuiting,
    so response timing doesn't leak whether an account exists.
  - **Self-service and admin-triggered password reset**, sharing one
    code path (`issuePasswordResetEmail()`): a single-use, SHA-256-hashed
    (not encrypted — it never needs to be recovered, only compared),
    1-hour-expiry token emailed as a link. This is also how an
    admin-provisioned local account gets its *first* password — there's
    never a temp password to communicate out of band.
  - **SMTP** (§5): host/port/TLS/username/password/from-address, stored
    in the same `AppSettings` singleton as branding, password
    AES-256-GCM encrypted and never returned by any API response (`GET
    /api/settings/admin` reports only `smtpPasswordSet: boolean`). A
    "send test email" button in the Admin UI proves it actually works,
    not just that the form saved.
  - `LOCAL_AUTH_ENABLED` now actually does something (it didn't before —
    the flag existed but nothing checked it): it gates *ordinary* local
    accounts (login, forgot/reset-password, admin-provisioning new
    ones), never the built-in admin.
  - Frontend: a `/login` page (SSO button + local login form + forgot-
    password), a `/reset-password?token=...` page, and the Admin Users
    panel gained "New Local User" and "Send password reset" actions.

- **Run history and manual "Run Now" trigger** (§2.1/§8): the `Run`
  model had been written to by the scheduler and read by the Worker's
  processor since the original scaffold, but there was no API route to
  list or view a `Run`, and no way to trigger a Job outside its schedule
  — the Dashboard was a static placeholder. Now:
  - `GET /api/jobs/:id/runs` (history, newest first) and
    `POST /api/jobs/:id/runs` ("Run Now" — creates a `Run` with
    `triggerType: MANUAL` and enqueues it with the same
    attempts/exponential-backoff policy the scheduler itself uses) both
    live behind `requireJobAccess`, same READ/EDIT split as everywhere
    else. `GET /api/runs/:id` is the single-run detail route, behind a
    new `requireRunAccess` middleware that resolves Run → Job → Project
    the same way `requireScheduleAccess` resolves Schedule → Job →
    Project.
  - The API now enqueues into the *same* BullMQ queue the Worker
    consumes. `RUNS_QUEUE_NAME`/`RunJobData` moved from
    worker-only into `packages/shared/src/queue.ts` so the two packages
    can't drift apart; the API gets its own `parseRedisConnectionOptions`
    (mirroring the Worker's, for the same BullMQ-bundles-its-own-ioredis
    reason) since it didn't previously depend on `bullmq` at all.
  - `GET /api/dashboard` (§8: "Run counts, success/failure rates, and
    upcoming schedules"): run counts by status, the 10 most recent runs,
    and the 10 next schedules due to fire — all scoped to the Projects
    the requesting user can actually see, via the same
    `getAccessibleProjectIds()` used by the Prompt Library search.
  - Frontend: a real `DashboardPage` (status counts, success rate,
    recent runs, upcoming schedules) replacing the placeholder, and a
    `RunHistoryDialog` (new "Runs" button next to "Schedules"/
    "Webhooks" on each Job) showing run history with expandable
    output/error detail and a "Run Now" button, polling every 5s so an
    in-flight run's status updates without a manual refresh.

- **PDF report generation — on-demand run reports** (§2.5): a new
  `@nexus-scheduler/pdf` workspace package wraps Playwright headless
  Chromium (`page.pdf()`), the engine REQUIREMENTS recommends, and is
  used in-process by the API rather than as the fully isolated
  separate-pod component §2.5 describes as the ideal — see the known
  simplification below.
  - `GET /api/runs/:id/pdf` (behind `requireRunAccess`, same as the
    run-detail route) renders a run's stored output as a PDF: job name,
    run ID/status/trigger/timestamps/token counts/cost, and the
    LibreChat output or error text. Generated fresh on every request
    from already-persisted data, never stored as a binary, per §2.5.
  - **Branding and marking carry over**: the report pulls the same
    `productName`/`primaryColor` and system-wide classification banner
    text/colors the web UI uses (`getPublicAppSettings()`, now shared
    between the settings route and the PDF route so the two can't
    disagree), rendered as the PDF's header *and* footer via
    Playwright's `headerTemplate`/`footerTemplate` — the same "banner on
    every page" the app shows top and bottom. If the run's Job's Project
    carries a classification label, that label is also shown as a badge
    on the report body as a secondary marking, per §2.5.
  - **Every interpolated value is HTML-escaped** before it goes into the
    template (`escapeHtml()`), including the LibreChat-generated
    `output`/`errorMessage` — that content is untrusted as far as the
    renderer is concerned, and it gets loaded into a real Chromium page
    via `page.setContent()`, so unescaped interpolation would be a
    genuine HTML/script-injection vector into the render process, not
    just a display bug. Verified with a smoke test using
    `<script>`/`<b>` payloads in both the job name and output — both
    render as literal escaped text in the output PDF.
  - Frontend: a "Download PDF" action on each run's expanded detail in
    `RunHistoryDialog`, a plain same-origin link (session cookie carries
    auth) rather than a fetch+blob dance.
  - Docker: the API image now builds `packages/pdf` and runs
    `playwright install --with-deps chromium` in its runtime stage
    (installed to a world-readable `/opt/pw-browsers` so the non-root
    `nexus` user can still launch it). The `playwright` dependency is
    pinned to an exact version (not `^`) since each Playwright release
    is tied to a specific bundled Chromium build — letting it float
    could silently drift the installed browser out from under a pinned
    container layer. Helm's default API resource requests/limits were
    bumped (256Mi/512Mi → 384Mi/1Gi memory, 500m → 1 CPU limit) since a
    headless Chromium launch briefly needs real headroom.

Known simplification: REQUIREMENTS §2.5 recommends the PDF renderer run
as a fully isolated component — its own pod, no network egress by
`NetworkPolicy`, independent crash-restart — separate from both the API
and Worker. This round implements it as an in-process library inside the
API instead (ARCHITECTURE.md's container table already listed "in-
process library or internal call" as an explicit alternative to a
separate service). That's a real gap from the hardened target: a bug in
the renderer takes down an API replica rather than an isolated
component, and there's no `NetworkPolicy` yet actually enforcing "no
egress" for it (nothing in this repo defines K8s `NetworkPolicy`
resources at all yet, for any component). Splitting rendering into its
own internal-only service, with its own Deployment/Service/NetworkPolicy
in the Helm chart, is a reasonable following piece if the security
review calls for it.

- **Job completion/failure email notifications, with PDF attachment**
  (§2.2/§2.5): the Worker's `processor.ts` had an explicit `TODO` at the
  exact point this was supposed to fire from, left by the PDF-rendering
  round. Now closed:
  - `Job` gained three columns — `notifyOnSuccess`, `notifyOnFailure`,
    `attachPdfToEmail` — set via `PUT /api/jobs/:id/notifications`
    (`requireJobAccess("EDIT")`, same convention as the webhooks
    endpoint) and a new "Notify" button/dialog per Job, parallel to
    "Webhooks."
  - `packages/worker/src/notifications.ts`'s `sendRunNotificationEmail()`
    fires from both the success and terminal-failure paths in
    `processor.ts` (mirroring exactly where `deliverWebhooksForRun()`
    already fires), sends to the **Job owner** (`createdBy.email`) per
    §2.2's wording, and — if `attachPdfToEmail` is set — attaches the
    same `renderRunReportPdf()` the on-demand download route uses,
    replacing the inline output text rather than duplicating it in both
    places. Best-effort and audited (`run.notify_email`), same posture
    as webhook delivery: a failed send is logged/audited but never fails
    the run or triggers a BullMQ retry, and a missing SMTP config is a
    silent no-op rather than a hard error (most jobs won't opt in).
  - `packages/worker/src/email.ts` is a second, Worker-side copy of the
    API's `sendEmail()` (plus attachment support) — necessary duplication
    since the API and Worker are separate deployable processes, each
    with its own Prisma client, and there's no shared "server" package
    either could depend on without pulling in the other's runtime.
  - The Worker now also depends on `@nexus-scheduler/pdf`, so its
    Dockerfile picked up the same `playwright install --with-deps
    chromium` runtime-stage step as the API's, and its default Helm
    memory request was bumped for the same reason.

Known simplification: REQUIREMENTS §2.5 recommends the PDF renderer run
as a fully isolated component — its own pod, no network egress by
`NetworkPolicy`, independent crash-restart — separate from both the API
and Worker. This round implements it as an in-process library inside
both the API *and* Worker instead (ARCHITECTURE.md's container table
already listed "in-process library or internal call" as an explicit
alternative to a separate service). That's a real gap from the hardened
target: a renderer bug takes down an API or Worker replica rather than
an isolated component, and there's no `NetworkPolicy` yet actually
enforcing "no egress" for it (nothing in this repo defines K8s
`NetworkPolicy` resources at all yet, for any component). Splitting
rendering into its own internal-only service, with its own Deployment/
Service/NetworkPolicy in the Helm chart, is a reasonable following piece
if the security review calls for it.

Also not yet built: **admin usage-report PDF export / recurring usage
report email** (§2.5's third delivery path — the §8 dashboard exported
as PDF and emailed to admin-configured recipients on a schedule). Unlike
the run-report PDF and job-completion email, this one has no existing
consumer/producer gap to close — it needs its own admin UI, its own
render template, and (for the recurring part) its own schedule concept
independent of Job/Schedule.

- **Agent discovery** (§2.1): "rather than requiring users to hand-type
  a LibreChat agent ID, Nexus Scheduler should call LibreChat to list
  the agents available to the configured API key... Falls back to
  manual agent-ID entry if discovery isn't available" — this had never
  actually been built; the Job form's agent field was always a plain
  text box. `GET /api/api-keys/:id/agents` (new, in
  `packages/api/src/routes/apiKeys.ts`) decrypts the selected key and
  calls `GET /api/agents/v1/models` on LibreChat — the sibling of the
  `/chat/completions` endpoint the Worker already calls, following the
  same OpenAI-compatible convention REQUIREMENTS documents for that
  endpoint. **Not independently confirmed against a live LibreChat
  deployment** (§14 already flagged this as an open item for the
  `/chat/completions` endpoint itself); any failure — wrong path, 404,
  unexpected response shape — is caught and the Job form's agent field
  falls back to the original plain text input exactly as REQUIREMENTS
  specifies, so a wrong guess here degrades gracefully rather than
  breaking Job creation.

Stubbed / not yet built: admin usage-report PDF export and recurring
report email, an isolated PDF-renderer component, per-user concurrency
limiting (only the global limit is enforced today), Prometheus metrics,
and syslog output. See REQUIREMENTS.md for the full feature set these
should implement.
