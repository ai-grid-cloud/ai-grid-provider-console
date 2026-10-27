#!/usr/bin/env bash
# Hands a console deployed from manifests/base (kustomize) over to a Helm release in place. Helm
# adopts objects that carry its ownership marks, but its install leaves an adopted object as it is,
# so this applies the chart's objects first, then marks them. Does nothing when the Deployment is
# missing or already belongs to a release. hack/deploy.sh and hack/test-chart-kind.sh use it.
#
#   hack/chart-takeover.sh <release> <namespace> [chart values...]
#
#   KUBECTL       oc or kubectl (default oc)
#   KUBE_CONTEXT  the kubeconfig context to act on (default: the current one)
set -euo pipefail
RELEASE=$1 NAMESPACE=$2
shift 2
CHART="$(cd "$(dirname "$0")/.." && pwd)/charts/ai-grid-provider-console"
NAME=ai-grid-provider-console
k() { "${KUBECTL:-oc}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} "$@"; }

k get deployment "${NAME}" -n "${NAMESPACE}" >/dev/null 2>&1 || exit 0
[[ -z "$(k get deployment "${NAME}" -n "${NAMESPACE}" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}')" ]] || exit 0
echo "==> taking over the console deployed from manifests/base"
rendered="$(mktemp)"
trap 'rm -f "${rendered}"' EXIT
helm template "${RELEASE}" "${CHART}" -n "${NAMESPACE}" "$@" >"${rendered}"
k apply -f "${rendered}" >/dev/null
k annotate -f "${rendered}" --overwrite \
  meta.helm.sh/release-name="${RELEASE}" meta.helm.sh/release-namespace="${NAMESPACE}" >/dev/null
k label -f "${rendered}" --overwrite app.kubernetes.io/managed-by=Helm >/dev/null
