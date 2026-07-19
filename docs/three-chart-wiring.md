# Three-chart Kubernetes wiring

Nexus Scheduler's application, OCR service, and AI plane are separate Helm
releases. This page gives one concrete three-namespace layout and all values
that connect them. The names below are deliberate: using different release or
namespace names changes the Kubernetes service DNS names.

| Plane | Release | Namespace | Service used by another plane |
| --- | --- | --- | --- |
| AI | `test-ai` | `nexus-ai` | `test-ai-librechat.nexus-ai.svc.cluster.local:3080` |
| OCR | `ocr` | `nexus-ocr` | `ocr.nexus-ocr.svc.cluster.local:4200` |
| Application | `nexus-scheduler` | `nexus-app` | None for this wiring |

## Prerequisites

- Run commands from the repository root with Helm 3 and cluster-admin access.
- Make the application and OCR images available to the cluster and adjust the
  charts' image values for that registry.
- Create the Secrets required by `helm/nexus-scheduler/templates/NOTES.txt` in
  `nexus-app`. The AI chart generates its development secrets unless existing
  Secrets are selected.
- The cluster DNS suffix in the examples is `cluster.local`. Substitute the
  cluster's suffix if it differs.
- NetworkPolicy enforcement requires a compatible CNI. The selectors below
  still render on a cluster without one, but do not enforce isolation there.

Create the namespaces first so their standard
`kubernetes.io/metadata.name` labels exist before the OCR NetworkPolicy is
installed:

```bash
kubectl create namespace nexus-ai --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace nexus-ocr --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace nexus-app --dry-run=client -o yaml | kubectl apply -f -
```

## 1. Install the AI plane

Save this as `values-three-chart-ai.yaml`:

```yaml
librechat:
  ocr:
    baseUrl: http://ocr.nexus-ocr.svc.cluster.local:4200/v1
```

Install the release:

```bash
helm upgrade --install test-ai helm/test-ai \
  --namespace nexus-ai \
  --values values-three-chart-ai.yaml \
  --wait --timeout 20m
```

The `/v1` suffix is required for LibreChat's Mistral-compatible upload flow.
The OCR service does not need to exist while LibreChat starts; it must be ready
before a user selects **Upload as Text**.

## 2. Install OCR and admit both callers

Save this as `values-three-chart-ocr.yaml`. Add the environment-specific
`image.repository`, `image.tag`, or `global.imageRegistry` values needed by
the cluster.

```yaml
networkPolicy:
  clientPeers:
    - name: worker
      namespaces:
        - nexus-app
      podMatchLabels:
        app.kubernetes.io/name: nexus-scheduler
        app.kubernetes.io/component: worker
    - name: librechat
      namespaces:
        - nexus-ai
      podMatchLabels:
        app.kubernetes.io/name: librechat
```

Install the release:

```bash
helm upgrade --install ocr helm/ocr \
  --namespace nexus-ocr \
  --values values-three-chart-ocr.yaml \
  --wait --timeout 15m
```

Keep Worker and LibreChat as separate `clientPeers`. Kubernetes ANDs the
namespace and pod selectors within a peer, while separate peers are ORed; one
combined pod selector cannot match both callers.

## 3. Install the application

Add these fields to the application's normal values file, here named
`values-three-chart-app.yaml`. Preserve the image, Secret, ingress, and other
environment-specific settings already required for the application chart.

```yaml
librechat:
  baseUrl: http://test-ai-librechat.nexus-ai.svc.cluster.local:3080

ocr:
  serviceUrl: http://ocr.nexus-ocr.svc.cluster.local:4200
  describeImages: "false"
```

Install the release:

```bash
helm upgrade --install nexus-scheduler helm/nexus-scheduler \
  --namespace nexus-app \
  --values values-three-chart-app.yaml \
  --wait --timeout 15m
```

`ocr.serviceUrl` has no `/v1` suffix because the Worker calls the native
`/process` API. `librechat.ocr.baseUrl` does include `/v1` because LibreChat
uses the Mistral-compatible endpoints.

## Verify the wiring

All three releases and their endpoints should be ready:

```bash
helm status test-ai --namespace nexus-ai
helm status ocr --namespace nexus-ocr
helm status nexus-scheduler --namespace nexus-app
kubectl get endpoints test-ai-librechat --namespace nexus-ai
kubectl get endpoints ocr --namespace nexus-ocr
```

Then verify both OCR doors:

1. Create or run a Nexus Scheduler job with an attachment and download its
   searchable-PDF artifact.
2. In LibreChat, attach a supported document and select **Upload as Text**.

If either request times out while the OCR pod is healthy, inspect the rendered
OCR NetworkPolicy first:

```bash
kubectl get networkpolicy ocr --namespace nexus-ocr -o yaml
```

The policy must contain one ingress peer for the `nexus-app` Worker labels and
one for the `nexus-ai` LibreChat label, exactly as above.
