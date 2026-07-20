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

{{- /* Passthrough dnsConfig for every pod in this chart (issue #215).
       Unset by default. On a cluster whose nodes carry a corporate
       search domain that resolves a wildcard, the default ndots:5
       makes an outbound registry/model-catalog hostname (fewer than 5
       dots) tried against the search list first — silently hijacked to
       an internal host instead of the real one, surfacing as a
       confusing TLS certificate error rather than a DNS error. This is
       the chart where that bit hardest: Ollama's model pulls, the
       LiteLLM cost-map fetch, and LibreChat's image all go outbound. */ -}}
{{- define "test-ai.dnsConfig" -}}
{{- with .Values.global.dnsConfig }}
dnsConfig:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
