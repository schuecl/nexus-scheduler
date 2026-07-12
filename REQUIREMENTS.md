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
- **Team-owned API keys**: in addition to per-user keys, a **Team** (§2.3)
  can hold its own LibreChat API key, enterable by any Team member with
  edit rights. A job/schedule inside a Team-shared Project can be
  configured to run under the **Team's key** instead of its creator's
  personal key — this keeps shared, durable automation working when the
  original creator leaves the Team, is deactivated, or rotates their
  personal key. Team-key expiration/revocation follows the same
  detect-and-pause handling as personal keys, notifying Team
  members with edit rights instead of a single user.
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
- **"Run Now" (manual/on-demand execution)**: any user with edit access to
  a job (owner, or an editor/admin with edit access to its Project) can
  trigger an immediate one-off execution outside its schedule — for
  testing a prompt/agent pairing before trusting it to a recurring
  schedule, or for an ad-hoc re-run. Manual runs are recorded in run
  history like any other run (tagged `trigger_type=manual` vs.
  `scheduled`) and count against the same concurrency limits. Email
  notification for manual runs defaults to **off** (avoids notification
  noise while iterating) but can be enabled per-run.

### 2.2 Job Output Handling

- Full LibreChat response (and execution metadata: start/end time, status,
  duration, error if any) is persisted in PostgreSQL.
- Users can view job run history and full output/detail in the web UI.
- Email notification (via SMTP) is optionally sent to the job owner on
  completion and/or failure, per-job configurable.
- Job output can also be delivered as a formatted **PDF report** (email
  attachment or on-demand download) — see §2.5.
- **Outbound webhook delivery**: a job can optionally be configured to
  `POST` its run result (JSON: status, output, timing, run ID) to an
  internal destination on completion and/or failure.
  - For security in an air-gapped, high-security network, webhook
    destinations are **not arbitrary user-supplied URLs** — they must be
    selected from an **admin-maintained allow-list** of internal
    endpoints, preventing exfiltration/SSRF to unapproved destinations.
  - Payloads are signed (HMAC, per-destination signing secret) so
    receivers can verify authenticity and integrity.
  - Delivery uses the same retry policy as job execution (§2.1); delivery
    attempts/failures are logged and audited.

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
- **Prompt templating (variables)**: saved prompts can contain
  `{{variable}}` placeholders resolved at run time, so one shared prompt
  serves many contexts instead of near-duplicate copies:
  - **Built-in variables** resolved automatically (e.g. `{{date}}`,
    `{{datetime}}`, `{{schedule_name}}`, `{{run_id}}`).
  - **User-defined parameters** declared on the prompt (name, type —
    text/number/date, default value), which are filled in when a schedule
    is created from that prompt and can be edited later.
  - Substitution happens server-side at execution time, before the
    request is sent to LibreChat.
- **Discovery**: Projects and prompts support free-text **tags** and are
  searchable (name/description/tags) via a **Prompt Library** browse view
  covering everything the current user has access to — filterable by tag,
  owner, and Team, sortable by "most used" (run count) or "recently
  updated." Users can **favorite/star** prompts for quick access. This is
  what makes sharing actually discoverable, not just permitted.

### 2.4 Schedule Mechanics

- Every schedule has an explicit **IANA time zone** (not implicitly
  server-local); recurring schedules compute next-fire time DST-safely in
  that zone. Users see next/last run times rendered in their own browser
  time zone as well as the schedule's configured zone.
- Schedules can be **paused/resumed** without deleting them (and without
  losing run history) — a common operational need for "pause this report
  while I'm on leave" type workflows.
- **Missed-run handling**: if the scheduler/worker is down across a
  scheduled fire time, the missed fire is **skipped** — the next
  occurrence fires normally on its regular schedule. Avoids surprise
  bursts of stale/backlogged agentic runs after an outage or deploy. A
  skipped fire is still recorded (as a `skipped` run) for visibility.
- **Approval workflow (maker-checker) for shared schedules**: a schedule
  that lives in a **Team-shared or org-shared Project** must be approved
  before it becomes active — and again after any substantive edit (target
  agent, prompt/prompt version, or timing; metadata-only edits like a
  description do not require re-approval). Rationale: an unattended
  recurring agentic task with broad visibility/blast radius warrants a
  second set of eyes before it runs unattended, especially in a
  high-security Government environment.
  - Eligible approvers: the Project owner, or any user/Team granted edit
    access on that Project — excluding the person who made the change,
    when another eligible approver exists. If the author is the Project's
    sole owner with no other collaborators, self-approval is allowed (so
    a single-owner Project isn't deadlocked).
  - Admins can always approve directly, bypassing the above.
  - Pending-approval schedules sit in a visible approval queue; approve/
    reject actions are audited (§7.1) and the requester is notified of
    the outcome.
  - **Private (owner-only) schedules do not require approval** — only
    those shared beyond their owner.

### 2.5 Report Generation & Delivery

- Nexus Scheduler can render structured content — a run's output, or an
  admin usage/audit summary (§8) — as a **PDF report**, using a
  well-known, actively maintained HTML-to-PDF rendering engine (e.g.
  headless Chromium print-to-PDF via Puppeteer/Playwright, or WeasyPrint;
  final choice tracks the backend language selected in §11). The renderer
  ships bundled in the container image so rendering works fully offline
  — no CDN fonts/external asset fetches at render time, consistent with
  the air-gapped constraint (§3).
- **Job/run reports**: any run's stored output can be rendered as a PDF
  (job name, run metadata — schedule, timestamp, agent, run ID — plus the
  LibreChat output), available two ways:
  - **Email delivery**: a per-job configurable option attaches the PDF to
    the existing completion/failure email (§2.2) instead of, or alongside,
    inline text.
  - **On-demand download**: a "Download PDF" action on any run's detail
    view in the UI.
- **Admin/usage reports**: the §8 dashboard (run counts, success/failure
  rates, token usage, cost) is exportable as **PDF** in addition to CSV,
  and an admin can configure a **recurring report email** (e.g. "send a
  weekly usage summary PDF to these recipients") over the same SMTP
  integration used for job notifications.
- **Generated on demand, not stored as a binary**: a PDF is rendered
  fresh from already-persisted structured data (run output, usage
  aggregates) at request/send time rather than adding a new
  object-storage layer — cheap to regenerate since the underlying content
  already lives in PostgreSQL.
- **Branding & classification marking carry over**: PDFs use the same
  admin-configured branding (logo, product name, color theme — §5) as the
  web UI, and carry the **system-wide classification banner** (§6) as a
  header/footer on every page — marking travels with the document once it
  leaves the browser (email attachment, downloaded file). If the source
  content has an object-level classification label (§6), that label also
  appears on the report's cover/first page as a secondary marking.

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
  - Follow security hardening best practices throughout (see §10).
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
  conformance scope/testing process still to be finalized (see §14).
- Branding/customization support: logo, product name, color theme
  configurable by an admin without a rebuild (e.g., via mounted config or
  admin settings screen).
- SMTP-based email notifications:
  - Job completion / failure notifications (per §2.2).
  - Account-related notifications (e.g., password reset, if local auth is
    used).
  - SMTP server settings configurable by admin (host, port, TLS, auth,
    from-address).

## 6. Classification & Marking

Nexus Scheduler is deployed **inside** an already-classified/accredited
Government network — the system does not need to enforce cross-domain
separation, but it does need to carry and display the marking conventions
that Government users expect.

These are **two deliberately independent** concerns — one system-wide, one
per-object — and the banner is never derived from or influenced by object
tags:

- **Persistent classification banner (system-level)**: a banner bar is
  **fixed at the top and bottom of every page**, always visible (does not
  scroll away), showing admin-configured **banner text** and
  **background/text color**. This is a **single, system-wide** banner
  reflecting the deployment's overall classification/accreditation level
  — set once by an admin as part of system configuration (alongside the
  §5 branding settings). It is static: it never changes based on which
  page or object is being viewed. Banner color contrast must meet the
  same WCAG 2.1 AA target as the rest of the UI (§5).
- **Admin-editable classification taxonomy (object-level)**: separately,
  classification **labels** are available for tagging individual objects.
  Labels are **not** a hardcoded scheme — an admin defines the ordered
  list of labels applicable to this deployment (label text/abbreviation,
  plus a badge background color and a legible text color per label), and
  can create, rename, reorder, or retire labels over time.
- **Content tagging**: Projects and saved prompts can be tagged with
  exactly one classification label from the admin-defined taxonomy (jobs/
  schedules inherit their Project's label by default). A configurable
  default label applies to newly created Projects (e.g. the deployment's
  baseline classification). The active label renders as a **badge**
  wherever the tagged item appears (library/browse views, detail views) —
  informational marking on the object, distinct from and with no effect
  on the system banner above.

## 7. Auditing & Logging

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
  - **Governance actions**: schedule approval requests, approvals,
    rejections (§2.4); webhook delivery attempts (§2.2); classification
    label changes on Projects/prompts (§6).

### 7.1 Audit Event Schema (Proposed)

Every audit record must unambiguously answer **who did what, when** (plus
enough context to investigate an incident). Proposed minimal schema:

| Field | Description |
|---|---|
| `event_id` | UUID, unique per event. |
| `timestamp` | UTC, ISO 8601 with millisecond precision. Server clock only — never client-supplied. |
| `actor_type` | `user` \| `service`. |
| `actor_id` | User ID or service identifier (e.g. `system:scheduler`). |
| `actor_email` | Denormalized human-readable actor (user's email, or service name) — satisfies "by user email or service" directly, without a join, even if the user record later changes/is removed. |
| `action` | Verb in `<resource>.<operation>` form, e.g. `job.create`, `schedule.update`, `run.start`, `run.cancel`, `login.success`, `login.failure`, `apikey.rotate`, `team.membership.add`, `schedule.approve`, `webhook.deliver`. |
| `target_type` | `job` \| `schedule` \| `run` \| `project` \| `prompt` \| `team` \| `user` \| `apikey` \| `system_setting` \| `webhook`. |
| `target_id` | ID of the affected resource. |
| `target_name` | Denormalized display name of the target *at the time of the event* (survives later renames/deletes). |
| `result` | `success` \| `failure`, plus `error_message` when applicable. |
| `source_ip` | Client IP for UI/API-driven actions (null for internal scheduler-initiated events). |
| `correlation_id` | Groups related events (e.g. one `correlation_id` ties `run.start` → `run.complete` → `notification.sent` for a single job run). |
| `details` | JSON blob for action-specific context (e.g. changed-field diff on an update, or the LibreChat request/response metadata for a run). |

This is the row shape stored in PostgreSQL. When mirrored to **syslog**
(below), fields map onto RFC 5424 as: `TIMESTAMP` = `timestamp`,
`HOSTNAME`/`APP-NAME` = the emitting pod, `MSGID` = `action`, and the rest
(`event_id`, `actor_type`, `actor_id`, `actor_email`, `target_type`,
`target_id`, `result`, `correlation_id`) as RFC 5424 `STRUCTURED-DATA`
parameters under a single `nexusAudit@<enterprise-id>` SD-ID; `details`
and a human-readable summary form the `MSG` body.

- Local log/audit retention: **14 days by default**, configurable by
  admin. This governs the **audit trail** (§7.1 events). **Job run
  history/output (§2.2) is a separate, product-facing dataset and is not
  bound by the 14-day audit window**: default retention is **90 days**,
  admin-configurable, with an admin-triggered purge/archival job past
  that window.
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

## 8. Usage & Reporting

Distinct from the audit trail (§7) — this is admin-facing analytics over
run activity, for capacity planning and governance in a 500+ user
deployment.

- **Reporting dashboard**: run counts and success/failure rates over time,
  sliceable by user, Team, Project, and target agent.
- **Token usage tracking**: LibreChat's Agents API is OpenAI-compatible
  and standard chat-completions responses include a `usage` object
  (`prompt_tokens`, `completion_tokens`, `total_tokens`). Nexus Scheduler
  captures and stores this breakdown for every run (final confirmation
  against the live deployed LibreChat version still needed — degrade
  gracefully to "unavailable" for a given run if `usage` is absent).
- **Cost calculation via admin-configured rates**: since this deployment
  is entirely offline/air-gapped and running in owned datacenters, there
  is no external billing API to pull real dollar costs from — instead,
  cost is **computed internally** from tracked token counts using
  admin-configurable rates (e.g. "$X per 1M prompt tokens" / "$Y per 1M
  completion tokens"), settable **per agent/model** since different
  agents may warrant different internal rates, with a global default rate
  applied when no per-agent override is set. Cost is computed **at run
  time using the rate in effect then** and stored alongside the run (not
  recomputed retroactively), so a later rate change doesn't rewrite
  historical cost figures. Runs before any rate is configured show token
  counts with cost as "not costed."
- Both token counts and computed cost roll up into the dashboard above,
  sliceable by user/Team/Project/agent, for internal chargeback/showback
  even without a real external invoice.
- **Optional quotas**: per-user and/or per-Team cumulative run quotas
  (e.g. runs per day/month, or a token/cost budget), separate from the
  §2.1 concurrency limits (concurrency caps *simultaneous* runs; a quota
  caps *cumulative* usage over a period). Default: **no quota**
  (unlimited); admin can opt in per user/Team for cost or capacity
  governance.
- **Exportable reports**: usage data exportable as CSV, or as a **PDF**
  report with optional recurring email delivery — see §2.5.

## 9. Deployment

### 9.1 Kubernetes (Production)

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

### 9.2 Docker Compose (Local Dev / Testing)

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

## 10. Security Considerations

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
- **FIPS 140-2/140-3 validated cryptography is required.** All
  cryptographic operations (TLS, password hashing/KDF, at-rest encryption
  of API keys and other secrets) must use FIPS-validated modules. This
  constrains implementation choices made later: base container images
  must run in FIPS mode (e.g. a FIPS-enabled UBI/RHEL-based image or
  distro with a validated OpenSSL/BoringCrypto module), and language
  runtimes/crypto libraries must be selected for FIPS-mode compatibility
  rather than assumed compatible after the fact.
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
- **Webhook destination allow-listing** (§2.2): outbound webhook targets
  are restricted to an admin-maintained allow-list, not arbitrary URLs —
  prevents the outbound-delivery feature from becoming an exfiltration
  path in a high-security network.
- **PDF renderer network isolation** (§2.5): the HTML-to-PDF rendering
  engine must not be able to fetch remote URLs/resources at render time
  (all fonts/assets bundled locally) — the same SSRF/exfiltration concern
  as the webhook allow-list above, since a renderer that fetches
  attacker- or user-influenced URLs is a classic sandbox-escape vector.

## 11. Proposed Architecture (Draft)

> This section captures a working technical direction; not yet finalized.

- **Frontend**: modern SPA (e.g., React) served as static assets.
- **Backend API**: handles auth (OIDC + local), job/schedule CRUD, user/
  role management, audit log access.
- **Scheduler/Worker**: separate process/container from the API, executes
  due jobs concurrently, calls the LibreChat API, writes results back.
  - Redis used as the job queue / scheduling coordination layer (e.g.,
    backing a queue library) to support concurrency and horizontal scaling
    of workers.
- **Database**: PostgreSQL — users, roles, Teams (+ membership + Team-
  owned API keys), job definitions, schedules, run history (+ per-run
  token counts and computed cost), audit log, Projects, saved prompts
  (+ prompt version history), classification taxonomy, cost rate table
  (per agent/model, prompt vs. completion), webhook destinations,
  usage/quota data.
- **Reverse proxy**: nginx (external/pre-existing in prod; included in
  Compose for local parity).
- Both the Backend API and Scheduler/Worker expose `/healthz`
  (liveness/readiness) and `/metrics` (Prometheus) endpoints per §10.

## 12. Non-Goals (v1)

- Multi-tenant / multi-organization isolation beyond role-based access
  within a single deployment.
- Continuing/threading LibreChat conversations across scheduled runs.
- Job chaining / dependent-job pipelines (run Job B after Job A) — a
  single job/schedule targets one LibreChat agent call per run.
- Dynamic, per-item-driven classification banner switching — the §6
  banner is a static, system-wide, admin-set indicator.

## 13. Glossary

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
  Can optionally hold its own LibreChat API key for shared schedules.
- **Classification Banner**: the single, static, system-wide banner
  (admin-set text/colors) fixed at the top and bottom of every page,
  reflecting the deployment's overall classification level (§6).
- **Classification Label**: an admin-defined, per-object marking (text +
  badge colors) applied to a Project/prompt; independent of, and with no
  effect on, the Classification Banner (§6).
- **Webhook Destination**: an admin-allow-listed internal URL a job can
  be configured to POST its run result to on completion.
- **Cost Rate**: an admin-configured $-per-million-tokens rate (prompt
  and completion, optionally per agent/model) used to compute internal
  cost figures from tracked token usage (§8).
- **PDF Report**: an on-demand-rendered PDF of a run's output or an admin
  usage summary, branded and classification-marked, delivered by email
  attachment or UI download (§2.5).

## 14. Open Questions

- Accessibility conformance scope (§5): confirm WCAG 2.1 AA is the right
  target (vs. a formal Section 508 VPAT requirement) and how it will be
  tested/verified.
- Exact structured-data field list for RFC 5424 syslog messages is
  proposed in §7.1 — confirm it covers what a target SIEM integration
  needs.
- Concurrency defaults (25 global / 5 per-user) are accepted as a
  starting point; **explicitly deferred for revisit** once real usage
  patterns are observed post-launch — no action needed now.
- Confirm the live deployed LibreChat version's Agents API actually
  returns a `usage` object on chat-completions responses (expected, since
  it's OpenAI-compatible, but needs a live check against the target
  LibreChat instance before implementation locks in on it).
- PDF rendering engine choice (§2.5) tracks the backend language/
  framework decision (e.g. WeasyPrint implies Python, Puppeteer/
  Playwright implies Node) — finalize together with §11 architecture.

## 15. Change Log

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
  added proposed audit event schema (§7.1) and its RFC 5424 field
  mapping; gap-analysis pass added: retry-policy defaults, LibreChat
  agent discovery, API key lifecycle handling, schedule time zone
  handling, schedule pause/resume, WCAG 2.1 AA accessibility target,
  session idle-timeout requirement, decoupled run-history retention from
  the 14-day audit window, FIPS crypto flag, health/metrics endpoints,
  and JSON import/export of job/schedule/prompt definitions. New open
  questions raised: Team/service-owned schedule execution identity,
  run-history retention default, missed-run/catch-up semantics, and
  whether FIPS-validated crypto is mandatory.
- 2026-07-12: Resolved remaining gap-analysis questions — Teams can hold
  their own LibreChat API key so Team-shared schedules survive creator
  turnover/key revocation; job run history/output retention defaults to
  90 days (separate from the 14-day audit window); missed schedule fires
  are skipped (not caught up) on scheduler/worker recovery; FIPS 140-2/
  140-3 validated cryptography is now a **required** constraint on base
  images and crypto library choices.
- 2026-07-12: Second usefulness pass — added "Run Now"/manual execution
  (§2.1), outbound webhook delivery with admin allow-listing (§2.2),
  prompt templating/variables and Prompt Library discovery (§2.3),
  maker-checker approval workflow for shared schedules (§2.4), a new
  **Classification & Marking** section (§6: admin-editable classification
  taxonomy, content tagging, persistent top/bottom classification banner
  with configurable text and colors), and a new **Usage & Reporting**
  section (§8: dashboard, cost visibility, optional quotas, CSV export).
  Sections renumbered accordingly; webhook delivery removed from
  Non-Goals since it's now a real feature; job-chaining and dynamic
  banner-switching added to Non-Goals as explicit v1 exclusions.
- 2026-07-12: Clarified that the §6 classification banner (system-wide,
  static) and per-object classification labels are fully independent —
  labels never drive the banner; confirmed approval re-triggering (§2.4)
  applies to substantive edits only, as originally drafted; redesigned
  §8 cost visibility around internally computed cost — since this
  deployment is fully offline/air-gapped with no external billing API,
  Nexus Scheduler tracks LibreChat's per-run token usage and computes
  cost from **admin-configurable rates** ($ per million prompt/completion
  tokens, optionally per agent/model), calculated at run time from the
  rate in effect then so historical costs don't shift if rates change
  later.
- 2026-07-12: Added **Report Generation & Delivery** (§2.5): on-demand
  PDF rendering (well-known HTML-to-PDF engine, bundled for offline use)
  for job/run output and for §8 admin usage reports, delivered via email
  attachment (reusing existing SMTP integration, including a new
  recurring-usage-report-email option for admins) or on-demand UI
  download. PDFs carry the same branding as the web UI plus the §6
  system-wide classification banner (and an object-level classification
  label when present) so marking travels with exported documents. Added
  a security note that the PDF renderer must not fetch remote resources
  at render time, mirroring the webhook allow-list's SSRF rationale.
