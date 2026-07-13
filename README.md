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
1. Pick a provider — two are wired up already, use either:
   - **Ollama running `qwen3:0.6b`** (free, local, no API key): the
     `ollama` + `ollama-pull` Compose services pull Qwen3's smallest
     model on first `up` (~0.5GB — check `docker compose logs -f
     ollama-pull` for progress, needs real internet access once).
     Exposed to LibreChat as a custom OpenAI-compatible endpoint via
     `docker/librechat/librechat.yaml` — nothing else to configure.
   - **Claude/Anthropic**: set `ANTHROPIC_API_KEY` in this repo's own
     root `.env` to a real key from https://console.anthropic.com/,
     then `docker compose restart librechat`.
   Other providers (`OPENAI_API_KEY`, `AZURE_API_KEY`) can still be set
   directly in `docker/librechat/.env` if you'd rather test against
   those instead.
2. Visit http://localhost:3080 and register an account (this is
   LibreChat's own local auth — `ALLOW_REGISTRATION=true` is set by
   default in the generated env file — separate from Nexus Scheduler's
   own users entirely).
3. Create an Agent in LibreChat's UI, backed by whichever
   provider/model you set up in step 1 (`Ollama (qwen3:0.6b)` will show
   up as its own endpoint in the model picker).
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

`qwen3:0.6b` is a 0.6B-parameter model — small enough to run on CPU
(no GPU required for this Compose setup) reasonably quickly, though
still noticeably slower and less capable than a hosted API. Fine for
confirming the pipeline works end to end, not for judging output
quality. If you have a GPU and want it faster, add a
`deploy.resources.reservations.devices` block to the `ollama` service
per Ollama's own Docker GPU docs — not set up here to keep this
runnable on any machine by default.

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
  PostgreSQL/Redis are bundled as first-party subcharts vendored at
  `charts/postgresql`/`charts/redis` (not Bitnami's — see "Bundled,
  air-gap-friendly PostgreSQL/Redis subcharts" below) — installing this
  chart never requires network access to stand up either dependency.
  Not yet validated with `helm lint`/`helm template` in this environment
  (no Helm CLI available here, and no real cluster to install against)
  — run both before any real deployment.
  A `pre-install,pre-upgrade` Helm hook Job (`templates/migration-job.yaml`)
  runs `prisma db push` against `secrets.databaseSecretName` before
  api/worker are (re)created — see "Database migration Helm hook" below.
- **Reverse proxy**: `nginx.conf` at the repo root is a reference config
  for the environment's pre-existing nginx (REQUIREMENTS §9.1 — this
  chart doesn't deploy nginx itself); it proxies `/api`, `/auth`, and
  `/healthz` to the `-api` Service and everything else to the
  `-frontend` Service, matching `templates/ingress.yaml`'s routing.
  Every upstream address and TLS cert path in it is a placeholder —
  fill those in for the actual environment before use. Distinct from
  `docker/nginx/nginx.conf`, which is Compose-only and much simpler
  since it only ever has to resolve Docker's embedded DNS on one host.
- **Container images**: `packages/{api,worker,pdf-service,frontend}/
  Dockerfile`, all built from the **repo root** as build context, e.g.:
  ```bash
  docker build -f packages/api/Dockerfile -t nexus-scheduler-api .
  ```
  `pdf-service` is the one image with headless Chromium in it — the API
  and Worker images don't need Playwright at all, since they call
  `pdf-service` over HTTP instead of rendering in-process (§2.5; see
  "Isolated PDF-rendering component" below).
  All four currently use `node:20-slim` / `nginx-unprivileged` as
  placeholder base images — REQUIREMENTS.md §3/§9.1/§10 call for Iron
  Bank images and DISA STIG hardening where available; swap the base
  images before this goes near a real environment.

## What's actually implemented vs. stubbed

Implemented (compiles, runs, has been exercised at least via typecheck/
build in this environment):
- Prisma schema modeling the full data model from ARCHITECTURE.md §4
- OIDC login flow (Keycloak client-role → app role mapping, session
  creation) — REQUIREMENTS.md §4
- Audit event writer (Postgres, plus a best-effort RFC 5424 syslog
  mirror — see "Syslog audit-event mirror" below)
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
  - **Admin-set password, in-band** (`POST /api/users/:id/set-password`):
    the emailed reset link is the primary path, but it's a dead end if
    SMTP isn't configured — a real possibility for the break-glass local
    accounts this whole feature exists for. This sets a local account's
    password directly and immediately (bcrypt-hashed, same cost factor
    as login/self-service reset), clearing any pending reset token so a
    stale emailed link can't be used afterward. Frontend: a "Set
    Password" button per local account in the Admin Users panel, with a
    "Generate random password" helper (Web Crypto, not `Math.random()`)
    and a one-time on-screen display of the password just set (it's
    never stored or shown again — the admin has to relay it to the user
    out of band).
  - Frontend: a `/login` page (SSO button + local login form + forgot-
    password), a `/reset-password?token=...` page, and the Admin Users
    panel gained "New Local User", "Send password reset", and "Set
    Password" actions.

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
  Chromium (`page.pdf()`), the engine REQUIREMENTS recommends. Rendering
  itself runs in the isolated `pdf-service` component (its own image/
  Deployment/NetworkPolicy — see "Isolated PDF-rendering component"
  further down); the API calls it over HTTP via
  `@nexus-scheduler/shared`'s `requestRunReportPdf()`.
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
  - Docker/K8s: only the `pdf-service` image builds `packages/pdf` and
    runs `playwright install --with-deps chromium` in its runtime stage
    (installed to a world-readable `/opt/pw-browsers` so the non-root
    `nexus` user can still launch it). The `playwright` dependency is
    pinned to an exact version (not `^`) since each Playwright release
    is tied to a specific bundled Chromium build — letting it float
    could silently drift the installed browser out from under a pinned
    container layer.

- **Isolated PDF-rendering component** (§2.5: "its own pod, no network
  egress by `NetworkPolicy`, independent crash-restart — separate from
  both the API and Worker"): originally shipped as an in-process library
  inside the API (ARCHITECTURE.md's container table did list that as an
  explicit alternative), later split out into its own service:
  - New `packages/pdf-service` workspace: a small Express app
    (`POST /render/run-report`, `POST /render/usage-report`,
    `GET /healthz`/`/readyz`/`/metrics`) that's the only thing in the
    repo importing `@nexus-scheduler/pdf` (and therefore the only image
    with Chromium in it) — the API and Worker call it over HTTP via
    `@nexus-scheduler/shared/pdfServiceClient.ts` instead of rendering
    in-process. Request bodies are zod-validated at this boundary even
    though every caller is internal.
  - Unauthenticated by design: the only two callers (API, Worker) are
    already inside the same trust boundary, and a NetworkPolicy is what
    actually enforces "only they can reach it," not app-layer auth.
  - `helm/nexus-scheduler`: new `pdf-service` Deployment/Service, and
    this repo's **first** `NetworkPolicy` — scoped narrowly to this one
    component rather than attempting a cluster-wide posture in the same
    pass. Ingress is allowed only from the api/worker pod selectors;
    egress is `[]` (deny-all, not even DNS), since
    `renderHtmlToPdf()` only ever calls `page.setContent()` on an
    already-built HTML string it generated itself — it never navigates
    to a URL, so there's nothing for this pod to legitimately reach
    outbound. Helm's default API/Worker resource requests/limits were
    reverted to their pre-Chromium baseline (256Mi/512Mi memory, 1 CPU
    limit) now that neither launches it; `pdfService` in `values.yaml`
    carries the bumped 384Mi/1Gi budget instead.
  - Verified as far as this environment allows: real HTTP round-trips
    against a running `pdf-service` process (both `/render/run-report`
    and `/render/usage-report`, plus a malformed-body 400 case) actually
    produced valid PDF bytes; full clean rebuild/typecheck across all
    six packages; every Helm template (existing and new) re-rendered
    with Go's own `text/template` engine against real `values.yaml` and
    validated as parseable YAML, including the new `NetworkPolicy`'s
    `podSelector`/`ingress`/`egress` structure — `helm template`/`helm
    lint` themselves were still not run (no Helm CLI available in this
    environment; see the Deployment section above). **Not verified**: an
    actual `docker build` of `packages/pdf-service/Dockerfile`, or a
    real in-cluster NetworkPolicy enforcement test — both require
    infrastructure this environment doesn't have network access to.

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

- **Admin usage-report PDF/CSV export and recurring report email**
  (§2.5's third delivery path — the §8 dashboard's org-wide run counts/
  success-failure rate/token usage/cost, exportable on demand and
  emailable to admin-configured recipients on a schedule): unlike the
  run-report PDF and job-completion email, this had no existing
  consumer/producer gap to close — it needed its own admin UI, its own
  render template, and its own schedule concept independent of Job/
  Schedule, since REQUIREMENTS frames it as one admin-wide on/off
  setting with a frequency, not a schedulable entity in its own right.
  - `packages/api/src/routes/adminReports.ts` (new): `GET /api/admin/
    usage-report` (JSON), `.../usage-report/csv` (per-run detail rows),
    and `.../usage-report/pdf` (the same summary as a downloadable PDF),
    all `requireAuth`+`requireAdmin` and audited as
    `usage_report.export`. Defaults to the trailing 30 days when no
    `from`/`to` query params are given.
  - `packages/pdf/src/templates/usageReport.ts` (new): stat-tile summary
    (total runs, success rate, prompt/completion tokens, cost) plus a
    runs-by-status table, sharing the same branding/classification-
    banner header/footer as the run-report PDF.
  - `packages/worker/src/usageReportScheduler.ts` (new): an hourly tick
    checking `AppSettings.usageReportEnabled`/`usageReportRecipients`/
    `usageReportFrequency`/`usageReportLastSentAt` — "has enough time
    elapsed since the last send" is the whole due-or-not rule, deliberately
    not a cron-like next-fire-time column. When due, renders the PDF,
    emails all recipients via the Worker's existing `sendEmail()` with
    the PDF attached, stamps `usageReportLastSentAt`, and records a
    `usage_report.send_email` audit event (a missing SMTP config is a
    quiet skip+warn, same posture as other best-effort email/webhook/
    syslog delivery elsewhere in the app).
  - New `AppSettings` columns (`usageReportEnabled`,
    `usageReportRecipients: String[]`, `usageReportFrequency`,
    `usageReportLastSentAt`) and enum (`UsageReportFrequency`), admin-
    editable in a new "Recurring Usage Report" section of the existing
    System Settings panel; a separate new "Usage Report" panel above it
    provides the on-demand date-range picker and CSV/PDF download
    buttons (plain navigation to the API route rather than a blob fetch,
    so the browser's own Content-Disposition handling covers the
    filename/save-as).
  - Verified via a real rendered PDF (not just typecheck) and a direct
    unit check of the "is a report due" date-math against several
    weekly/monthly/never-sent-yet cases. **Not verified**: an actual
    end-to-end scheduled send (would require a live SMTP server and
    waiting out a real weekly/monthly interval, or bypassing the interval
    check).

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
  - **Shows the Agent's name, not just its ID**: the OpenAI-compatible
    `/v1/models` convention only guarantees an `id` (bare model IDs have
    no display name), so `listLibreChatAgents()`
    (`packages/api/src/librechatDiscovery.ts`) also makes a best-effort
    second call to LibreChat's own Agent Builder listing
    (`GET /api/agents`, what its web UI uses for "My Agents", returning
    real `name` fields) using the same Bearer API key, and merges names
    in by ID. That second endpoint is normally guarded by LibreChat's
    own session/JWT auth rather than Bearer API-key auth, so it may not
    work at all — **also not independently confirmed against a live
    deployment** — but any failure there is swallowed silently; the
    picker still shows bare IDs exactly as before, it just won't have
    friendlier names. Verified against a local stand-in HTTP server
    covering three cases: both endpoints healthy (names shown), only the
    models endpoint working (falls back to IDs, no crash), and the
    models endpoint itself failing (discovery reported unavailable,
    same as before this change).

- **Syslog audit-event mirror** (§7.1): both `audit.ts` files (API and
  Worker) carried an explicit `TODO(§7): mirror this event to syslog`
  since the very first audit-logging round — closed now. New
  `packages/shared/src/syslog.ts` builds one RFC 5424 message per audit
  event, per §7.1's exact field mapping (`TIMESTAMP`/`HOSTNAME`/
  `APP-NAME`/`MSGID` plus the rest as `STRUCTURED-DATA` under a single
  `nexusAudit@32473` SD-ID — `32473` is IANA's reserved
  documentation-use Private Enterprise Number; a real SIEM integration
  should swap in the deployment's own registered PEN), and sends it over
  TCP (RFC 6587 octet-counting framing) or UDP, with TLS optional (RFC
  5425) rather than mandatory. Config lives in the same `AppSettings`
  singleton as SMTP: enabled/host/port/transport/TLS, admin-editable in
  a new Syslog panel alongside SMTP, with a "send test message" button
  (`POST /api/settings/syslog/test`) mirroring the existing SMTP one.
  Best-effort by design, same posture as webhook/email delivery: a
  syslog delivery failure is logged and never affects the audited
  operation itself or the Postgres write, which remains the system of
  record.
  - Verified against real local TCP/UDP/TLS listeners (not just
    typecheck): confirmed the RFC 5424 message structure, confirmed
    RFC 6587's declared length prefix always matches the actual message
    byte length over TCP, confirmed UDP delivers the exact same message
    as a raw datagram, confirmed the TLS path both succeeds against a
    trusted cert and correctly *rejects* an untrusted self-signed one
    (i.e. certificate verification isn't accidentally disabled).

- **Prometheus `/metrics`** (§10/§11): both `/metrics` endpoints were
  literal `"# metrics not yet implemented\n"` placeholders with a TODO
  since the original scaffold — real now, via `prom-client`.
  - **Worker**: `nexus_scheduler_runs_total{status}` (success/failed/
    skipped, incremented on terminal outcomes only — a transient retry
    in progress isn't counted yet), `nexus_scheduler_librechat_call_
    duration_seconds` (histogram around the actual `callAgent()` call,
    not the whole run), and `nexus_scheduler_queue_depth{state}` (pulled
    live from BullMQ's own `getJobCounts()` at scrape time via a Gauge
    `collect()` callback, so it can never drift from the queue's real
    state — `state="active"` doubles as REQUIREMENTS' "running job
    count"). Plus Node's default process metrics (event loop lag,
    memory, GC).
  - **API**: `nexus_scheduler_http_request_duration_seconds{method,
    route, status_code}` (labeled by the matched route pattern, e.g.
    `/api/jobs/:id`, not the raw URL — otherwise metrics would fan out
    one series per distinct ID) plus the same default process metrics.
  - Both Helm Deployments gained `prometheus.io/scrape`/`port`/`path`
    pod annotations for auto-discovery.
  - **Found and fixed via testing, not just reasoning about it**: the
    queue-depth gauge's `collect()` originally awaited
    `queue.getJobCounts()` with no bound. Testing against a genuinely
    unreachable Redis (a real dead TCP port, not just an assertion)
    showed this can hang well past any reasonable scrape interval —
    which would take the *entire* `/metrics` response down with it, not
    just this one gauge. Added a 2-second timeout race around the call;
    re-tested against the same dead Redis and confirmed `/metrics` now
    still returns every other metric within milliseconds, with the
    queue-depth gauge simply omitted for that scrape rather than
    blocking everything.

- **Per-user concurrency limiting** (§2.1: default 5, admin-
  configurable, layered on top of the existing global default-25
  ceiling): `processor.ts` carried an explicit comment that this
  "will need an explicit counter (e.g. a Redis-backed semaphore keyed
  by user id) as a follow-up" — built now, exactly that way.
  - `packages/worker/src/concurrency.ts`: a Redis sorted-set semaphore
    per user (member = run ID, score = slot-expiry timestamp), acquired
    via a single Lua script (atomic prune-expired + check-limit + add,
    so concurrent acquire attempts for the same user can't race past
    the limit) and released via `ZREM` when a run finishes. Attributed
    to the Job's owner (`createdById`) — the only "user" identity
    available on every Run regardless of trigger type — since
    REQUIREMENTS leaves Team/service-owned execution identity as an
    explicit open question (§14) this doesn't try to resolve.
    Self-healing by design: each slot's TTL is the job's own timeout
    plus a 5-minute buffer, so a worker that crashes mid-run without
    releasing its slot doesn't permanently shrink that user's limit —
    it just expires and gets pruned on the next acquire attempt for
    that user.
  - A throttled run is delayed and retried via BullMQ's own
    `DelayedError`/`job.moveToDelayed()` mechanism rather than thrown
    as a normal error — this deliberately does *not* count against the
    job's own retry/backoff budget, since being throttled isn't a
    failure, it's just waiting for a slot to free up.
  - Reuses the Worker's own Redis connection (`worker.client`) rather
    than opening a second one — BullMQ's own `RedisClient` type only
    declares the commands BullMQ itself uses internally, so the
    `eval`/`zrem` calls needed here are made through a small local
    interface cast onto that same underlying connection.
  - Verified against a real local Redis, not just reasoning about it:
    confirmed acquiring up to the limit succeeds and one more is
    correctly throttled; confirmed a different user is unaffected by
    one user's saturation; confirmed releasing a slot lets a throttled
    acquire through; confirmed an expired slot self-heals; and fired 50
    concurrent acquire attempts against a limit of 5 to confirm the Lua
    script's atomicity actually holds under real concurrent load
    (exactly 5 succeeded, not more).

- **Team ownership** (§2.3/§4): originally any editor/admin could
  rename, delete, or manage the membership of *any* Team, and every
  authenticated user could see every Team that existed — Teams had no
  concept of who was responsible for one. Now:
  - `TeamMembership` gained an `isOwner` boolean (a Team can have more
    than one owner); `Team` gained `createdById` so the creator is
    recorded and automatically becomes the first owner at creation time
    (in the same transaction as the Team row itself, so a Team is never
    created ownerless). Legacy Teams from before this change have no
    recorded creator and stay admin-managed-only until an admin
    designates an owner, rather than guessing one from incomplete data.
  - New `getTeamAccess()`/`requireTeamAccess` (`packages/api/src/
    access.ts` / `middleware/requireTeamAccess.ts`, mirroring the
    existing Project-access pattern) gate rename/delete/membership
    management to a Team's own owners — plain members can view but not
    edit. Admins bypass this entirely and can manage any Team
    (REQUIREMENTS §4). Demoting or removing the last remaining owner is
    blocked (400) rather than allowed to silently orphan a Team.
  - `GET /api/teams` — scoped: the Teams management page now calls
    `?mine=true` and sees only Teams the current user directly belongs
    to (admins still see every Team either way); without that param the
    route is **unchanged** and still returns every Team in the org,
    since the Project-sharing "share with a Team" picker and the API
    Key "Team-owned key" picker both depend on that — sharing with, or
    provisioning a key for, a Team you don't personally belong to is
    existing, working behavior neither of those flows should lose.
  - Frontend: an "Owner"/"Member" indicator per Team and per member row,
    "Make Owner"/"Remove Owner" toggle buttons, and Rename/Delete/
    member-management controls that only render at all for an owner or
    admin.
  - Verified against a real local Postgres + Redis (not just
    typechecked): a full HTTP round-trip through the actual running API
    — session-authenticated as four distinct local accounts (a Team
    owner, a plain member, a complete outsider, and a non-member admin)
    — confirmed a Team's creator is auto-owned, a member can view but
    gets 404 attempting to rename/delete/add-members, an outsider gets
    404 from the detail route and is absent from `?mine=true` but still
    present in the unrestricted list, an admin who isn't a member at all
    has full owner-equivalent control, and the last-owner guard blocks
    demotion until a second owner exists, then permits it.

- **Fixed: token counts stuck at zero in usage reports.** Root cause —
  `processor.ts` only ever read `response.usage.prompt_tokens`/
  `completion_tokens` (OpenAI's convention), which "OpenAI-compatible"
  never actually guaranteed LibreChat normalizes every underlying
  provider to (REQUIREMENTS §14 had this flagged as unconfirmed from the
  start). Anthropic's own native Messages API reports usage as
  `input_tokens`/`output_tokens` instead — on a Claude-backed
  deployment, if LibreChat passes that through unnormalized, the
  OpenAI-shaped fields are simply absent and every run silently stored
  `null` token counts, which every report then sums to a flat 0. New
  `extractTokenUsage()` (`packages/worker/src/librechatClient.ts`) tries
  both conventions in order instead of assuming one; a `usage` object
  present but matching neither shape now logs a warning with the raw
  object attached so a still-different shape is diagnosable from Worker
  logs rather than silently swallowed again. Verified directly against
  both real shapes, an unrecognized shape, and a missing `usage` field —
  each resolves exactly as designed.

- **Project ownership is now transferable.** Previously nothing could
  ever change `Project.ownerId` after creation. New
  `POST /api/projects/:id/transfer-ownership` (OWNER-gated, deliberately
  *not* folded into the general EDIT-gated metadata PATCH — see
  `transferProjectOwnershipSchema`'s comment: an EDIT collaborator being
  able to reassign ownership would be a real privilege escalation) sets
  a new owner; the previous owner keeps whatever access, if any, they
  already had via an ACL grant — this is a handoff, not an automatic
  grant. Frontend: a "Transfer Ownership" action next to Delete, visible
  only to the current owner (or an admin). Verified against a real
  running API (Postgres + Redis, real sessions): an EDIT-level
  collaborator's transfer attempt correctly gets 403 while their normal
  metadata edits keep working, the real owner's transfer succeeds and
  they correctly lose OWNER-level access afterward (404, no ACL of their
  own), an admin who was never the owner can transfer regardless, and
  the audit log's recorded `previousOwnerId` is the Project's actual
  prior owner rather than whichever admin happened to perform the
  transfer — a bug caught and fixed during this same verification pass.

- **The branding logo is now also the browser-tab favicon.** No
  separate favicon setting — `SettingsContext.tsx` sets/replaces a
  `<link rel="icon">` element to `settings.logoUrl` whenever it changes,
  the same admin-configured value `AppLayout` and `LoginPage` already
  render as the in-app logo. Left alone (browser default tab icon) when
  no logo is configured, matching those same components not rendering a
  logo `Avatar` at all in that case. Removes and re-inserts the `<link>`
  rather than mutating `.href` in place, since some browsers don't
  reliably re-fetch a changed favicon otherwise. Verified in a real
  headless browser against the built app (not just typechecked): a
  mocked `/api/settings` response with a `logoUrl` produces exactly one
  `link[rel="icon"]` with that exact href, and a `null` logoUrl leaves
  none at all.

- **Dark mode toggle.** A personal display preference, not admin
  branding (§5) — `ColorModeContext` stores it in `localStorage`
  per-browser rather than in `AppSettings`, defaulting to the OS/browser's
  own `prefers-color-scheme` the first time a user visits, before
  they've ever touched the toggle. A sun/moon `IconButton` in the
  `AppBar` (only shown when logged in, alongside the existing
  branding/nav chrome) flips it; `theme.ts`'s `buildTheme()` now takes
  the mode alongside admin branding and passes it straight through to
  MUI's own `palette.mode`, which handles the light/dark color defaults
  (background, text, dividers, etc.) without needing every color
  hand-tuned here. Verified in a real headless browser against the
  built app: confirmed the initial render actually honors both a
  `dark` and a `light` `prefers-color-scheme` emulation, confirmed
  clicking the toggle changes the rendered background color and writes
  `dark`/`light` to `localStorage`, and confirmed a full page reload
  keeps the user's explicit choice rather than reverting to the system
  preference.

- **Bundled, air-gap-friendly PostgreSQL/Redis subcharts.** The chart
  previously declared its PostgreSQL/Redis dependencies against
  Bitnami's real charts (`repository: https://charts.bitnami.com/bitnami`)
  — meaning `helm dependency update`, and therefore `helm install` itself
  for anyone who hadn't already vendored those charts, needed network
  access to a remote chart registry. That's a hard requirement violation
  for REQUIREMENTS §9.1's air-gapped target, not just a nice-to-have.
  This sandbox's own network policy blocks both `charts.bitnami.com` and
  `get.helm.sh` entirely (no `helm` CLI could even be installed here to
  attempt `helm dependency update`), which ruled out actually vendoring
  Bitnami's real chart archives from within this environment — so
  instead:
  - New first-party `charts/postgresql` and `charts/redis` subcharts
    (single-instance StatefulSet + headless Service each, matching
    `postgres:16-alpine`/`redis:7-alpine` — the same images
    `docker-compose.yml`'s local dev stack already uses) are checked
    directly into this repository. `Chart.yaml`'s `dependencies:` no
    longer has a `repository:` field at all — Helm resolves a
    same-name/same-version dependency from the local `charts/`
    directory automatically when none is given, so `helm install`/`helm
    package` never touch the network for these two dependencies.
    Deliberately far smaller in scope than Bitnami's charts (no
    replication, no metrics exporter, no cluster mode) — this app only
    ever needs one instance of each, same as the Compose stack.
  - **Secrets reorganized**: `DATABASE_URL`/`REDIS_URL` moved out of the
    catch-all `secrets.appSecretName` into their own dedicated
    `secrets.databaseSecretName`/`secrets.redisSecretName`, each with a
    values.yaml comment documenting the exact expected key and
    connection-string format. This applies whether PostgreSQL/Redis are
    the bundled subcharts or bring-your-own external instances — the
    app itself only ever reads from these two secrets either way. The
    bundled subcharts additionally read their *own* operational
    password from a separate pre-existing secret
    (`postgresql.auth.existingSecretName`/`redis.auth.existingSecretName`,
    expecting `postgres-password`/`redis-password` keys) — comments in
    both `values.yaml` and `NOTES.txt` spell out that these are two
    related-but-separate secrets an operator must populate consistently
    (same password in both), since nothing here auto-generates or
    cross-references one from the other, matching this chart's existing
    "nothing is ever created or guessed by the chart itself" posture.
  - Known simplification, called out directly in both subcharts'
    `values.yaml`: neither forces a non-root `runAsUser` for its
    container. The upstream `postgres` image starts as root and drops
    privileges internally (via `gosu`) unless launched as a non-root UID
    from the start, and `redis`'s image doesn't guarantee a stable UID
    across tags — forcing either without a real cluster available in
    this environment to verify the resulting boot behavior against
    risked shipping an untested, possibly-broken first boot. Revisit
    alongside this repo's other placeholder-hardening TODOs
    (REQUIREMENTS §3/§9.1/§10) once a real cluster exists to validate
    against.
  - Verified as far as this environment allows (no Helm CLI, no real
    cluster): every template across the parent chart and both new
    subcharts — including the `ternary` Sprig function used in the
    Redis StatefulSet — re-rendered cleanly
    through a hand-built Go `text/template` harness (matching real
    Helm's own template engine) against the actual merged values (parent
    overrides applied over each subchart's own defaults, mirroring real
    Helm subchart value passthrough), and every rendered document
    validated as parseable YAML. `NOTES.txt` was rendered and read
    through the same way. **Not verified**: an actual `helm
    install`/`helm template`/`helm lint` run, or real container boot
    behavior for either subchart — both require tooling/infrastructure
    unavailable in this environment.

- **Database migration Helm hook.** `docker-compose.yml` has always had a
  dedicated `migrate` service (`prisma db push`) that `api`/`worker` wait
  on via `depends_on.migrate.condition: service_completed_successfully`,
  but the Helm chart had no equivalent at all — nothing in the chart ever
  actually pushed the Prisma schema to a fresh database. Added
  `templates/migration-job.yaml`: a `batch/v1` Job annotated as a
  `pre-install,pre-upgrade` Helm hook (Helm blocks on hook Jobs before
  applying the rest of the release, the same ordering guarantee Compose's
  `depends_on` gives locally), using the same `-api` image and reading
  `secrets.databaseSecretName` like the api/worker Deployments do. It
  invokes `node_modules/.bin/prisma db push` directly rather than `npx
  prisma` — the api image's build stage already ran `prisma generate`
  and `npm ci` (downloading the schema-engine binary into
  `node_modules/@prisma/engines` while the filesystem was still
  writable), so the Job only ever reads what's already in the image and
  talks to the database over the network. `npx prisma` would instead
  re-check for that binary at container *runtime* and, finding the
  writable-filesystem assumption violated under this chart's
  `readOnlyRootFilesystem: true` container hardening, fail with `Can't
  write to .../node_modules/@prisma/engines please make sure you install
  'prisma' with the right permission` — which is almost certainly what
  happens to anyone who improvises a migration step against this chart
  before this fix. The Job's own container securityContext deliberately
  sets `readOnlyRootFilesystem: false` (everything else — non-root,
  no privilege escalation, all capabilities dropped — matches
  api/worker): Prisma still writes a small per-invocation lock file
  alongside the pre-baked engine binary even when it isn't downloading
  anything, and this Job only ever runs as a short-lived hook rather than
  an always-on service, so the tradeoff is scoped tightly. Verified the
  same way as the rest of this chart in this sandbox (no Helm CLI, no
  real cluster): rendered through the hand-built template harness against
  merged values and validated as parseable YAML. **Not verified**: an
  actual `helm install` exercising the hook Job against a real database.

Stubbed / not yet built: nothing outstanding from this list as of this
round — see REQUIREMENTS.md for the full feature set the app should
implement, and each bullet above for the specific caveats/known
simplifications still worth a look (e.g. the one-time-schedule timezone
picker, webhook retry policy, and the various "not independently
verified against a live LibreChat/SMTP/syslog endpoint" notes).
