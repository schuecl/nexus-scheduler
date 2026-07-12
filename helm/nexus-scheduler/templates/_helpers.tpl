{{- define "nexus-scheduler.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "nexus-scheduler.fullname" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "nexus-scheduler.labels" -}}
app.kubernetes.io/name: {{ include "nexus-scheduler.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "nexus-scheduler.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nexus-scheduler.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "nexus-scheduler.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "nexus-scheduler.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "nexus-scheduler.databaseHost" -}}
{{- if .Values.postgresql.enabled -}}
{{ .Release.Name }}-postgresql
{{- else -}}
{{ .Values.externalDatabase.host }}
{{- end -}}
{{- end -}}

{{- define "nexus-scheduler.redisHost" -}}
{{- if .Values.redis.enabled -}}
{{ .Release.Name }}-redis-master
{{- else -}}
{{ .Values.externalRedis.host }}
{{- end -}}
{{- end -}}
