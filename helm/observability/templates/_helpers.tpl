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
{{- if $registry }}{{ $repo = printf "%s/%s" $registry $repo }}{{ end -}}
{{- if .image.digest -}}
{{ printf "%s@%s" $repo .image.digest }}
{{- else -}}
{{ printf "%s:%s" $repo .image.tag }}
{{- end -}}
{{- end -}}
