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
- **Observability** — Prometheus metrics, a Postgres-backed audit log,
  and an optional RFC 5424 syslog mirror for SIEM integration.
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

Every multi-file compose invocation below also has a canonical Make
target (`make env`, `make up`, `make up-obs`, `make verify`, the test
suites, …) so nobody has to retype the `-f` chains — run `make help`
for the list. A gitignored `docker-compose.override.yml` is applied
automatically by every target when present, for local-only tweaks.

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

### OCR for attachments and chat uploads (optional)

Scanned PDFs and photos carry no text until something reads them. The
`ocr` service does that for **both** callers — Nexus Scheduler job
attachments and LibreChat chat uploads — and is part of the default
Compose stack, so `docker compose up` already starts it.

```
  browser ──▶ nginx ──┬──▶ librechat ──▶ POST /v1/ocr ────┐
                      │      (Mistral OCR API shape)      │
                      │                                   ▼
                      └──▶ api ──▶ postgres          ┌─────────┐
                                      │             │   ocr   │  ocr-net
                                      │  at run time│  :4200  │  internal:true
                                      └──▶ worker ──▶└────┬────┘  (no internet)
                                        POST /process       │
                                                            │ only if descriptions
                                                            ▼   are enabled
                                                    litellm ──▶ ollama
```

Text extraction runs entirely inside the container — Tesseract, OCRmyPDF
and docling, with the language data and layout models baked into the
image. Nothing is fetched at runtime, and `ocr-net` is declared
`internal: true`, so the service has no route off the host. The only
outbound call is the optional image *description* step, which is a real
model call and therefore goes through the LiteLLM gateway.

A PDF that already has a text layer costs no OCR at all — `ocrmypdf
--skip-text` passes those pages straight through, so only genuinely
scanned pages reach Tesseract.

#### How each caller reaches it

**Nexus Scheduler attachments** — the worker calls `POST /process` once
per attachment. Configured on the `worker` service in
`docker-compose.yml`, already wired:

```yaml
worker:
  environment:
    OCR_SERVICE_URL: http://ocr:4200
    OCR_DESCRIBE_IMAGES: ${OCR_DESCRIBE_IMAGES:-false}
    OCR_EXTRACTED_TEXT_MAX_CHARS: ${OCR_EXTRACTED_TEXT_MAX_CHARS:-80000}
```

`OCR_SERVICE_URL` is the only required one — left empty, Jobs with
attachments still run, with a warning per run and no extracted text.
`OCR_EXTRACTED_TEXT_MAX_CHARS` caps how much extracted text is appended
to the prompt, so a long document cannot crowd out the prompt itself.

Attach files to a Job on its Project page under **Files**; the extracted
markdown is appended to the prompt before the agent is called, and both
the text and a searchable PDF are kept on the run record. See the in-app
Knowledge Base article **Document OCR & attachments** for the full
walkthrough.

**LibreChat chat uploads** — configured in
`docker/librechat/librechat.yaml`:

```yaml
ocr:
  strategy: "mistral_ocr"          # presents our service as Mistral's OCR API
  baseURL: "http://ocr:4200/v1"
  apiKey: "network-isolated-no-key"
  mistralModel: "nexus-ocr"
```

LibreChat has no "point at my own OCR service" strategy — its
`custom_ocr` is documented upstream as *Planned* — so the service
implements the Mistral OCR API shape instead. Nothing leaves the host:
`baseURL` is the local container.

#### Knobs

Every one is an env var with a working default; set them in `.env`.

| env var | default | affects |
|---|---|---|
| `IMAGE_DPI` | `300` | both — photos and PNGs often carry no DPI, and OCRmyPDF refuses input without one |
| `OCR_MAX_PROCESS_SECONDS` | `900` | both — hard ceiling on one extraction. Raise for large scans on CPU |
| `OCR_FILE_MAX_BYTES` | 15 MiB | both — per-upload limit, returned as 413 |
| `OCR_FILE_STORE_MAX_BYTES` | 256 MiB | LibreChat uploads — total retained bytes in the file store |
| `OCR_PROCESS_MAX_FILES` | `10` | Nexus attachments — files per `/process` call |
| `OCR_PROCESS_MAX_TOTAL_BYTES` | 50 MiB | Nexus attachments — total bytes per call |
| `OCR_DESCRIBE_IMAGES` | `false` | both, in Compose — see below |
| `OCR_DESCRIBE_MIN_BUDGET_S` | `60` | descriptions — floor below which the step is skipped rather than started and abandoned |
| `LITELLM_OCR_KEY`, `OCR_VISION_MODEL` | empty | descriptions — the gateway key and model |

`OCR_EXTRACTED_TEXT_MAX_CHARS` is a **worker** setting, not a service
one: it caps how much extracted text is appended to the prompt.

#### Optional: image descriptions

OCR reads text; it cannot say what a photo *is*. Setting
`OCR_VISION_MODEL` and `LITELLM_OCR_KEY` alongside
`OCR_DESCRIBE_IMAGES=true` adds a one-paragraph description from a
multimodal model via the gateway.

The model must actually be multimodal. The default set (`gemma3:1b`,
`codegemma:2b`, `phi4-mini-reasoning`) is text-only, and pointing at one
fails quietly — descriptions are best-effort, so the symptom is missing
descriptions plus gateway 400s in the logs, not an error.

Unset (the default), no gateway call is ever made and extraction is
text-only.

#### On Kubernetes

Do not use this file. The OCR service is its own chart —
see [`helm/ocr/README.md`](helm/ocr/README.md) for install and wiring,
and [Three-chart Kubernetes wiring](docs/three-chart-wiring.md) for the
order the three charts go in. One difference worth knowing: on
Kubernetes the two callers have **separate** description switches
(`ocr.describeImages` in the app chart, `gateway.describeImages` in the
OCR chart), because they are separate releases. In Compose one service
instance serves both, so `OCR_DESCRIBE_IMAGES` covers both.

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

For a local/dev cluster (Docker Desktop, kind), each chart ships a
committed override file so nothing has to be reconstructed from the
templates: build the images locally (see [Container
images](#container-images)), create the Secrets `NOTES.txt` lists, then

```bash
helm install nexus-scheduler helm/nexus-scheduler -f helm/nexus-scheduler/values-local.yaml
helm install nexus-observability helm/observability -f helm/observability/values-local.yaml
```

For the exact install order and cross-namespace values that connect the
application, OCR, and AI-plane charts, see
[Three-chart Kubernetes wiring](docs/three-chart-wiring.md).

- PostgreSQL and Redis are bundled as first-party subcharts
  (`helm/nexus-scheduler/charts/{postgresql,redis}`) so a default
  install needs no external dependencies or network access to stand
  them up. Set `postgresql.enabled: false` / `redis.enabled: false` to
  bring your own instead.
- **Clusters with mutating admission webhooks** (Zarf's agent, some
  policy engines, service meshes): these can silently rewrite every
  pod's image reference — e.g. Zarf points them at its internal
  registry (`127.0.0.1:31999/...-zarf-<hash>`), which surfaces as
  `ImagePullBackOff` on images that exist and pull fine by hand. If
  your images aren't published to the webhook's registry, exclude the
  namespace before installing (for Zarf:
  `kubectl label --overwrite ns <namespace> zarf.dev/agent=ignore`) or relocate
  the images to the registry the webhook rewrites to. Diagnosis tell:
  list every init and regular container image and compare the references
  with what the chart rendered:

  ```bash
  kubectl get pod <pod> -o \
    jsonpath='{range .spec.initContainers[*]}{.image}{"\n"}{end}{range .spec.containers[*]}{.image}{"\n"}{end}'
  ```
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
