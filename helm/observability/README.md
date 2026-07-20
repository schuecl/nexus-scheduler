# helm/observability — the Grafana stack for an air-gapped cluster

One collector, two backends, one UI. This chart exists for clusters that
have **no monitoring stack at all**, where "some observability, owned and
upgraded deliberately" beats none.

If your cluster already runs Prometheus and Grafana, **skip this chart** —
use the app chart's `observability.serviceMonitor` values instead and point
your existing stack at the app. Running both means every target is scraped
twice.

---

## What it deploys

| Component | Kind | Role |
|---|---|---|
| **Alloy** | DaemonSet | The only collector. Scrapes `/metrics`, tails pod logs, reads each node's kubelet cAdvisor, optionally reads the node itself |
| **Mimir** | StatefulSet | Metrics backend, Prometheus-compatible, monolithic mode |
| **Loki** | StatefulSet | Logs backend, single-binary mode |
| **Grafana** | Deployment | Dashboards and alerting, provisioned as code |
| *Alloy-integrations* | Deployment | Optional. One extra Alloy for Postgres/Redis exporters — singleton, not per-node |
| *litellm-exporter* | Deployment | Optional. Turns the gateway's spend log into Prometheus series |

Single replica of everything, filesystem-backed. This is **not** an HA
metrics platform and does not try to be.

---

## Topology

```
                        ┌──────────────────── your cluster ────────────────────┐
                        │                                                      │
   ┌────────────────────┴───────────────┐   ┌──────────────────────────────┐   │
   │  namespace: nexus  (app chart)     │   │  namespace: nexus-ai         │   │
   │                                    │   │  (test-ai chart)             │   │
   │   api        :3000  /metrics   ◄───┼───┼─┐  librechat                 │   │
   │   worker     :3001  /metrics   ◄───┼───┼─┤  litellm    :4000          │   │
   │   pdf-service:9464  /metrics   ◄╌╌╌┼╌╌╌┼╌┤  ollama                    │   │
   │   frontend          (no metrics)   │   │ │                            │   │
   └────────────────────────────────────┘   └─┼────────────────────────────┘   │
                                              │                                │
   ┌──────────────────────────────────────┐   │                                │
   │  namespace: nexus-ocr  (ocr chart)   │   │                                │
   │   ocr        :4200  /metrics   ◄─────┼───┤                                │
   └──────────────────────────────────────┘   │                                │
                                              │  scrape (pull)                 │
   ┌──────────────────────────────────────────┼──────────────────────────────┐ │
   │  namespace: observability (this chart)   │                              │ │
   │                                          │                              │ │
   │   ┌──────────────────────────────────────┴─────────────────┐            │ │
   │   │  Alloy  (DaemonSet — one pod per node)                  │           │ │
   │   │    • pods annotated prometheus.io/scrape=true           │           │ │
   │   │      in alloy.appNamespaces + this namespace            │           │ │
   │   │    • pod logs, same namespaces                          │           │ │
   │   │    • kubelet /metrics/cadvisor  (node-local)            │           │ │
   │   │    • node /proc,/sys,/   via hostPath  (hostMetrics)    │           │ │
   │   └───────────────┬───────────────────────┬────────────────┘            │ │
   │        metrics    │                       │  logs                       │ │
   │      remote_write │                       │  push                       │ │
   │                   ▼                       ▼                             │ │
   │            ┌───────────┐            ┌──────────┐                        │ │
   │            │   Mimir   │            │   Loki   │                        │ │
   │            │  PVC 10Gi │            │ PVC 10Gi │                        │ │
   │            │  15d      │            │  168h    │                        │ │
   │            └─────┬─────┘            └────┬─────┘                        │ │
   │                  │   datasource: mimir   │  datasource: loki            │ │
   │                  └───────────┬───────────┘                              │ │
   │                              ▼                                          │ │
   │                        ┌───────────┐                                    │ │
   │                        │  Grafana  │  13 dashboards, provisioned        │ │
   │                        │  PVC 2Gi  │                                    │ │
   │                        └───────────┘                                    │ │
   │                                                                         │ │
   │   optional ──────────────────────────────────────────────────────────   │ │
   │   alloy-integrations ──► postgres_exporter / redis_exporter ──► Mimir    │ │
   │   litellm-exporter   ──► LiteLLM /spend/logs ──────────────► (scraped)   │ │
   └─────────────────────────────────────────────────────────────────────────┘ │
                        │                                                      │
                        └──────────────────────────────────────────────────────┘

   ◄───  pull (Alloy scrapes the target)
   ◄╌╌╌  pull, but NOT wired today — see "Known gap: pdf-service"
```

**Everything is pull-based except the LiteLLM spend log**, which the
exporter fetches from the gateway API and re-exposes for Alloy to scrape.
Nothing in the application pushes to this stack.

---

## Install

```bash
helm install obs helm/observability \
  --namespace observability --create-namespace \
  --set 'alloy.appNamespaces[0]=nexus' \
  --set 'alloy.appNamespaces[1]=nexus-ai' \
  --set 'alloy.appNamespaces[2]=nexus-ocr'
```

`alloy.appNamespaces` is **the one setting that matters**. Alloy only looks
in the namespaces you name, plus its own. Leave it empty and you get a
healthy-looking stack that collects only itself.

Then reach Grafana:

```bash
kubectl -n observability port-forward svc/obs-grafana 3000:3000
kubectl -n observability get secret obs-grafana-admin \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

Log in as `admin` with that password. If you did not set
`grafana.adminPassword`, one was generated and stored in that Secret; it is
preserved across upgrades rather than rotated.

---

## Wiring each component

### Nexus Scheduler (api + worker) — nothing to do

The app chart already annotates both pods:

```yaml
prometheus.io/scrape: "true"
prometheus.io/path: /metrics
prometheus.io/port: "3000"   # api;  worker uses 3001
```

Name the app's namespace in `alloy.appNamespaces` and they are collected.
Logs are tailed from the same pods automatically.

### OCR — annotate, and open the NetworkPolicy

The OCR chart annotates its pod when `metrics.annotations` is true (the
default), but its NetworkPolicy denies everything else by default. Alloy
lives in another namespace, so its scrape is refused at the network — the
target appears and times out.

```yaml
# values for helm/ocr
metrics:
  annotations: true
  scraperNamespaces: ["observability"]   # ← without this, ocr shows up=0
```

### LibreChat / Ollama

Annotate the pods in the test-ai chart the same way and name that namespace
in `alloy.appNamespaces`. Nothing else is required.

### LiteLLM — needs the exporter

The gateway's spend and token data lives behind its admin API, not on a
`/metrics` endpoint. The optional exporter polls it and re-exposes it:

```yaml
litellmExporter:
  enabled: true
  litellmUrl: http://litellm.nexus-ai.svc:4000
  existingSecret: litellm-master-key      # Secret with key `masterKey`
```

Without this, `ai-savings.json` is entirely blank and
`ai-consumption-cost.json` mostly so.

### Postgres / Redis

```yaml
integrations:
  postgres:
    enabled: true
    existingSecret: postgres-dsn
  redis:
    enabled: true
    addr: redis.nexus.svc:6379
    existingSecret: redis-auth
```

These run in a **singleton** Deployment, not the DaemonSet — a database
should be scraped once, not once per node. Without them the `pg_*` and
`redis_*` half of `infrastructure.json` stays empty.

---

## Metrics available

### Nexus Scheduler — worker (`service="worker"`)

| Metric | Type | Notable labels |
|---|---|---|
| `nexus_scheduler_runs_total` | counter | `status` |
| `nexus_scheduler_run_duration_seconds` | histogram | `status` |
| `nexus_scheduler_queue_depth` | gauge | |
| `nexus_scheduler_queue_wait_seconds` | histogram | |
| `nexus_scheduler_librechat_call_duration_seconds` | histogram | `model`, `outcome` |
| `nexus_scheduler_librechat_errors_total` | counter | `kind`, `model` |
| `nexus_scheduler_run_tokens_total` | counter | `model`, `type` |
| `nexus_scheduler_run_cost_total` | counter | `model` |
| `nexus_scheduler_runs_throttled_total` | counter | `scope` |
| `nexus_scheduler_concurrency_limit` | gauge | `scope` |
| `nexus_scheduler_tick_total` / `_duration_seconds` | counter / histogram | `result` |
| `nexus_scheduler_schedules_claimed_total` / `_missed_total` | counter | |
| `nexus_scheduler_orphan_reaper_tick_total` / `_duration_seconds` | counter / histogram | |
| `nexus_scheduler_orphan_runs_reaped_total` | counter | |
| `nexus_scheduler_ocr_extraction_seconds` | histogram | |

### Nexus Scheduler — api (`service="api"`)

| Metric | Type |
|---|---|
| `nexus_scheduler_http_request_duration_seconds` | histogram |
| `nexus_scheduler_jobs` | gauge |
| `nexus_scheduler_schedules` | gauge (`type`, `paused`) |
| `nexus_scheduler_api_keys` | gauge |
| `nexus_scheduler_projects` | gauge |
| `nexus_scheduler_prompts` | gauge |

Both also expose the standard `nodejs_*` and `process_*` series.

### OCR (`service="ocr"`)

`nexus_ocr_requests_total` (`outcome`), `nexus_ocr_pages_total`
(`disposition`), `nexus_ocr_stage_duration_seconds` (`stage`),
`nexus_ocr_input_files_total` (`kind`), `nexus_ocr_document_pages`,
`nexus_ocr_descriptions_total`.

### LiteLLM gateway (via the exporter)

`litellm_gateway_up`, `litellm_gateway_requests_total`,
`litellm_gateway_tokens_total`, `litellm_gateway_spend_usd_total`,
`litellm_gateway_mcp_calls_total`.

### pdf-service

`nexus_scheduler_pdf_render_duration_seconds`,
`nexus_scheduler_pdf_renders_total` — **not collected by this chart today**,
see below.

### Infrastructure

`container_*` from kubelet cAdvisor, `node_*` from Alloy's unix exporter
when `hostMetrics` is on, `pg_*` / `redis_*` from the integrations.

---

## The `service` label

Every dashboard selects on `service`. Alloy derives it from
`app.kubernetes.io/component`, falling back to `app.kubernetes.io/name`. The
app, OCR and this chart all set those, so `service` resolves to `api`,
`worker`, `ocr`, `mimir`, `loki`, `grafana`.

**A pod you annotate yourself must carry one of those labels**, or its
series arrive with an empty `service` and no dashboard will show them.

---

## Making Grafana reachable

Port-forward is the default and needs no configuration. For a persistent
URL:

```yaml
grafana:
  ingress:
    enabled: true
    className: nginx          # or your controller's class
    host: grafana.example.internal
    tls:
      - secretName: grafana-tls
        hosts: [grafana.example.internal]
```

Or expose the Service directly:

```yaml
grafana:
  service:
    type: LoadBalancer        # default ClusterIP
    port: 3000
```

Set `grafana.adminPassword` explicitly if you want a known credential
instead of the generated one.

---

## Running on a hardened or Tanzu cluster

The defaults satisfy Pod Security Admission **`restricted`** — every pod and
container carries `seccompProfile: RuntimeDefault`, `runAsNonRoot`,
`allowPrivilegeEscalation: false` and `capabilities.drop: [ALL]`.

**One exception:** `alloy.hostMetrics: true` mounts `/proc`, `/sys` and `/`
as read-only hostPaths, and `hostPath` is forbidden at PSA *baseline*, not
just `restricted`. On a policy-enforcing namespace you must either relax the
namespace to `privileged`, or:

```yaml
alloy:
  hostMetrics: false      # host.json goes blank; everything else works
```

Other knobs that matter here:

```yaml
global:
  seccompProfile: RuntimeDefault   # blank it only if your policy forbids the field
  tolerations:                     # Tanzu taints control-plane nodes — without
    - key: node-role.kubernetes.io/control-plane   # this they collect nothing
      effect: NoSchedule
  imagePullSecrets:
    - name: mirror-creds
  priorityClassName: ""
  nodeSelector: {}
  affinity: {}

alloy:   { securityContext: { runAsUser: 473 } }    # override if a PSP pins
mimir:   { securityContext: { runAsUser: 10001 } }  # runAsUser to a UID range
loki:    { securityContext: { runAsUser: 10001 } }
grafana: { securityContext: { runAsUser: 472 } }
```

---

## Storage

**Nothing is pinned on purpose.** An empty `storageClassName` means "use the
cluster's default StorageClass", which is the right behaviour on every
distribution.

```yaml
global:
  storageClassName: ""        # applies to all three PVCs when set

mimir:   { persistence: { enabled: true, size: 10Gi, storageClassName: "" } }
loki:    { persistence: { enabled: true, size: 10Gi, storageClassName: "" } }
grafana: { persistence: { enabled: true, size: 2Gi,  storageClassName: "" } }
```

Many Tanzu clusters ship StorageClasses but mark **none** of them default.
On such a cluster the install now **fails immediately**, naming the classes
that do exist, rather than leaving three pods `Pending` forever with nothing
saying why. Pick one:

```bash
--set global.storageClassName=vsan-default
```

Or run without persistence entirely — useful for an evaluation, and the only
option on a cluster with no dynamic provisioning:

```bash
--set mimir.persistence.enabled=false \
--set loki.persistence.enabled=false \
--set grafana.persistence.enabled=false
```

Data then lives in an `emptyDir` and does not survive a restart.

---

## Air-gapped installs

```yaml
global:
  imageRegistry: registry.example.internal
  imagePullSecrets:
    - name: mirror-creds
```

The registry is prepended to each repository — except repositories that
already carry a host, which are left alone, so you never get
`mirror/ghcr.io/...`.

Every image accepts a `digest`, which takes precedence over `tag`. Pin
digests for a reproducible mirror; tags are a convenience for connected dev
clusters.

```yaml
mimir:
  image:
    repository: grafana/mimir
    tag: "2.14.2"
    digest: "sha256:..."     # wins over tag
```

---

## Dashboards

13, provisioned as code and byte-identical to the Compose stack's:

`nexus-scheduler-overview`, `api-service`, `worker-service`, `ocr-service`,
`pdf-service`, `infrastructure`, `host`, `logs`, `collector-health`,
`system-map`, `ai-model-performance`, `ai-consumption-cost`, `ai-savings`.

Which ones need what:

| Dashboard | Requires |
|---|---|
| `infrastructure` | `integrations.postgres` / `integrations.redis` for the `pg_*`/`redis_*` half |
| `ai-savings`, `ai-consumption-cost` | `litellmExporter.enabled` |
| `host` | `alloy.hostMetrics: true` |
| `ocr-service` | the OCR chart's `metrics.scraperNamespaces` |

---

## Known gaps

These are tracked upstream; listed here so an empty panel is not mistaken
for a broken install.

- **pdf-service is not collected.** Its metrics live on a dedicated
  scrape-only port that only a ServiceMonitor targets, and Alloy discovers
  by pod annotation. Every `pdf-service` panel is empty and `system-map`
  shows it *down* rather than *no data*.
- **Some container panels query Compose-only labels.** `system-map` keys
  three tiles on Docker container names (`.*librechat-1.*` and friends) that
  cannot exist in Kubernetes, and several `by (name)` panels should be
  `by (namespace, pod, container)`.
- **`collector-health`'s remote-write lag uses `max() - max()`**, which was
  correct for one Alloy and hides a wedged node now that Alloy is a
  DaemonSet.
- **No profiling or tracing.** Pyroscope and Tempo are deliberately absent —
  the app has no profiling or OpenTelemetry instrumentation, so those
  backends would stand up and receive nothing.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Everything empty, Alloy healthy | `alloy.appNamespaces` not set — Alloy is only watching its own namespace |
| DaemonSet `DESIRED n / READY 0` | PSA rejected the pods. Almost always `hostMetrics` + a `restricted` namespace |
| Mimir/Loki/Grafana `Pending` | No default StorageClass. Set `global.storageClassName` or disable persistence |
| `ImagePullBackOff` on one pod | An authenticated mirror without `global.imagePullSecrets` |
| A node contributes nothing | Node is tainted and `global.tolerations` is empty |
| `up{service="ocr"} == 0` | The OCR chart's NetworkPolicy — set its `metrics.scraperNamespaces` |
| Series arrive with empty `service` | The pod lacks `app.kubernetes.io/component` / `name` |
| Doubled samples | Another Prometheus scrapes the same targets. Pick one collector |
| Remote write / scrape target fails TLS verification against a hostname that looks right | Corporate DNS search domain with a wildcard — see below |

**TLS error naming a host you don't recognize (e.g. `*.traefik.default` when you expected a public registry or GitHub raw content):** this is usually DNS, not TLS. If the cluster's nodes carry a search domain that resolves a wildcard, Kubernetes' default `ndots:5` tries every outbound hostname with fewer than 5 dots against the search list *before* the real one — silently resolving it to an internal host that presents its own certificate. Confirm with `getent hosts <host>` vs `getent hosts <host>.` (trailing dot bypasses the search list) inside the pod; if those differ, set `global.dnsConfig` (unset by default, see `values.yaml`) to `ndots: 1`. Safe for this chart — every in-cluster lookup goes through explicit search-list entries regardless of `ndots`.

Useful commands:

```bash
# what Alloy actually discovered — its UI lists every target and its health
POD=$(kubectl -n observability get pod -l app.kubernetes.io/name=alloy \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n observability port-forward "$POD" 12345:12345
# → http://localhost:12345/graph

# is anything reaching Mimir?
kubectl -n observability logs "$POD" | grep -i remote_write

# does the target answer at all, from inside the cluster?
kubectl -n nexus exec deploy/app-api -- wget -qO- localhost:3000/metrics | head
```
