#!/usr/bin/env bash
# Remove the console release, its secrets and OAuthClient. Keeps the namespace. A console deployed
# before the chart (kustomize, manifests/base) is removed from manifests/base instead.
set -euo pipefail
NAMESPACE="${NAMESPACE:-ai-grid}"
NAME=ai-grid-provider-console
RELEASE="${RELEASE:-ai-grid-provider-console}"
if helm status "${RELEASE}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  helm uninstall "${RELEASE}" -n "${NAMESPACE}" --wait
else
  MANIFESTS="$(cd "$(dirname "$0")/.." && pwd)/manifests/base"
  kustomize build "${MANIFESTS}" | grep -v '^kind: Namespace' | oc delete --ignore-not-found -f - || true
fi
oc delete secret "${NAME}-oauth" ai-grid-backend-keycloak -n "${NAMESPACE}" --ignore-not-found
oc delete oauthclient "${NAME}" --ignore-not-found
