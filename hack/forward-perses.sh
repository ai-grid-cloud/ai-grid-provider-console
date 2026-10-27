#!/usr/bin/env bash
# Forward the hub's Perses server from your `oc login` to the address the local BFF relays the
# Monitoring page to, so `make dev-cluster` shows the dashboards the deployed console would. Perses
# authenticates every request with the caller's OpenShift token (the BFF forwards yours), so the
# forward grants nothing your login doesn't have; it still listens on loopback only. It creates
# nothing on the cluster (it needs pods/portforward in the namespace) and reconnects when the
# stream drops or the pod is replaced.
#
#   PERSES_NAMESPACE  namespace of the Perses Service (default openshift-cluster-observability-operator,
#                     the Cluster Observability Operator's instance)
#   PERSES_SERVICE    the Service (default perses)
#   PERSES_ADDRESS    local address to listen on (default 127.0.0.1:9445; one loopback address)
#
# With --check it only reports whether it can forward (login, the Service, permission, a free local
# port), so make dev-cluster can start without Monitoring when it can't.
set -euo pipefail
NAMESPACE="${PERSES_NAMESPACE:-openshift-cluster-observability-operator}"
SERVICE="${PERSES_SERVICE:-perses}"
ADDRESS="${PERSES_ADDRESS:-127.0.0.1:9445}"
HOST="${ADDRESS%:*}"
PORT="${ADDRESS##*:}"

fail() {
  echo "forward-perses: $*" >&2
  exit 1
}

loopback='^(127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|localhost)$'
[[ "${HOST}" =~ ${loopback} ]] || fail "PERSES_ADDRESS must be one loopback address and a port, not ${ADDRESS}"
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  fail "PERSES_ADDRESS has no valid port: ${ADDRESS}"
fi
port_taken() {
  (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null
}

oc whoami >/dev/null 2>&1 || fail "run oc login first"
oc get service "${SERVICE}" -n "${NAMESPACE}" >/dev/null 2>&1 ||
  fail "no Service ${NAMESPACE}/${SERVICE} on $(oc whoami --show-server): Monitoring stays off"
[[ "$(oc auth can-i create pods/portforward -n "${NAMESPACE}" 2>/dev/null)" == yes ]] ||
  fail "your login may not port-forward in ${NAMESPACE}: Monitoring stays off"
port_taken && fail "${ADDRESS} is already in use; stop what listens there, or set PERSES_ADDRESS"
if [[ "${1:-}" == "--check" ]]; then
  exit 0
fi

# The Service's target port; the pod serves TLS there with a service-CA certificate.
REMOTE="$(oc get service "${SERVICE}" -n "${NAMESPACE}" -o jsonpath='{.spec.ports[0].port}')"

# Stop the forward with this script, also when only this script is signalled.
child=
stop() {
  trap - INT TERM EXIT
  if [[ -n "${child}" ]]; then
    kill "${child}" 2>/dev/null || true
    wait "${child}" 2>/dev/null || true
  fi
  exit "${1:-0}"
}
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop $?' EXIT

echo "==> Perses ${NAMESPACE}/${SERVICE} on $(oc whoami --show-server) at ${ADDRESS}"
while true; do
  oc port-forward -n "${NAMESPACE}" "service/${SERVICE}" --address "${HOST}" "${PORT}:${REMOTE}" &
  child=$!
  wait "${child}" || true
  child=
  port_taken && fail "${ADDRESS} was taken by another process; stopping"
  echo "forward-perses: the port-forward ended (a dropped connection or a new pod); retrying" >&2
  sleep 2
done
