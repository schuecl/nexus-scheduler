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

Stands up Postgres, Redis, Keycloak, Mailpit, and the app itself — see
REQUIREMENTS.md §9.2 for what this is (and isn't) meant to validate.

```bash
./scripts/generate-local-env.sh   # writes .env with random local secrets — do this once
docker compose up --build
```

Then:
- App (behind local nginx): http://localhost:8080
- Mailpit (catches outbound email): http://localhost:8025
- Keycloak admin console: http://localhost:8081 (`admin` / see `.env`)

Keycloak has no realm pre-provisioned yet — create a `nexus-scheduler`
realm and client manually to test the OIDC login flow end to end.

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
    role and active-status toggles. A user can't demote or deactivate
    their own account (enforced both client- and server-side). Does
    **not** include local-account creation or a local login flow —
    OIDC-created users only; break-glass local auth is still a gap (see
    below).
  - **Cost rates** (§8): same "consumer with no producer" shape as the
    recent Prompt-variable and webhook gaps — the Worker's
    `costCalculator.ts` has looked up `CostRate` rows since the Usage &
    Reporting work, but there was no way to create one, so every run's
    cost was silently "not costed." Admin CRUD now exists (global
    default or per-agent rate, $ per million prompt/completion tokens).

Stubbed / not yet built: PDF report generation, per-user concurrency
limiting (only the global limit is enforced today), Prometheus metrics,
syslog output, SMTP configuration, and local-account creation/login
(the `passwordHash`/`AuthSource.LOCAL` fields have existed in the
schema since the original scaffold, but there is still no way to
create a local account or log in with one — OIDC is the only working
login path). See REQUIREMENTS.md for the full feature set these should
implement.
