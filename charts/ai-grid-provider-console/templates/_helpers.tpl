{{- define "console.fullname" -}}
{{- required "fullnameOverride is required" .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The selector, equal to the one manifests/base gives the Deployment: a Deployment's selector
     can't change, so a hub that ran manifests/base can move to this chart in place. */}}
{{- define "console.selectorLabels" -}}
app.kubernetes.io/name: ai-grid-provider-console
app.kubernetes.io/part-of: ai-grid
{{- end -}}

{{- define "console.labels" -}}
{{ include "console.selectorLabels" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* repository:tag, repository@digest, or repository:tag@digest. */}}
{{- define "console.image" -}}
{{- $ref := required "an image repository is required" .repository -}}
{{- if .tag }}{{ $ref = printf "%s:%s" $ref .tag }}{{ end -}}
{{- if .digest }}{{ $ref = printf "%s@%s" $ref .digest }}{{ end -}}
{{- if not (or .tag .digest) }}{{ fail (printf "image %s needs a tag or a digest" .repository) }}{{ end -}}
{{- $ref -}}
{{- end -}}

{{- define "console.serviceAccountName" -}}{{ include "console.fullname" . }}{{- end -}}
{{- define "console.oauthSecretName" -}}{{ .Values.oauth.secretName | default (printf "%s-oauth" (include "console.fullname" .)) }}{{- end -}}
{{- define "console.tlsSecretName" -}}{{ .Values.tls.secretName | default (printf "%s-tls" (include "console.fullname" .)) }}{{- end -}}
{{/* Not defaulted when empty: an empty name would render `name: ""`, which no Secret has. */}}
{{- define "console.keycloakSecretName" -}}{{ required "backend.keycloakSecretName is required: the Secret with the backend's Keycloak settings (hack/deploy.sh creates ai-grid-backend-keycloak)" .Values.backend.keycloakSecretName }}{{- end -}}
