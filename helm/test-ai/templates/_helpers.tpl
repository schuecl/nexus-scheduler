{{- define "test-ai.fullname" -}}
{{- /* trunc 42, not 63: the longest suffix this chart appends is
     "-ollama-pull-<8-char hash>" (21 chars) — a long-but-valid release
     name would otherwise render resource names past the 63-char DNS
     label limit and fail at apply time. */ -}}
{{- printf "%s" .Release.Name | trunc 42 | trimSuffix "-" -}}
{{- end -}}

{{- define "test-ai.labels" -}}
app.kubernetes.io/part-of: test-ai
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "test-ai.image" -}}
{{- $registry := .root.Values.global.imageRegistry -}}
{{- $repo := .image.repository -}}
{{- if $registry }}{{ $repo = printf "%s/%s" $registry $repo }}{{ end -}}
{{- if .image.digest -}}
{{ printf "%s@%s" $repo .image.digest }}
{{- else -}}
{{ printf "%s:%s" $repo .image.tag }}
{{- end -}}
{{- end -}}

{{- /* Generate-or-preserve a random secret value: explicit value from
       an existing release Secret wins, else a fresh random. Usage:
       dict "ns" .Release.Namespace "secret" <name> "key" <key> */ -}}
{{- define "test-ai.stableSecret" -}}
{{- $existing := lookup "v1" "Secret" .ns .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{ index $existing.data .key | b64dec }}
{{- else -}}
{{ printf "sk-%s" (randAlphaNum 32) }}
{{- end -}}
{{- end -}}

{{- /* Same generate-or-preserve semantics, but emitting exactly
       .len lowercase hex characters — LibreChat's CREDS_KEY (64) and
       CREDS_IV (32) reject anything else. */ -}}
{{- define "test-ai.stableHexSecret" -}}
{{- $existing := lookup "v1" "Secret" .ns .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{ index $existing.data .key | b64dec }}
{{- else -}}
{{ randAlphaNum 64 | sha256sum | trunc (int .len) }}
{{- end -}}
{{- end -}}
