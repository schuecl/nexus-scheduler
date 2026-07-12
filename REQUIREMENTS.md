# Nexus Scheduler — Requirements & Design

Status: **Draft** — living document, updated as design decisions are made.

Last updated: 2026-07-12

## 1. Overview

Nexus Scheduler is a web-based application for scheduling agentic AI tasks
that run against a **LibreChat** agent API. Users define jobs (prompts /
agent invocations), schedule them as one-time or recurring, and Nexus
Scheduler executes them concurrently against LibreChat using a
user-supplied API key, storing and surfacing the results.

Target deployment: air-gapped, security-hardened **Government Kubernetes**
environment, with a **Docker Compose** setup for local development/testing.

Nexus Scheduler is a component of the broader **MPNexus** platform.

## 2. Purpose & Core Functionality

- Web application for scheduling agentic AI tasks executed via the
  LibreChat front end / agent API.
- Connects to the LibreChat agent API using a **user-supplied API key**.
  - The API key is entered and stored per-user via the web UI (not
    configured only at the system/admin level).
- Supports **concurrent** execution of multiple scheduled jobs.
- Supports both:
  - **One-time** (run-once, at a specified date/time) jobs.
  - **Recurring** jobs, defined via **simplified interval pickers** (e.g.
    "every N minutes/hours/days/weeks", day-of-week + time-of-day, etc.)
    rather than raw cron syntax — prioritizes usability for non-technical
    users. Advanced/cron-style expressions are not required for v1.

### 2.1 LibreChat Integration Model

LibreChat exposes an **Agents API** (beta) that is OpenAI-compatible:
<https://www.librechat.ai/docs/features/agents_api>

- Endpoint: `POST /api/agents/v1/chat/completions` (OpenAI-compatible chat
  completions shape), or the Open Responses variant at
  `POST /api/agents/v1/responses`.
- The `model` field is the target **agent ID**; `messages` (or `input` for
  the responses variant) carries the job's configured prompt/payload.
- Authentication is via `Authorization: Bearer <API key>`, using the
  user-supplied LibreChat API key (LibreChat API keys are created via
  `POST /api/api-keys` on the LibreChat side, outside Nexus Scheduler).
- Integration is a **REST call per job execution**: on each trigger, Nexus
  Scheduler calls the LibreChat Agents API with the job's configured
  prompt/payload and the owning user's API key. `stream` is not needed for
  scheduled/unattended execution — request the non-streaming response.
- Each execution is stateless — a fresh request per run. Conversation/
  thread continuity across runs is **out of scope for v1**.
- Because this API is documented as **beta**, Nexus Scheduler's LibreChat
  client should isolate the request/response mapping behind a single
  adapter module so breaking changes upstream are easy to absorb.
- Job execution timeout and retry policy are configurable (see below);
  concurrency limits (global and per-user) are configurable by an admin.
- **Retry policy default**: on transient failure (network error, LibreChat
  5xx/timeout), retry **2 times** with exponential backoff (e.g. 30s,
  120s) before marking the run failed. Non-transient failures (e.g. 401
  invalid API key, 400 bad request) are **not retried**. Retry count and
  backoff are configurable per job, admin sets the global ceiling.
- **Agent discovery**: rather than requiring users to hand-type a
  LibreChat agent ID, Nexus Scheduler should call LibreChat to list the
  agents available to the configured API key (if LibreChat exposes such a
  listing endpoint) and present them as a picker when building a job.
  Falls back to manual agent-ID entry if discovery isn't available.
- **API key lifecycle**: LibreChat API keys can carry an expiration date.
  Nexus Scheduler must detect an expired/revoked key (via a failed auth
  response from LibreChat), mark the key invalid, notify the owning user
  (UI banner + email), and **pause rather than silently fail** any
  schedules depending on that key until it's replaced.
- **Default execution timeout: 10 minutes per job run**, admin-configurable
  with a hard ceiling of 60 minutes (agentic/multi-step tasks can run long,
  but an unbounded call risks starving worker capacity). Jobs may override
  the default timeout downward but not above the admin-set ceiling.
- **Job cancellation is required for v1**: a user with sufficient
  permission (job owner, or admin) can cancel a running job; the scheduler
  must abort the in-flight LibreChat request and mark the run cancelled.
- **Concurrency defaults** (sized for an enterprise directory of 500+
  users with expected light-to-moderate concurrent usage, not 500
  simultaneous runs): global default max **25 concurrent job executions**,
  per-user default max **5 concurrent job executions**, both
  admin-configurable. Worker capacity should scale horizontally (via
  replica count) if real usage exceeds these defaults.

### 2.2 Job Output Handling

- Full LibreChat response (and execution metadata: start/end time, status,
  duration, error if any) is persisted in PostgreSQL.
- Users can view job run history and full output/detail in the web UI.
- Email notification (via SMTP) is optionally sent to the job owner on
  completion and/or failure, per-job configurable.

### 2.3 Saved & Shareable Prompts (Projects & Teams)

- Users can save reusable prompt/job templates rather than re-authoring
  them per schedule.
- Saved prompts are organized into **Projects** — shared containers that
  group related prompts/jobs so power users can collaborate and reuse each
  other's work.
- **Teams** are a first-class grouping of users, defined and managed
  entirely **within Nexus Scheduler's own UI** (not sourced from Keycloak/
  OIDC groups — local-only, admin/editor-managed membership). **Teams
  support nesting** (a Team may have sub-Teams); membership is inherited
  down the hierarchy, so adding a user to a parent Team grants them
  membership of all its descendant Teams for ACL purposes.
- **Project ACLs are granted by individual user or by Team**: a Project
  owner can share a Project (read or edit access) with one or more
  specific users, one or more Teams, or org-wide/all authenticated users.
  Private (owner-only) remains the default for new Projects.
- A saved prompt in a shared Project can be used as the basis for a new
  job/schedule by any user with access to that Project, without needing to
  know the underlying LibreChat agent/prompt details.
- Editing a shared prompt is restricted to users/Teams granted edit access
  on the Project; users/Teams with read-only access can view and use
  (copy/run) it, per the role model (§4).
- **Saved prompts support version history**: every edit to a prompt
  creates a new version, prior versions remain viewable/diffable, and a
  prompt can be reverted to an earlier version. Job/schedule definitions
  reference a specific prompt version so in-flight schedules aren't
  silently altered by a later edit. **Version pinning is the schedule
  owner's choice, set per-schedule**: pin to the prompt version in effect
  when the schedule was created/last edited, or track "always use latest
  version" — the schedule owner picks at creation time and can change it
  later.

### 2.4 Schedule Mechanics

- Every schedule has an explicit **IANA time zone** (not implicitly
  server-local); recurring schedules compute next-fire time DST-safely in
  that zone. Users see next/last run times rendered in their own browser
  time zone as well as the schedule's configured zone.
- Schedules can be **paused/resumed** without deleting them (and without
  losing run history) — a common operational need for "pause this report
  while I'm on leave" type workflows.
- **Missed-run handling** (e.g. scheduler/worker downtime spans a fire
  time): open question, see §12.

## 3. Constraints

- **Container-based**: the application ships as container image(s),
  designed to run in Kubernetes.
- **Docker Compose** file provided for local dev/testing:
  - Includes all required supporting services (Postgres, Redis, etc.).
  - Uses **randomly generated secrets/keys** for local testing (no
    hardcoded defaults).
  - The local Compose environment has internet access and exists purely to
    test the scheduler app itself (it does not need to simulate the
    air-gapped constraint).
- **Air-gapped production environment**:
  - No outbound external network access may be assumed or required at
    runtime.
  - All dependencies (base images, language packages, fonts, etc.) must be
    vendored/bundled into build artifacts — no pulling from the internet
    at deploy or runtime.
  - Container images must be built to be pushed into an internal/offline
    registry.
- **Government network / high security priority**:
  - Follow security hardening best practices throughout (see §8).
- **Use well-known, established components** for each architectural layer
  (e.g., PostgreSQL, Redis, nginx) rather than niche/bespoke tooling.

## 4. Authentication & Authorization

- Modern, web-based login supporting:
  - **OIDC** (tested against **Keycloak**).
  - **Locally managed accounts** (username/password) as a fallback/alt
    path, for environments without an IdP.
- OIDC claims mapping must support:
  - Email
  - Given name
  - Last (family) name
  - Full / display name
- **Roles** (simplified to 3 + admin, per design decision):
  - **admin** — manage users, roles, system configuration, LibreChat
    connection defaults, audit log access, branding/customization.
  - **editor** — create and edit job definitions, manage LibreChat API key
    connections, create/manage schedules for jobs, and create/edit Projects
    and saved prompts (merges the originally proposed "build" and
    "schedule" roles).
  - **view** — read-only access to job definitions, schedules, run
    history/output, audit logs, and shared Projects/prompts (can view and
    copy shared prompts, but cannot create schedules or run jobs).
- Role assignment supported both via local role management and via OIDC.
  Confirmed approach: map Nexus Scheduler role from a **Keycloak client
  role** (a client role scoped to the Nexus Scheduler client in Keycloak,
  delivered in the token's `resource_access.<client_id>.roles` claim, per
  standard Keycloak client-role conventions) rather than a realm-wide
  group claim — this keeps role administration scoped to Nexus Scheduler
  within Keycloak. A fallback default role applies to authenticated users
  with no matching client role.
- **Teams** (see §2.3) are separate from roles/OIDC entirely — they are
  local-only groupings used for Project sharing, not for permissions.
- Passwords for local accounts must be stored using a strong adaptive hash
  (e.g., bcrypt/argon2); no plaintext or reversible storage.
- Per-user LibreChat API keys must be stored **encrypted at rest**.
- **Session management**: idle session timeout (admin-configurable,
  default TBD) and absolute session lifetime, consistent with typical
  Government session-lock expectations (e.g. NIST 800-53 AC-11-style
  controls). Applies to both OIDC and local-auth sessions.

## 5. Look & Feel

- Modern web UI (responsive, accessible).
- **Accessibility**: target **WCAG 2.1 AA** conformance (aligns with
  Section 508 expectations common in Government deployments) — exact
  conformance scope/testing process still to be finalized (see §12).
- Branding/customization support: logo, product name, color theme
  configurable by an admin without a rebuild (e.g., via mounted config or
  admin settings screen).
- SMTP-based email notifications:
  - Job completion / failure notifications (per §2.2).
  - Account-related notifications (e.g., password reset, if local auth is
    used).
  - SMTP server settings configurable by admin (host, port, TLS, auth,
    from-address).

## 6. Auditing & Logging

- All actions are logged and attributed to an **actor identity**:
  - Human users → by **email**.
  - Agent/system/service-initiated actions (e.g., scheduler firing a job)
    → by **service identity** (e.g., `system:scheduler`).
- Audited action categories:
  - **User actions**: login/logout, job create/edit/delete, schedule
    create/edit/delete, API key add/remove, settings changes.
  - **Admin actions**: user/role management, system configuration changes,
    branding changes, SMTP config changes.
  - **Agent/task actions**: job execution start, completion, failure,
    cancellation, and the LibreChat request/response metadata.

### 6.1 Audit Event Schema (Proposed)

Every audit record must unambiguously answer **who did what, when** (plus
enough context to investigate an incident). Proposed minimal schema:

| Field | Description |
|---|---|
| `event_id` | UUID, unique per event. |
| `timestamp` | UTC, ISO 8601 with millisecond precision. Server clock only — never client-supplied. |
| `actor_type` | `user` \| `service`. |
| `actor_id` | User ID or service identifier (e.g. `system:scheduler`). |
| `actor_email` | Denormalized human-readable actor (user's email, or service name) — satisfies "by user email or service" directly, without a join, even if the user record later changes/is removed. |
| `action` | Verb in `<resource>.<operation>` form, e.g. `job.create`, `schedule.update`, `run.start`, `run.cancel`, `login.success`, `login.failure`, `apikey.rotate`, `team.membership.add`. |
| `target_type` | `job` \| `schedule` \| `run` \| `project` \| `prompt` \| `team` \| `user` \| `apikey` \| `system_setting`. |
| `target_id` | ID of the affected resource. |
| `target_name` | Denormalized display name of the target *at the time of the event* (survives later renames/deletes). |
| `result` | `success` \| `failure`, plus `error_message` when applicable. |
| `source_ip` | Client IP for UI/API-driven actions (null for internal scheduler-initiated events). |
| `correlation_id` | Groups related events (e.g. one `correlation_id` ties `run.start` → `run.complete` → `notification.sent` for a single job run). |
| `details` | JSON blob for action-specific context (e.g. changed-field diff on an update, or the LibreChat request/response metadata for a run). |

This is the row shape stored in PostgreSQL. When mirrored to **syslog**
(§ below), fields map onto RFC 5424 as: `TIMESTAMP` = `timestamp`,
`HOSTNAME`/`APP-NAME` = the emitting pod, `MSGID` = `action`, and the rest
(`event_id`, `actor_type`, `actor_id`, `actor_email`, `target_type`,
`target_id`, `result`, `correlation_id`) as RFC 5424 `STRUCTURED-DATA`
parameters under a single `nexusAudit@<enterprise-id>` SD-ID; `details`
and a human-readable summary form the `MSG` body.

- Local log/audit retention: **14 days by default**, configurable by
  admin. This governs the **audit trail** (§6.1 events). **Job run
  history/output (§2.2) is a separate, product-facing dataset and is not
  bound by the 14-day audit window** — its retention period is an open
  question (see §12), since users will want to reference past run
  results well beyond two weeks.
- Audit records are stored in **PostgreSQL** (structured, queryable) as
  the system of record for local retention/UI display.
- Nexus Scheduler must **also support emitting logs via syslog** so
  Government environments can forward application/audit events into an
  existing centralized log pipeline (e.g. SIEM), independent of the
  14-day local Postgres retention.
  - Message format: **RFC 5424** (structured syslog protocol).
  - Transport: **RFC 6587**-style framing over TCP or UDP; **TLS is
    optional** (RFC 5425 syslog-over-TLS), admin-configurable per
    destination rather than mandatory — matches environments that already
    terminate transport security at the network layer.
  - Enable/disable and destination (host:port, transport, TLS on/off) are
    admin-configurable.

## 7. Deployment

### 7.1 Kubernetes (Production)

- **Helm chart** for deployment, optionally including:
  - PostgreSQL (as a subchart/dependency, or bring-your-own).
  - Redis (as a subchart/dependency, or bring-your-own).
- **nginx is not deployed by this chart** — the target environment already
  provides nginx as a reverse proxy in front of the application; the Helm
  chart only needs to expose a standard Service/Ingress the existing proxy
  can target.
- All images referenced by the chart must be relocatable to an internal/
  offline registry (configurable image repository/registry values, no
  hardcoded public registry references required at runtime).
- Secrets (DB credentials, session signing keys, OIDC client secret, SMTP
  credentials, API key encryption key) sourced from Kubernetes Secrets —
  never baked into images.

### 7.2 Docker Compose (Local Dev / Testing)

- Single `docker-compose.yml` (or set of compose files) that stands up
  everything needed to run and exercise Nexus Scheduler locally:
  - Nexus Scheduler app container(s) (web/API, scheduler worker).
  - PostgreSQL.
  - Redis.
  - nginx (as a local reverse-proxy stand-in, since production nginx is
    external to the app).
  - Local Keycloak instance (for testing OIDC end-to-end), or documented
    steps to point at an external test IdP.
  - Local mail-catcher (e.g., MailHog/Mailpit) to test SMTP notifications
    without a real mail server.
- All secrets/keys in the Compose setup are **randomly generated at
  startup** (e.g., via an init script or `.env` generation step) — no
  committed default passwords/keys.
- Compose environment assumes internet access is available and is only
  intended to validate the scheduler application itself, not to simulate
  the air-gapped constraint.

## 8. Security Considerations

- All traffic terminates TLS at the (externally managed) nginx layer in
  production; internal service-to-service traffic should still be
  encrypted or run within a trusted cluster network per Government network
  policy.
- Secrets never logged, never returned in API responses beyond what's
  necessary, and encrypted at rest where persisted (LibreChat API keys,
  OIDC client secret, SMTP credentials).
- CSRF protection, secure cookie flags, and standard OWASP web hardening
  applied to the web application.
- Principle of least privilege enforced via the role model (§4).
- Dependency/container images scanned for CVEs as part of the build
  pipeline (tooling TBD — must itself be air-gap-compatible).
- No telemetry/analytics calls to external services (air-gap constraint).
- **FIPS 140-2/140-3 validated cryptography**: whether this is a hard
  requirement for the target Government network is an open question (see
  §12) — if required, it constrains base image/runtime and crypto library
  choices (e.g. OpenSSL FIPS module, distro FIPS mode) and should be
  decided before implementation starts.
- **Operational health & metrics**: Kubernetes liveness/readiness probe
  endpoints on both the API and scheduler/worker containers, plus a
  Prometheus-compatible `/metrics` endpoint (queue depth, running job
  count, success/failure rates, LibreChat call latency) for cluster-local
  monitoring — distinct from the user-facing audit log, this is for
  platform operators.
- **Import/export**: job, schedule, and prompt definitions can be
  exported/imported as JSON, so power users can back up, promote between
  environments, or share configuration outside of Nexus Scheduler's
  built-in Project sharing.

## 9. Proposed Architecture (Draft)

> This section captures a working technical direction; not yet finalized.

- **Frontend**: modern SPA (e.g., React) served as static assets.
- **Backend API**: handles auth (OIDC + local), job/schedule CRUD, user/
  role management, audit log access.
- **Scheduler/Worker**: separate process/container from the API, executes
  due jobs concurrently, calls the LibreChat API, writes results back.
  - Redis used as the job queue / scheduling coordination layer (e.g.,
    backing a queue library) to support concurrency and horizontal scaling
    of workers.
- **Database**: PostgreSQL — users, roles, Teams (+ membership), job
  definitions, schedules, run history, audit log, Projects, saved prompts
  (+ prompt version history).
- **Reverse proxy**: nginx (external/pre-existing in prod; included in
  Compose for local parity).
- Both the Backend API and Scheduler/Worker expose `/healthz`
  (liveness/readiness) and `/metrics` (Prometheus) endpoints per §8.

## 10. Non-Goals (v1)

- Multi-tenant / multi-organization isolation beyond role-based access
  within a single deployment.
- Continuing/threading LibreChat conversations across scheduled runs.
- Outbound webhook/callback delivery of job results (may revisit later).

## 11. Glossary

- **Job**: a defined unit of work — a prompt/payload to send to the
  LibreChat agent API, plus execution configuration.
- **Schedule**: the timing definition (one-time or recurring) attached to
  a job that determines when it runs.
- **Run**: a single execution instance of a job, with its own result/
  status/history record.
- **Project**: a shared container for saved prompts/job templates that a
  group of users collaborate on and reuse.
- **Team**: a locally-defined (UI-managed) group of users, used as a
  sharing target for Project ACLs; independent of roles and OIDC groups.

## 12. Open Questions

- **Team/service-owned schedule execution identity**: when a schedule
  lives in a Team-shared Project, whose LibreChat API key executes it —
  always the creator's personal key, or should Nexus Scheduler support a
  Team/service-level API key so execution doesn't break if the creator
  leaves or their key is revoked?
- **Job run history retention**: now explicitly decoupled from the
  14-day audit default (§6) — what should the default retention for
  run history/output actually be (e.g. 90 days, 1 year, indefinite with
  admin-configurable purge)?
- **Missed-run / catch-up semantics** (§2.4): if the scheduler/worker is
  down across a scheduled fire time, should the run fire immediately on
  recovery ("catch-up"), be skipped entirely, or should this be
  configurable per schedule?
- **FIPS 140-2/140-3 validated cryptography** (§8): hard requirement for
  this Government network, or standard hardened crypto is sufficient?
- Accessibility conformance scope (§5): confirm WCAG 2.1 AA is the right
  target (vs. a formal Section 508 VPAT requirement) and how it will be
  tested/verified.
- Exact structured-data field list for RFC 5424 syslog messages is
  proposed in §6.1 — confirm it covers what a target SIEM integration
  needs.
- Concurrency defaults (25 global / 5 per-user) are accepted as a
  starting point; **explicitly deferred for revisit** once real usage
  patterns are observed post-launch — no action needed now.

## 13. Change Log

- 2026-07-12: Initial draft created from project kickoff requirements.
- 2026-07-12: Resolved initial open questions — recurring schedules use
  interval pickers (not cron); OIDC role/group claim mapping confirmed;
  added default concurrency limits (25 global / 5 per-user) and default
  job timeout (10 min, 60 min ceiling) with required job cancellation;
  documented concrete LibreChat Agents API integration details; added
  syslog output alongside Postgres audit storage; added Projects /
  shareable saved-prompts feature (§2.3).
- 2026-07-12: Added Teams (local, UI-managed groups) as a Project ACL
  sharing target alongside individual users; added saved-prompt version
  history with per-schedule version pinning; confirmed OIDC role mapping
  uses Keycloak **client roles** rather than realm groups; syslog output
  confirmed as RFC 5424 with optional (admin-configurable) TLS; noted
  Nexus Scheduler is part of the MPNexus platform; concurrency defaults
  explicitly deferred for post-launch revisit.
- 2026-07-12: Confirmed Teams support nesting with inherited membership;
  confirmed version pinning is the schedule owner's per-schedule choice;
  added proposed audit event schema (§6.1) and its RFC 5424 field
  mapping; gap-analysis pass added: retry-policy defaults, LibreChat
  agent discovery, API key lifecycle handling, schedule time zone
  handling, schedule pause/resume, WCAG 2.1 AA accessibility target,
  session idle-timeout requirement, decoupled run-history retention from
  the 14-day audit window, FIPS crypto flag, health/metrics endpoints,
  and JSON import/export of job/schedule/prompt definitions. New open
  questions raised: Team/service-owned schedule execution identity,
  run-history retention default, missed-run/catch-up semantics, and
  whether FIPS-validated crypto is mandatory.
