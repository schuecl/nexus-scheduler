# Nexus Scheduler — Architecture

This document visualizes the system structure described in
[REQUIREMENTS.md](./REQUIREMENTS.md). It captures the working technical
direction (still draft, see REQUIREMENTS.md §11) as diagrams rather than
prose — the "why" behind each decision lives in REQUIREMENTS.md; this file
is the "what it looks like."

Diagrams are [Mermaid](https://mermaid.js.org/) and render natively on
GitHub/GitLab.

## 1. System Context

Who and what Nexus Scheduler talks to, at the boundary of the deployment.

```mermaid
flowchart LR
    subgraph Users
        EndUser[Editor / Viewer<br/>browser]
        Admin[Admin<br/>browser]
    end

    NS[["Nexus Scheduler"]]

    KC[(Keycloak<br/>OIDC IdP)]
    LC[[LibreChat<br/>Agents API]]
    SMTP[(SMTP Relay)]
    SIEM[(Syslog / SIEM)]
    WH[(Internal Webhook<br/>Destinations<br/>admin allow-listed)]

    EndUser -- HTTPS --> NS
    Admin -- HTTPS --> NS
    NS -- OIDC login --> KC
    NS -- "Bearer API key<br/>(user or Team key)" --> LC
    NS -- notifications --> SMTP
    NS -- RFC 5424 audit/log stream --> SIEM
    NS -- signed run results --> WH
```

Everything above the dotted line in later diagrams runs **inside** the
air-gapped Government network. LibreChat, Keycloak, SMTP, SIEM, and
webhook destinations are all internal services on that same network —
nothing here reaches the public internet at runtime (REQUIREMENTS.md §3).

## 2. Containers / Runtime Components

```mermaid
flowchart TB
    subgraph edge["Edge (pre-existing in prod)"]
        NGINX[nginx reverse proxy<br/>TLS termination]
    end

    subgraph app["Nexus Scheduler"]
        FE[Frontend SPA<br/>static assets]
        API[Backend API<br/>auth · CRUD · audit access]
        WORKER[Scheduler / Worker<br/>fires due schedules,<br/>calls LibreChat, retries,<br/>enforces concurrency]
    end

    subgraph data["Data Layer"]
        PG[(PostgreSQL<br/>system of record)]
        REDIS[(Redis<br/>job queue /<br/>scheduling coordination)]
    end

    NGINX --> FE
    NGINX --> API
    API <--> PG
    API <--> REDIS
    WORKER <--> PG
    WORKER <--> REDIS
    WORKER -- REST, Bearer key --> LC[[LibreChat Agents API]]
```

**Why API and Worker are separate containers**: the API serves interactive
UI traffic; the Worker runs due schedules concurrently and must scale
independently (horizontally, via replica count) as job volume grows,
without affecting UI responsiveness. Redis is the coordination point
between them — see REQUIREMENTS.md §2.1 and §11.

### Component responsibilities

| Component | Responsibility |
|---|---|
| Frontend (SPA) | Job/schedule/Project/Team UI, Prompt Library, admin settings, classification banner rendering |
| Backend API | AuthN/AuthZ (OIDC + local), CRUD for jobs/schedules/Projects/Teams/prompts, audit log access, approval queue, reporting endpoints, on-demand PDF download |
| Scheduler/Worker | Polls due schedules, enqueues/dequeues runs respecting concurrency limits, calls LibreChat, retries, computes cost, sends notifications/webhooks/emailed PDF reports, writes audit events |
| PDF Renderer | Shared HTML-to-PDF rendering capability (in-process library or internal call, no network egress) used by both API (on-demand download) and Worker (emailed reports) — REQUIREMENTS.md §2.5 |
| PostgreSQL | System of record: see §5 data model |
| Redis | Job queue + scheduling coordination across Worker replicas |
| nginx | TLS termination + reverse proxy (pre-existing in prod; included in Compose for local parity) |

## 3. Job Execution Flow

The core operational loop: a schedule fires, a job runs against LibreChat,
and the result is stored, audited, and optionally delivered.

```mermaid
sequenceDiagram
    actor U as Editor
    participant FE as Frontend
    participant API as Backend API
    participant DB as PostgreSQL
    participant Q as Redis Queue
    participant W as Scheduler/Worker
    participant LC as LibreChat Agents API
    participant SMTP as SMTP
    participant WH as Webhook Destination

    U->>FE: Define schedule (interval, prompt, agent, timezone)
    FE->>API: POST /schedules
    API->>DB: Persist schedule
    Note over API,DB: Shared Project? status = pending_approval (§2.4)
    API-->>FE: 201 Created

    loop Every tick
        W->>DB: Find schedules due to fire
        W->>Q: Enqueue due run (skips if worker was down at fire time)
    end

    W->>Q: Dequeue run (bounded by global/per-user concurrency, §2.1)
    W->>DB: Load job + pinned/latest prompt version + API key (user or Team)
    W->>LC: POST /api/agents/v1/chat/completions (Bearer API key)
    alt success
        LC-->>W: response + usage (prompt/completion tokens)
        W->>DB: Store run (output, tokens, computed cost, status=success)
    else transient failure
        W->>W: Retry with backoff (default 2x, §2.1)
        W->>LC: retry request
    else non-transient failure (e.g. 401 expired key)
        W->>DB: Store run (status=failed), mark API key invalid
        W->>U: Notify key owner (UI banner + email)
    end
    W->>DB: Write audit event (run.start / run.complete)
    opt Email notification configured
        opt PDF report attachment enabled
            W->>W: Render PDF (branding + classification banner)
        end
        W->>SMTP: Send completion/failure email (optionally with PDF attached)
    end
    opt Webhook configured
        W->>WH: POST signed run result (allow-listed destination only)
    end
```

## 4. Data Model (Illustrative)

Not a final schema — shows the key entities and relationships implied by
REQUIREMENTS.md (§2–§8).

```mermaid
erDiagram
    USER ||--o{ TEAM_MEMBERSHIP : "belongs to"
    TEAM ||--o{ TEAM_MEMBERSHIP : has
    TEAM ||--o{ TEAM : "parent of (nesting)"
    USER ||--o{ API_KEY : owns
    TEAM ||--o{ API_KEY : owns

    USER ||--o{ PROJECT : owns
    PROJECT ||--o{ PROJECT_ACL : "shared via (user or Team)"
    PROJECT }o--|| CLASSIFICATION_LABEL : "tagged with"
    PROJECT ||--o{ PROMPT : contains

    PROMPT ||--o{ PROMPT_VERSION : has

    PROJECT ||--o{ JOB : contains
    PROMPT_VERSION ||--o{ JOB : "referenced by (pinned or latest)"
    JOB ||--o{ SCHEDULE : "triggered by"
    SCHEDULE ||--o{ RUN : produces
    JOB ||--o{ RUN : "ad-hoc (Run Now)"

    RUN ||--o{ AUDIT_EVENT : generates
    JOB ||--o{ WEBHOOK_DESTINATION : "delivers to (allow-listed)"
    AGENT_COST_RATE ||--o{ RUN : "priced by (rate in effect at run time)"
```

Key fields worth calling out explicitly (full detail in REQUIREMENTS.md):

- `RUN`: `trigger_type` (scheduled/manual), `status`, `prompt_tokens`,
  `completion_tokens`, `computed_cost`, `output`, timing fields.
- `SCHEDULE`: `timezone` (IANA), `paused`, `approval_status`,
  `version_pin_mode` (pinned vs. always-latest).
- `AUDIT_EVENT`: see the proposed schema in REQUIREMENTS.md §7.1.

## 5. Deployment Topology — Kubernetes (Production)

```mermaid
flowchart TB
    subgraph ext["Existing Cluster/Network Infra"]
        NGINX[nginx<br/>reverse proxy]
        KC[Keycloak]
        LC[[LibreChat Agents API]]
        SIEM[(Syslog / SIEM)]
        SMTPX[(SMTP relay)]
    end

    subgraph ns["K8s Namespace: nexus-scheduler (Helm release)"]
        SVC_API[Service: api]
        subgraph apipods["Deployment: api"]
            API1[api pod]
            API2[api pod ...N]
        end
        subgraph workerpods["Deployment: worker"]
            W1[worker pod]
            W2[worker pod ...N]
        end
        PG[("PostgreSQL<br/>Helm subchart or external")]
        REDIS[("Redis<br/>Helm subchart or external")]
        SEC[/K8s Secrets:<br/>DB creds, OIDC client secret,<br/>SMTP creds, key-encryption key/]
    end

    NGINX --> SVC_API --> API1 & API2
    API1 & API2 --> PG
    API1 & API2 --> REDIS
    W1 & W2 --> PG
    W1 & W2 --> REDIS
    W1 & W2 -- Bearer API key --> LC
    API1 -. OIDC .-> KC
    API1 & W1 -. RFC 5424 .-> SIEM
    W1 -. SMTP .-> SMTPX
    SEC -.-> API1
    SEC -.-> W1
```

- Images relocatable to an internal/offline registry (REQUIREMENTS.md §3).
- Runs in FIPS mode end to end (REQUIREMENTS.md §10).
- `/healthz` and `/metrics` on both Deployments (REQUIREMENTS.md §10, §11).

## 6. Deployment Topology — Docker Compose (Local Dev/Test)

```mermaid
flowchart TB
    subgraph compose["docker-compose (has internet access)"]
        NGINX2[nginx]
        API2[nexus-api]
        W2[nexus-worker]
        FE2[nexus-frontend]
        PG2[(postgres)]
        REDIS2[(redis)]
        KC2[keycloak<br/>test realm]
        MAIL[mailpit / mailhog]
    end
    LC2[[LibreChat<br/>external or test instance]]

    NGINX2 --> FE2
    NGINX2 --> API2
    API2 --> PG2
    API2 --> REDIS2
    W2 --> PG2
    W2 --> REDIS2
    W2 -- Bearer API key --> LC2
    API2 -. OIDC .-> KC2
    W2 -. SMTP .-> MAIL
```

- All secrets/keys **randomly generated at compose-up** (REQUIREMENTS.md
  §9.2) — no committed defaults.
- Exists purely to exercise Nexus Scheduler itself; does not attempt to
  simulate the air-gapped constraint.

## 7. Roles at a Glance

```mermaid
flowchart LR
    admin[admin] -->|manage| users[Users / Roles / System Config /<br/>Branding / Classification Taxonomy]
    editor[editor] -->|create & run| jobs[Jobs / Schedules /<br/>Projects / Prompts / API Keys]
    view[view] -->|read only| history[Run History / Audit Logs /<br/>Shared Projects & Prompts]
```

Full role/permission detail: REQUIREMENTS.md §4.

## 8. Open Items Affecting Architecture

These are tracked as open questions in REQUIREMENTS.md §14 but are called
out here because they affect the diagrams above once resolved:

- Whether PostgreSQL/Redis run as Helm subcharts or as externally-managed
  cluster services changes the boundary of the `ns` subgraph in §5.
- Confirming LibreChat's `usage` response shape affects the `RUN` entity
  in §4 (token fields).
