# Nexus Scheduler

[![CI](https://github.com/schuecl/nexus-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/schuecl/nexus-scheduler/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/schuecl/nexus-scheduler/pulls)

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

- **Dashboard** — a landing overview scoped to the Projects you can see:
  run counts by status, an overall success rate, the 10 most recent
  runs, and the next 10 upcoming schedule fires.
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
- **Run history & manual runs** — full history per Job with output
  (rendered as markdown, since most agent models format their answers
  that way), status, token usage, and cost, plus an on-demand "Run Now"
  button alongside the schedule.
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
  works independent of SSO availability, with its own self-service
  "forgot password" email flow.
- **Branding & classification** — configurable product name, logo
  (doubles as the favicon), accent color, dark mode, and an optional
  persistent classification banner with admin-managed labels.
- **Login-screen consent banner** — an optional, admin-configurable
  notice (custom title/body) shown before authentication. It can be
  purely informational, or require an explicit Accept/Reject before the
  sign-in form is shown at all — rejecting leads to a dead-end page,
  and acceptance is audit-logged. Re-shown on every visit to the login
  page rather than remembered, matching how consent-to-monitor banners
  are expected to behave.
- **Observability** — Prometheus metrics from every service (including
  per-model LLM latency, token consumption and error kinds), a
  Postgres-backed audit log, and an optional RFC 5424 syslog mirror for
  SIEM integration. An optional Grafana/Alloy/Mimir/Loki stack for local
  development ships as a separate Compose file.
- **Admin console** — user/role management, classification taxonomy,
  cost rates, and the webhook destination allow-list.
- **Built-in Knowledge Base** — a searchable, offline (bundled, no
  external content service) help center covering every module and
  common troubleshooting, linked contextually from empty states
  throughout the app.

## Tech stack

| Package | What it is |
|---|---|
| `packages/shared` | Prisma schema/client, shared types, zod schemas, scheduling/crypto utilities |
| `packages/api` | Express backend — auth (OIDC + local fallback), CRUD, audit log |
| `packages/worker` | BullMQ-based scheduler/worker — fires due schedules, calls LibreChat, retries |
| `packages/pdf` / `packages/pdf-service` | Playwright-based HTML→PDF rendering, run as an isolated internal service |
| `packages/frontend` | React + Vite + MUI single-page app |
| `packages/e2e` | Playwright end-to-end smoke test over the critical path (login → schedule → run) |

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
| LiteLLM admin (model spend/budgets/keys) | http://localhost:4000/ui (log in with `LITELLM_MASTER_KEY` from `.env`) |

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
   - **Local models via LiteLLM → Ollama** — free, no API key needed.
     `gemma3:1b` (default chat), `codegemma:2b` (coding) and
     `phi4-mini-reasoning:3.8b` (reasoning) pull automatically on first
     `docker compose up` (~5.6GB of disk, loaded into RAM one at a
     time; needs internet the first time only). LiteLLM is the gateway
     in front of Ollama: it meters every call — per-key spend, hard
     budgets, rate limits — which is the usage data LibreChat's Agents
     API doesn't report (#38). Small CPU-only models are fine for
     exercising the pipeline but weak at tool calling; for real agentic
     work add a hosted model behind the same gateway
     (`docker/litellm/config.yaml`).
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

**Adding LiteLLM to an existing `.env`**: re-run
`./scripts/generate-local-env.sh` — it appends freshly generated
`LITELLM_MASTER_KEY`/`LITELLM_SALT_KEY`/`LITELLM_POSTGRES_PASSWORD`/
`LITELLM_LIBRECHAT_KEY` lines to an existing `.env` that predates the
LiteLLM gateway, without touching any existing values. LibreChat
authenticates to the gateway with the `LITELLM_LIBRECHAT_KEY` virtual
key (provisioned automatically by the `litellm-init` service); the
master key is the admin credential — use it for the `:4000/ui`
dashboard and to attach budgets/rate limits to the LibreChat key.

</details>

### Observability stack (optional)

The app ships Prometheus metrics; this brings up somewhere to put them —
Grafana with dashboards, backed by Mimir (metrics) and Loki (logs),
collected by a single Alloy agent. Entirely optional: the app runs
without it, and the stack is a separate Compose file precisely so it can
be left off.

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
# Grafana -> http://localhost:3300   (anonymous admin, dev only)
```

To turn it off again, just drop the second `-f` — nothing in
`docker-compose.yml` depends on it.

Eleven dashboards are provisioned automatically, covering the app
(overview, API, worker, PDF service), the models (per-model latency,
tokens, errors, spend, and local-vs-hosted savings), the infrastructure
(Postgres, Redis, containers, host), the logs, and the collector itself.
That last one matters more than it sounds: if the collector stops
shipping, every other dashboard goes flat and looks exactly like a
healthy, idle system — this is the only place that tells the two apart.

Two small exporters fill gaps the upstream components leave. LiteLLM's
OSS proxy has no `/metrics` endpoint (Prometheus export is an enterprise
feature), so `litellm-exporter` turns its spend log into the counters the
cost dashboard needs. And cAdvisor cannot read the cgroup tree on Docker
Desktop's VM, so `container-stats-exporter` sources the same per-container
numbers from the Engine API instead — it sits behind a Compose profile, so
on Docker Desktop add `--profile docker-desktop` to the command above or
the container panels stay empty:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml \
  --profile docker-desktop up -d
```

Everything runs locally — no cloud, no external endpoints. Ports 3000
and 3001 belong to the api and worker, so Grafana takes 3300.

For Kubernetes, do **not** use this file — see the Helm notes under
[Deployment](#kubernetes-helm): a real cluster already has a monitoring
stack, and the app only needs to be scraped by it.

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
- Metrics are exposed by every service and collected by whatever the
  cluster already runs — this chart deliberately does not deploy
  Alloy/Mimir/Loki/Grafana. Two supported paths:
  - **Prometheus Operator**: set `observability.serviceMonitor.enabled:
    true` to render a ServiceMonitor per service. Off by default because
    it needs the Operator's CRD, and applying one without it fails the
    install. Most Operator installs also select ServiceMonitors by label
    — set `observability.serviceMonitor.labels` (commonly `release:
    kube-prometheus-stack`) or the objects are silently ignored, which
    looks identical to the app not exposing metrics at all.
  - **Annotation-based scraping**: nothing to enable — the api and worker
    pods already carry `prometheus.io/scrape`.
  Either way, **pdf-service is not scrapeable in Kubernetes** and its
  dashboard will be empty there. That is a deliberate consequence of the
  isolation it is under, not a Prometheus misconfiguration: its `/metrics`
  and its `POST /render/*` endpoints are the same listener on the same
  port, and its NetworkPolicy admits only the api and worker, so nothing
  can collect the metrics without also exposing the renderer. Making them
  collectable needs a dedicated metrics port — tracked upstream in
  [#118](https://github.com/schuecl/nexus-scheduler/issues/118). The
  Compose stack is unaffected: it has no NetworkPolicy, so all three are
  scraped locally.
  The Grafana dashboards in `observability/grafana/dashboards/` are
  plain JSON and can be imported or mounted as ConfigMaps for the
  Grafana sidecar; they are not shipped in the chart, so they cannot
  drift from the copies used by the Compose stack.

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
typechecking/builds, a Playwright end-to-end smoke test over the
critical path, and, for security- and correctness-sensitive paths,
direct verification against a real Postgres/Redis/API stack. Every
service image is scanned with Trivy and gates CI on fixable
CRITICAL/HIGH findings; `helm lint`/`helm template` + manifest schema
validation run on every chart change. Some production-hardening items
remain follow-ups rather than done — notably swapping `node:20-slim`/
`nginx-unprivileged` for an Iron Bank equivalent and applying the DISA
STIG baseline (see the `TODO` comments at the top of each
`packages/*/Dockerfile`), and a full `helm install` pass against a real
cluster.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md)
for how to get set up, run the checks CI runs, and submit a pull
request. Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/);
first-time contributors sign off once in
[CONTRIBUTORS.md](./CONTRIBUTORS.md). All project spaces are governed
by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, please follow the process in
[SECURITY.md](./SECURITY.md) — use GitHub's private vulnerability
reporting rather than a public issue.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](./LICENSE).
The intent behind this project's open-source release is described in
[INTENT.md](./INTENT.md).
