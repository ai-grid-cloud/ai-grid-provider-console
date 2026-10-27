#!/usr/bin/env bash
# Print the path of a file holding the OpenShift service CA from your `oc login`, or fail when the
# cluster has none. The BFF verifies the hub's Perses certificate with it (PERSES_CA_FILE):
# the Cluster Observability Operator's Perses serves a service-CA certificate. Every namespace
# carries the CA in ConfigMap openshift-service-ca.crt; the argument names the one to read
# (default: the Perses namespace, which make dev-cluster may already port-forward in).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/.cache/service-ca.crt"
NS="${1:-openshift-cluster-observability-operator}"
mkdir -p "${ROOT}/.cache"
if oc get configmap openshift-service-ca.crt -n "${NS}" -o jsonpath='{.data.service-ca\.crt}' > "${OUT}" 2>/dev/null && [[ -s "${OUT}" ]]; then
  echo "${OUT}"
else
  rm -f "${OUT}"
  echo "service-ca: no ConfigMap openshift-service-ca.crt in ${NS}; set PERSES_CA_FILE" >&2
  exit 1
fi
