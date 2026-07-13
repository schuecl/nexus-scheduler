# Nexus Scheduler

Nexus Scheduler is a web application for scheduling and managing agentic
AI tasks against a [LibreChat](https://www.librechat.ai/) Agents API
deployment. Point it at a saved prompt and a LibreChat Agent, decide
when it should run — once, or on a recurring interval — and Nexus
Scheduler handles the rest: execution, retries, approvals, notifications,
auditing, and reporting.

It's designed for teams that need to run AI-assisted tasks on a schedule
in a controlled, auditable way — including fully network-restricted /
air-gapped environments, where every dependency is either bundled or
explicitly configured rather than fetched at install time.

![Dashboard](./docs/screenshots/dashboard.png)
![Project detail](./docs/screenshots/project-detail.png)

## Features

- **Scheduling** — one-time or recurring (interval-based, timezone-aware)
  schedules for any Job, with pause/resume and prompt-version pinning.
- **Prompt Library** — prompts are versioned (every edit creates a new
  immutable version, so a schedule pinned to a specific version never
  changes underneath it), support `{{variable}}` placeholders with
  per-schedule overrides, and are searchable/taggable/favoritable across
  every project you have access to. Built-in variables like `{{date}}`,
  `{{run_id}}`, and `{{owner_email}}` are resolved automatically at run
  time.
- **Projects & Teams** — prompts and jobs live inside a Project, shared
  with individual users, Teams, or the whole organization at read or
  edit access. Teams can be nested (membership inherits down the
  hierarchy) and have their own owners, distinct from Project owners.
- **Maker-checker approvals** — schedules in a shared Project require
  approval from an eligible approver (other than whoever made the
  change) before they'll actually run; private-project schedules
  auto-approve.
- **Run history & manual runs** — full history per Job with output,
  status, token usage, and cost, plus an on-demand "Run Now" button
  alongside the schedule.
- **Usage & cost reporting** — per-run token/cost tracking with
  configurable rates, an admin usage dashboard, CSV/PDF export, and
  optional recurring report emails.
- **PDF reports** — on-demand, branded PDF export of any run's output or
  the admin usage dashboard, rendered by an isolated internal service.
- **Notifications & webhooks** — optional email on job completion/
  failure (with the PDF attached), and outbound webhook delivery to
  admin-allow-listed destinations, HMAC-signed so receivers can verify
  authenticity.
- **SSO** — OIDC login (tested against Keycloak) with role mapping from
  IdP client roles, plus a local break-glass admin account that always
  works independent of SSO availability.
- **Branding & classification** — configurable product name, logo
  (doubles as the favicon), accent color, dark mode, and an optional
  persistent classification banner with admin-managed labels.
- **Observability** — Prometheus metrics, a Postgres-backed audit log,
  and an optional RFC 5424 syslog mirror for SIEM integration.
- **Admin console** — user/role management, classification taxonomy,
  cost rates, and the webhook destination allow-list.

## Tech stack

| Package | What it is |
|---|---|
| `packages/shared` | Prisma schema/client, shared types, zod schemas, scheduling/crypto utilities |
| `packages/api` | Express backend — auth (OIDC + local fallback), CRUD, audit log |
| `packages/worker` | BullMQ-based scheduler/worker — fires due schedules, calls LibreChat, retries |
| `packages/pdf` / `packages/pdf-service` | Playwright-based HTML→PDF rendering, run as an isolated internal service |
| `packages/frontend` | React + Vite + MUI single-page app |

TypeScript everywhere, in an npm workspaces monorepo. PostgreSQL is the
system of record; Redis backs the job queue and concurrency limiting.

## Getting started

Requires Node 20+, npm 10+, and Docker.

```bash
npm install
npm run prisma:generate
npm run build       # builds shared -> pdf -> pdf-service -> api -> worker -> frontend, in order
```

### Run the full stack with Docker Compose

This brings up Postgres, Redis, Keycloak (for SSO), Mailpit (catches
outbound email), a local syslog receiver (for testing the audit-event
mirror), a local LibreChat instance, and the app itself — a complete
environment for trying Nexus Scheduler out or developing against it.

```bash
./scripts/generate-local-env.sh   # writes .env + docker/librechat/.env — do this once
docker compose up --build
```

Then:

| Service | URL |
|---|---|
| Nexus Scheduler | http://localhost:8080 |
| Mailpit (catches outbound email) | http://localhost:8025 |
| Keycloak admin console | http://localhost:8081 (`admin` / see `.env`) |
| LibreChat | http://localhost:3080 |

Log in to Nexus Scheduler with "Sign in with password" using
`BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` from `.env` (defaults
to `admin@nexus-scheduler.local`). From Admin Settings:
- Point SMTP at Mailpit (`host: mailpit`, `port: 1025`, no auth/TLS) to
  test password reset and notification emails.
- Point syslog at `syslog-test` to test the audit-event mirror —
  `host: syslog-test`, and `port`/`transport`/`tls` per whichever of its
  three listeners you want to exercise: `514`/UDP, `601`/TCP, or
  `6514`/TCP with TLS enabled (upload
  `docker/generated/syslog-test-certs/ca.pem`, written by
  `generate-local-env.sh`, as the CA certificate). Delivered messages
  show up in `docker compose logs -f syslog-test`.

Keycloak has no realm pre-provisioned — create one manually if you want
to test SSO login end to end.

**Connecting to LibreChat** (this part is LibreChat's own UI flow, not
scriptable):

1. Pick a model provider. Two are wired up already:
   - **Ollama running `qwen3:0.6b`** — free, local, no API key needed.
     Pulls automatically on first `docker compose up` (~0.5GB, needs
     internet the first time only).
   - **Claude** — set `ANTHROPIC_API_KEY` in this repo's root `.env` to
     a real key, then `docker compose restart librechat`.

   (`OPENAI_API_KEY`/`AZURE_API_KEY` also work if you'd rather test
   against those — set them in `docker/librechat/.env`.)
2. Visit http://localhost:3080 and register an account — this is
   LibreChat's own local auth, separate from Nexus Scheduler's users.
3. Create an Agent in LibreChat's UI, backed by whichever provider you
   set up above.
4. Generate a LibreChat API key for that account.
5. Back in Nexus Scheduler, add that key under **API Keys**, then pick
   the Agent when creating a **Job** — Nexus Scheduler will try to
   auto-discover the available Agents for that key; if discovery isn't
   available for your LibreChat version, paste the Agent ID directly
   instead.

<details>
<summary>Troubleshooting</summary>

**"password authentication failed" on `postgres`/`migrate`**: Postgres
only sets its password when its data volume is first initialized. If
you change `POSTGRES_PASSWORD` in `.env` after the volume already
exists, it keeps the old password. Fix by resetting the local volumes
(this also resets Redis and LibreChat's local data — fine for a dev
stack, not something to do against real data):

```bash
docker compose down -v
docker compose up --build
```

**Adding LibreChat to an existing `.env`**: `generate-local-env.sh`
never overwrites an existing `.env`. If you had one from before
LibreChat support was added, add these two lines by hand:

```
LIBRECHAT_BASE_URL=http://librechat:3080
ANTHROPIC_API_KEY=
```

</details>

### Running a single package against the Compose infra

```bash
npm run dev --workspace=packages/api      # or packages/worker, packages/frontend
```

Point `DATABASE_URL`/`REDIS_URL` at the Compose-exposed ports
(`5432`/`6379`) via a local `.env` in that package, or export them in
your shell.

## Configuration

Nexus Scheduler is configured primarily through environment variables
(deployment-time settings) plus an in-app Admin Settings page
(branding, classification, SMTP, syslog, cost rates — anything an admin
might reasonably change without a redeploy).

Key environment variables (see `packages/api/src/config.ts` and
`packages/worker/src/config.ts` for the full list and defaults):

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres/Redis connection strings |
| `SESSION_SECRET`, `API_KEY_ENCRYPTION_KEY` | Session signing and at-rest encryption keys |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | SSO configuration (optional — omit to run local-account-only) |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | Break-glass local admin account, re-synced on every startup |
| `LIBRECHAT_BASE_URL` | Base URL of the LibreChat deployment to call |
| `PDF_SERVICE_URL` | Internal URL of the PDF rendering service |
| `GLOBAL_MAX_CONCURRENT_RUNS`, `PER_USER_MAX_CONCURRENT_RUNS` | Worker concurrency limits (defaults: 25 global, 5 per user) |

SSO roles are mapped from OIDC client roles (`resource_access.<client
id>.roles`), matched against Nexus Scheduler's three roles — `ADMIN`,
`EDITOR`, `VIEW` — falling back to `VIEW` if none match. See
`helm/nexus-scheduler/values.yaml`'s `oidc` section for the full claim
mapping and a worked example.

## Deployment

### Kubernetes (Helm)

```bash
helm install nexus-scheduler helm/nexus-scheduler -f my-values.yaml
```

- PostgreSQL and Redis are bundled as first-party subcharts
  (`helm/nexus-scheduler/charts/{postgresql,redis}`) so a default
  install needs no external dependencies or network access to stand
  them up. Set `postgresql.enabled: false` / `redis.enabled: false` to
  bring your own instead.
- Connection strings are built automatically (with proper URL-encoding)
  from discrete secret fields (username/password/database) rather than
  requiring a hand-composed connection string — see `values.yaml`'s
  comments for the exact secret shape.
- A database migration Job (`prisma db push`) runs alongside the rest of
  the release and retries for a few minutes until Postgres is reachable
  — expect a few CrashLoopBackOff restarts on api/worker until it
  completes on a fresh install, which is normal.
- Custom CA trust for the LibreChat connection is supported via
  `librechat.tls.caBundle`, for environments where LibreChat's
  certificate chains to an internal CA.
- This chart does not deploy a reverse proxy — it exposes a plain
  Service/Ingress for an existing nginx (or similar) to target. A
  reference `nginx.conf` is included at the repo root.
- Run `helm template`/`helm lint` against your own values before
  installing, and see the chart's `NOTES.txt` (printed after install)
  for the exact list of Secrets that must exist beforehand.

### Container images

Each service has its own Dockerfile, all built from the **repo root**
as build context:

```bash
docker build -f packages/api/Dockerfile -t nexus-scheduler-api .
docker build -f packages/worker/Dockerfile -t nexus-scheduler-worker .
docker build -f packages/pdf-service/Dockerfile -t nexus-scheduler-pdf-service .
docker build -f packages/frontend/Dockerfile -t nexus-scheduler-frontend .
```

`pdf-service` is the only image that bundles a headless browser (for PDF
rendering) — the API and Worker call it over HTTP rather than rendering
in-process.

## Database schema changes

The schema lives at `packages/shared/prisma/schema.prisma`.

```bash
npm run prisma:generate --workspace=packages/shared   # regenerate the client after a schema change
npm run prisma:migrate --workspace=packages/shared    # create a migration
```

## Project status

Actively developed. Core scheduling, approvals, sharing, reporting, and
admin functionality are implemented and exercised via automated
typechecking/builds and, for security- and correctness-sensitive paths,
direct verification against a real Postgres/Redis/API stack. Some
production-hardening items — e.g. swapping placeholder base container
images for a hardened equivalent, and a full `helm lint`/`helm install`
pass in a real cluster — are tracked as follow-ups rather than done.
