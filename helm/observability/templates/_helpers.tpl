{{- define "observability.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "observability.labels" -}}
app.kubernetes.io/part-of: nexus-scheduler-observability
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- /* Image reference honouring global.imageRegistry and an optional
       digest pin — digests win over tags, which is the air-gap
       mirrored-registry path. */ -}}
{{- define "observability.image" -}}
{{- $registry := .root.Values.global.imageRegistry -}}
{{- $repo := .image.repository -}}
{{- /* A repository that already carries a registry host (a dot or colon
       before the first slash, or a bare "localhost") must not be
       prefixed again: mirror/ghcr.io/berriai/... is not a valid path on
       any mirror that isn't a pass-through proxy. */ -}}
{{- $first := (splitList "/" $repo) | first -}}
{{- $hasHost := or (contains "." $first) (contains ":" $first) (eq $first "localhost") -}}
{{- if and $registry (not $hasHost) }}{{ $repo = printf "%s/%s" $registry $repo }}{{ end -}}
{{- if .image.digest -}}
{{ printf "%s@%s" $repo .image.digest }}
{{- else -}}
{{ printf "%s:%s" $repo .image.tag }}
{{- end -}}
{{- end -}}

{{- /* Pod-level security context. Pod Security Admission "restricted"
       — the default on TKG and most hardened clusters — requires
       runAsNonRoot plus a seccompProfile; without the latter every
       workload is rejected. UID is the caller's, since each upstream
       image bakes in its own. */ -}}
{{- define "observability.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
{{- with .root.Values.global.seccompProfile }}
seccompProfile:
  type: {{ . }}
{{- end }}
{{- end -}}

{{- /* Container-level security context. readOnlyRootFilesystem is NOT
       set here: "restricted" does not require it, and the Grafana/Mimir/
       Loki images write outside their data mounts. Everything below is
       required by "restricted". */ -}}
{{- define "observability.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
{{- with .root.Values.global.seccompProfile }}
seccompProfile:
  type: {{ . }}
{{- end }}
{{- end -}}

{{- define "observability.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- /* Resolve the StorageClass for a PVC.

       This chart deliberately does not pin a class — the right one
       differs on every distribution, so an unset value means "use the
       cluster default", which is what most clusters want.

       The failure this guards is the silent one: a cluster that has
       StorageClasses but marks none of them default (common on TKG)
       accepts the install and leaves every PVC Pending forever, with
       nothing anywhere saying why. When we can see the cluster, detect
       that and fail with the list of classes that do exist.

       `lookup` returns an empty map during `helm template` and
       `--dry-run`, so an empty result is treated as "unknown, proceed"
       — never as "no storage". */ -}}
{{- define "observability.storageClassName" -}}
{{- $explicit := or .explicit .root.Values.global.storageClassName -}}
{{- if $explicit -}}
storageClassName: {{ $explicit | quote }}
{{- else -}}
{{- $classes := (lookup "storage.k8s.io/v1" "StorageClass" "" "").items -}}
{{- if $classes -}}
{{- $default := false -}}
{{- $names := list -}}
{{- range $classes -}}
{{- $names = append $names .metadata.name -}}
{{- $ann := .metadata.annotations | default dict -}}
{{- if or (eq (index $ann "storageclass.kubernetes.io/is-default-class") "true") (eq (index $ann "storageclass.beta.kubernetes.io/is-default-class") "true") -}}
{{- $default = true -}}
{{- end -}}
{{- end -}}
{{- if not $default -}}
{{- fail (printf "no default StorageClass on this cluster, so every PVC would stay Pending. Set global.storageClassName (or the per-component persistence.storageClassName) to one of: %s — or set persistence.enabled=false to run on emptyDir." (join ", " $names)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* Scheduling knobs applied to every pod in the chart. */ -}}
{{- define "observability.scheduling" -}}
{{- with .Values.global.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.global.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.global.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.global.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
{{- end -}}

{{- /* Passthrough dnsConfig for every pod in the chart (issue #215).
       Unset by default. On a cluster whose nodes carry a corporate
       search domain that resolves a wildcard, the default ndots:5
       makes every outbound hostname with fewer than 5 dots tried
       against the search list first — silently hijacked to an
       internal host instead of the real one. ndots:1 is safe here:
       this chart's in-cluster targets are Service DNS names, matched
       by the explicit search entries regardless of ndots. */ -}}
{{- define "observability.dnsConfig" -}}
{{- with .Values.global.dnsConfig }}
dnsConfig:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
