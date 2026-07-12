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
- A `jobs` CRUD slice proving the Express + Prisma + zod + audit pattern
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
- Frontend shell: routing, MUI theme, the classification banner
  component, an OIDC-aware auth context, working Teams/Projects pages
  (create, browse, manage membership, manage sharing), a Prompts panel
  inside each Project's detail view, and a top-level Prompt Library page
  for org-wide search/tag/favorites discovery

Stubbed / not yet built: prompt **variable substitution UI** (the
`{{variable}}` declaration form — the worker already resolves them at
run time, §2.3, but there's no UI to declare non-default values yet),
schedule approval workflow, PDF report generation, webhook delivery,
per-user concurrency limiting (only the global limit is enforced
today), Prometheus metrics, syslog output, most of the admin UI (user
management, branding, classification-taxonomy editing, cost rates,
SMTP config), and the Jobs/Schedules pages don't yet let you pick a
Prompt when creating a Job (the API supports it — `POST /api/jobs`
already takes a `promptId` — the UI just doesn't expose the picker
yet). See REQUIREMENTS.md for the full feature set these should
implement.
