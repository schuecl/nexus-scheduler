# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/). Every
workspace package, the Helm chart, and the built image tags move in lockstep
under a single version — this isn't a set of independently published
packages, so there's no per-package versioning here (see `scripts/release.mjs`).

## [Unreleased]

## [0.2.0] - 2026-07-21

### Added

- Self-hosted, airgapped OCR pipeline for job attachments (#158): a new
  `docker/ocr` service extracts text from scanned/image PDFs and images
  (docling + tesseract, with an optional Mistral-shaped `/v1/ocr` vision
  path for image descriptions) so LibreChat and Job attachments both get
  usable text instead of a blank page. Ships as a fourth compose/Helm
  chart (`helm/ocr`) with its own run-budget, file-size, and
  total-request-size guards, all env/value-driven so an airgapped site
  never has to rebuild an image to raise a limit. Includes full Compose
  and Kubernetes wiring documentation, a three-chart integration guide,
  and a Knowledge Base article covering limits, tuning, and the
  image-description trap (each caller — LibreChat chat uploads vs.
  scheduler attachments — has its own on/off switch, since LibreChat's
  request shape carries no per-request flag) (fixes #129, #130, #142,
  #148, #149).
- Saved, per-user mailing lists for Job email notifications (#219): a
  new *Mailing Lists* page lets any user save up to 100 addresses under
  a name they own, then attach up to 5 lists to a Job from the existing
  post-creation Notifications dialog alongside CC recipients. List
  emails are merged with the Job owner and CC list (deduplicated) when
  a run notification is sent.
- Optional custom JSON payload and optional signing for webhook
  destinations (#224): an admin can now supply a `{{placeholder}}`
  template (run id, job id/name, status, timestamps, output, error) for
  outbound delivery instead of the fixed payload shape — chiefly to
  match receivers that expect credentials baked into a specific body
  shape rather than a header. Template values are JSON-escaped at
  substitution time so arbitrary run output can never break out of its
  string and inject sibling JSON keys, and a template is validated
  against a sample context at save time so a malformed one is rejected
  immediately rather than discovered mid-delivery. Signing
  (`X-Nexus-Signature`) is now a per-destination toggle, off by default
  makes no sense to send alongside a fully custom body the receiver
  doesn't expect to verify — and a saved template survives being
  toggled off, so it isn't discarded by unchecking the box.
- A live system map (issue #131): the Dashboard now shows an at-a-glance
  status row, and a new Knowledge Base *Architecture* page draws every
  backend component this deployment depends on (API, Worker, Postgres,
  Redis, the PDF service, LibreChat) as a flow chart — green where it's
  reachable right now, red where it's configured but the last check
  failed, grey where no recent reachability data has arrived. Postgres,
  Redis, and the PDF service are probed directly by the API on every
  request; LibreChat and the Worker's own liveness (nothing else in this
  app calls LibreChat directly) are published by the Worker into Redis
  every 30s under a short TTL, so a crashed or scaled-to-zero Worker
  degrades those to "no recent report" instead of showing a stale
  last-known-good status. Deliberately scoped to the links this app
  actually models today — a model gateway and an OCR pipeline are
  planned but not yet wired in as direct dependencies, so they aren't on
  the map yet.
- Full-stack observability: Alloy ships metrics and logs from every
  component to Mimir/Loki, visualized in a provisioned Grafana with
  dashboards for the app, infrastructure, and the LiteLLM model gateway
  (including per-key spend and budget metering, since every model call
  now flows through LiteLLM rather than hitting providers directly).
  The `helm/observability` chart brings this to Kubernetes: it installs
  cleanly on a Pod-Security-"restricted" cluster (seccomp + container
  securityContext on every workload, previously-hardcoded UIDs made
  overridable), fails at install time naming an available StorageClass
  when the cluster has no default one instead of leaving every PVC
  Pending with no explanation, stops double-prefixing registry-qualified
  images behind `global.imageRegistry`, and gains
  `imagePullSecrets`/`nodeSelector`/`tolerations`/`affinity` (tolerations
  matter most for the Alloy DaemonSet, since a tainted control-plane node
  otherwise contributes no metrics or logs). Ships with a full README
  covering topology, per-service wiring, every exported metric, and known
  gaps (fixes #178, #181, #183). Observability images are now pinned to a
  single current version across both Helm and Compose — previously Helm
  pinned old versions and Compose floated `:latest`, so the two paths
  silently ran different dashboards against different servers (fixes
  #184).
- The scheduler now exports inventory gauges (jobs, schedules, API keys,
  projects, prompts) for the Infrastructure dashboard, with collection
  isolated from Postgres availability so a database blip degrades the
  gauges rather than the rest of the metrics endpoint.
- `pdf-service` can now expose `/metrics` on a dedicated,
  scrape-only port (`PDF_SERVICE_METRICS_PORT`, off by default), so
  Kubernetes can watch its memory (the component most likely to be
  OOM-killed under headless Chromium) without granting the monitoring
  namespace access to the render endpoints — the chart's `NetworkPolicy`
  can't otherwise distinguish a scrape from a render request on a shared
  port.
- `container-stats-exporter` (the Docker Desktop compose profile's
  cAdvisor stand-in) now also watches the Docker Engine events API and
  emits `container_oom_events_total`, so the Infrastructure dashboard's
  OOM panel reports real kills on Docker Desktop instead of always
  reading "no OOMs" (cAdvisor there can see neither the compose cgroups
  nor the kernel log it depends on).
- Charts embedded in the usage report PDF now render as inline SVG
  instead of a rasterized image, so exported/printed reports stay crisp
  at any zoom or paper size (fixes #107).
- Both Helm charts now ship a committed `values-local.yaml` for
  laptop-cluster installs (Docker Desktop, kind): local image
  references, single replicas, small volumes — a dev install is two
  commands instead of hand-reconstructing overrides from the templates
  every time.
- Every Compose stack's published host ports are now overridable from
  `.env`, with unchanged defaults.
- A `Makefile` at the repo root gives canonical entry points for the
  compose stacks and test suites, and `scripts/create-dev-secrets.sh`
  bootstraps the chart's required Kubernetes Secrets with valid formats
  for a local cluster install.
- Knowledge Base coverage for four features that previously shipped
  with little or no documentation: webhooks and syslog forwarding each
  gain a full article — exact payload/log-line shape, signature
  verification, retry semantics, and the syslog severity mapping — and
  the consent banner and CSV/PDF usage export are now documented at all
  (#174); a dedicated section shows exactly where to create a LibreChat
  API key.
- `kbContent.ts`, the Knowledge Base's ~1,200-line content array, now
  has structural invariant tests (no duplicate slugs/titles, every
  article's category is one the index actually renders, every internal
  `/help/` link resolves) after a silent merge duplicated an entire
  article with zero compiler or lint errors to show for it.
- The API now warns loudly at startup when OIDC is configured but
  `OIDC_CLIENT_SECRET` is missing, and Compose passes the variable
  through so the warning path is reachable there too.

### Changed

- Model calls (including Claude) now route through the LiteLLM gateway
  rather than hitting providers directly, with LibreChat's own virtual
  key provisioned and migrated to `llm_api`-only scope (least privilege),
  and readiness now gates on database availability alone rather than on
  the gateway as well.
- Routine dependency bumps: Node base images across `packages/api`,
  `packages/worker`, and `packages/frontend` (20-slim → 26-slim), the
  `docker/ocr` Python base image (3.12 → 3.14-slim-bookworm),
  `pino-http` (10 → 11), and several GitHub Actions
  (`upload`/`download-artifact`, `docker/login-action`,
  `docker/setup-buildx-action`, `docker/build-push-action`). Dependabot
  now also watches the Docker ecosystem across all six Dockerfile
  directories, which is what let the observability image versions above
  drift undetected in the first place.

### Fixed

- `helm/nexus-scheduler` had three defaults that block startup on a real
  (non-Docker-Desktop) cluster, found by a live install: every app
  container failed `CreateContainerConfigError` because `runAsNonRoot`
  cannot be proven for a `USER nexus`-by-name image without an explicit
  numeric `runAsUser`; the bundled Postgres subchart's root-then-`gosu`
  boot path cannot run under this chart's dropped capabilities; and the
  OIDC env vars/Secret reference were rendered unconditionally even with
  SSO disabled, crash-looping every pod on empty-string URL validation
  (fixes #139).
- The worker's LibreChat agent calls could fail with an opaque `fetch
  failed` after almost exactly 300 seconds regardless of the job's own
  timeout: LibreChat's non-streaming Agents endpoint sends no bytes
  until generation finishes, and Node's default fetch dispatcher enforced
  a 300s headers timeout ahead of the job's own `AbortController`. The
  worker now uses a per-call dispatcher with headers/body timeouts set
  above the caller's budget, so the job's own timeout is always what
  fires, classified cleanly (fixes #127).
- A cancelled run was being counted as a LibreChat error in the metering
  dashboards instead of being excluded.
- `values.yaml`'s comment claiming the OIDC Secret "must exist even with
  SSO disabled" was wrong the moment #141 (above) landed and gated that
  reference — corrected, since this is the file an operator reads to
  decide what to provision (fixes #166).
- Integration test suites now refuse to run against anything that isn't
  a disposable test database, closing a gap in the existing `DATABASE_URL`
  naming guard.
- `helm/test-ai`'s LiteLLM pod was being repeatedly OOMKilled under
  default memory limits; raised to a stable value.
- Every pod spec in `helm/nexus-scheduler` can now pass through an
  optional `dnsConfig`, needed on clusters where the default resolver
  configuration doesn't work for these workloads.

### Security

- `GET /api/webhook-destinations` returned the full destination row,
  including the receiver's own auth token (`headers`), to any
  authenticated user regardless of role — and the Job webhook picker
  called this endpoint on every dialog open, so the token was already
  reaching every EDITOR/VIEW-role browser that opened it. Non-admin
  callers now get an `id`/`name`/`url`/`active`-only projection; the
  admin routes that legitimately manage the allow-list keep the full one
  (fixes #175).
- Outbound webhook delivery followed redirects, meaning a compromised or
  merely misconfigured receiver could redirect a signed POST — body,
  `X-Nexus-Signature`, and the receiver's own auth token, none of which
  Node strips cross-origin on a 307 — to an arbitrary internal address,
  defeating the entire point of the destination allow-list. Both the
  real delivery path and the admin test-send path now set
  `redirect: "manual"`, so a 3xx is reported as a failed delivery
  instead of being followed. The same fix also stopped retrying
  non-retryable responses (a stale-token 401 no longer burns all three
  attempts on every run, forever) and moved the success audit write
  outside the retry loop, so a database blip on that write can no longer
  cause an already-delivered payload to be re-POSTed up to three more
  times while the audit trail claims it never arrived (fixes #176,
  #177).
- `LOCAL_AUTH_ENABLED=false` was silently ignored: the env var used
  `z.coerce.boolean()`, which runs JavaScript's `Boolean()` on the raw
  string, and `Boolean("false") === true` — any non-empty value,
  including the documented-looking `false`, left local auth enabled.
  Now parsed as an explicit `"true"`/`"false"` enum, so an unrecognized
  value fails config validation at startup instead of being silently
  misread (#125).

### Fixed

- A run cancelled before it started, or picked up already terminal via
  BullMQ redelivery, could leave a stale per-user concurrency slot held
  until its TTL expired if a *prior* worker had acquired that slot and
  crashed before releasing it — throttling that user's other runs for
  however long was left on a run that wasn't even executing anymore.
  Both early-return paths now release the run's slot on the way out;
  harmless no-op the overwhelming majority of the time when there was
  nothing stale to release (#124).
- A run orphaned by a worker crash or restart mid-processing — left
  RUNNING with nothing left to finish it, or PENDING with no BullMQ job
  ever enqueued for it — previously stayed in that state forever: no
  retry, no failure notification, no freed concurrency slot, and no
  operator-visible signal beyond it never completing. The worker now
  runs a periodic reconciliation sweep (every 5 minutes by default) that
  force-terminates a RUNNING run once it's past its job timeout plus the
  same grace period the concurrency slot's own TTL uses, and a PENDING
  run once it's past a short grace period with no corresponding BullMQ
  job — each reaped run gets the identical FAILED treatment (audit
  event, concurrency slot release, webhook/email notification) a
  normally-failed run gets, not a second, inconsistent code path (#123).

## [0.1.9] - 2026-07-16

### Added

- The dev Compose stack now runs LiteLLM as the model gateway between
  LibreChat and Ollama: every model call is metered at the gateway
  (per-key spend, hard budgets, RPM/TPM rate limits, admin dashboard
  at `:4000/ui`) — the authoritative usage data LibreChat's Agents API
  doesn't provide (#38, #102). LibreChat authenticates with a
  dedicated, auto-provisioned virtual key rather than the gateway's
  admin master key, so budget/rate ceilings actually bind to its
  traffic. The bundled local models switch from
  `qwen3:0.6b` to a small CPU-friendly set — `gemma3:1b` (default
  chat), `codegemma:2b` (coding), `phi4-mini-reasoning:3.8b`
  (reasoning) — loaded one at a time (`OLLAMA_MAX_LOADED_MODELS=1`).
  Ollama's unauthenticated `:11434` is no longer published to the
  host, every Compose service now carries a memory limit sized for a
  16GB machine, and the worker's `GLOBAL_MAX_CONCURRENT_RUNS` defaults
  to 5 in the dev stack (#102).

### Security

- Hardened the api, worker, pdf-service, and frontend runtime images:
  pruned devDependencies out of the copied `node_modules`, upgraded
  Debian/Alpine base packages at build time, and removed the unused
  bundled npm CLI (a recurring source of CRITICAL/HIGH CVEs unrelated
  to anything these images actually run) from the three Node runtime
  images. All four images now scan clean of fixable CRITICAL/HIGH
  findings, and the Trivy CI scan gates on regressions instead of
  running informationally (#91).

### Fixed

- The `nexus_scheduler_http_request_duration_seconds` metric's `route`
  label used the resolved mount path instead of its pattern for any
  router mounted with a param in its own mount path (`/api/projects/
  :projectId/jobs` and three others), so every project/job ever created
  permanently added a new, never-retired time series. Unmatched (404)
  requests had the same problem via the raw request path. Both now
  label with the bounded pattern / a constant instead (#108).
- Runs can now actually be cancelled. `CANCELLED` has been a reachable
  status in the schema for a while, and everything downstream already
  handled it (terminal-state guards, `notifyOnCancelled` on webhook
  destinations), but nothing ever set it and no endpoint accepted a
  cancel request — an operator could enable "notify me on cancellation"
  and it would silently never fire. Adds `POST /api/runs/:id/cancel`
  and a Cancel button in Run History: a still-queued run is stopped
  before it ever reaches the agent, an in-flight one has its LibreChat
  request aborted immediately rather than left to run to completion or
  time out, and either way the same webhook/email delivery a completed
  or failed run gets now fires for it too (#111).

## [0.1.7] - 2026-07-14

### Added

- The Helm chart is now packaged and published as an OCI artifact
  (`ghcr.io/<owner>/charts/nexus-scheduler`) on every release, with the
  `.tgz` attached to the GitHub Release too (#82).
- Contextual empty-state guidance and prerequisite hints across the
  Prompts, Jobs, Schedules, Runs, and API Keys create/list flows,
  including disabled-button tooltips naming the specific missing
  prerequisite (#83).
- Prompt version history is now viewable, comparable, and restorable:
  expand any past version to see its content, compare two versions
  with a line-level content diff and a variables diff, or restore an
  old version as a new one (#85).

### Fixed

- The release workflow's `helm package` step now derives the chart's
  version from the release tag instead of trusting `Chart.yaml`'s
  committed state, fixing a failure mode where a tag pushed without
  running `scripts/release.mjs` first packaged the chart under the
  wrong version and broke the publish step (#86).

## [0.1.5] - 2026-07-14

### Added

- Versioning and release tooling: `scripts/release.mjs` (`npm run
  release`) for lockstep version bumps across every workspace, the Helm
  chart, and image tags, plus `.github/workflows/release.yml` to build
  and publish images and cut a GitHub Release on tag push.

## [0.1.0] - 2026-07-14

### Added

- Initial tracked baseline. Versioning and releases (this file,
  `scripts/release.mjs`, `.github/workflows/release.yml`) started here;
  everything before this point is untagged history.

[Unreleased]: https://github.com/schuecl/nexus-scheduler/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/schuecl/nexus-scheduler/releases/tag/v0.1.0
