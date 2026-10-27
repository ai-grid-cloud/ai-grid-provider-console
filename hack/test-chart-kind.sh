#!/usr/bin/env bash
# Installs the Helm chart into a throwaway kind cluster and checks that the console works, without
# OpenShift or a hub. kind gets the Route and ManagedCluster CRDs, a self-signed certificate in place
# of the service CA's and placeholder secrets. Then:
#   1. manifests/base is applied, then the chart's `helm template` output over it, as Argo CD did
#      when ai-grid-env-setup moved to the chart: the Deployment's selector can't change, so this
#      must apply in place. Then manifests/base again, taken over by a Helm release the way
#      hack/deploy.sh does it (hack/chart-takeover.sh);
#   2. helm install: the pod is ready, the proxy refuses a caller without a token, accepts a
#      ServiceAccount token (TokenReview) and drops the identity headers a caller forges, the BFF answers isProviderAdmin from the cluster's access
#      review and lists ManagedClusters through the backend; only the proxy listens off loopback;
#   3. helm upgrade with backend.clusterWrites: the backend may label ManagedClusters ai-grid/*, and
#      the admission policy refuses its other changes;
#   4. helm uninstall removes the cluster-scoped objects.
# Not covered: OpenShift's OAuth login in a browser, the service CA and the Route's router.
#
#   hack/test-chart-kind.sh             # creates kind cluster ai-grid-chart and deletes it after
#   KEEP_CLUSTER=1 hack/test-chart-kind.sh
#
# Needs docker, kind, kubectl, helm and openssl. The backend and proxy images are linux/amd64 only;
# on an arm64 machine they run emulated. kubectl's current context is restored after kind creates
# the cluster.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHART="${ROOT}/charts/ai-grid-provider-console"
CLUSTER="${KIND_CLUSTER:-ai-grid-chart}"
CTX="kind-${CLUSTER}"
NS=ai-grid
NAME=ai-grid-provider-console
SA="system:serviceaccount:${NS}:${NAME}"
PORT="${LOCAL_PORT:-18443}"
BACKEND_IMAGE="${BACKEND_IMAGE:-ghcr.io/ai-grid-cloud/ai-grid-provider-backend:latest}"
PROXY_IMAGE="${PROXY_IMAGE:-quay.io/opendatahub/odh-kube-auth-proxy:latest}"
ROUTE_CRD=https://raw.githubusercontent.com/openshift/api/a9b3f04dd8db4c20aacca607afeff8ddbc25d863/route/v1/zz_generated.crd-manifests/routes.crd.yaml
CLUSTER_CRD=https://raw.githubusercontent.com/open-cluster-management-io/api/7b34437afbd76433695b6eb2d17735cd1de25df9/cluster/v1/0000_00_clusters.open-cluster-management.io_managedclusters.crd.yaml

k() { kubectl --context "${CTX}" "$@"; }
step() { echo "==> $*"; }
pass() { echo "    ok: $*"; }
fail() { echo "test-chart-kind: FAIL: $*" >&2; exit 1; }
# retry <command...>: three tries, 10s then 20s apart, for the steps that reach a registry or
# GitHub, which answer 503 now and then (registry.access.redhat.com has failed whole CI runs).
retry() {
  local try
  for try in 1 2 3; do
    "$@" && return 0
    [[ ${try} == 3 ]] && break
    echo "    try ${try} of 3 failed, again in $((try * 10))s: $*" >&2
    sleep $((try * 10))
  done
  return 1
}

TMP="$(mktemp -d)"
created=
pf=
cleanup() {
  [[ -n "${pf}" ]] && kill "${pf}" 2>/dev/null || true
  rm -rf "${TMP}"
  if [[ -n "${created}" && -z "${KEEP_CLUSTER:-}" ]]; then
    kind delete cluster --name "${CLUSTER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# kind pulls its node image from a registry too. A failed try can leave a half-made cluster
# behind: delete it before the next one.
kind_create() {
  kind create cluster --name "${CLUSTER}" --wait 180s && return 0
  kind delete cluster --name "${CLUSTER}" >/dev/null 2>&1 || true
  return 1
}
if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  step "creating kind cluster ${CLUSTER}"
  prev="$(kubectl config current-context 2>/dev/null || true)"
  retry kind_create
  created=1
  # kind switches kubectl's current context; put it back, so oc and make start keep their hub.
  [[ -n "${prev}" ]] && kubectl config use-context "${prev}" >/dev/null
fi

step "CRDs: Route (openshift/api), ManagedCluster (open-cluster-management-io/api)"
retry k apply -f "${ROUTE_CRD}" -f "${CLUSTER_CRD}" >/dev/null
k wait --for=condition=Established --timeout=60s \
  crd/routes.route.openshift.io crd/managedclusters.cluster.open-cluster-management.io >/dev/null

step "images: the console from this checkout, ${BACKEND_IMAGE}, ${PROXY_IMAGE}"
retry docker build -q -t localhost/ai-grid-provider-console:kind --build-arg CONSOLE_VERSION=kind "${ROOT}" >/dev/null
retry docker pull -q --platform linux/amd64 "${BACKEND_IMAGE}" >/dev/null
retry docker pull -q --platform linux/amd64 "${PROXY_IMAGE}" >/dev/null
docker tag "${BACKEND_IMAGE}" localhost/ai-grid-backend:kind
docker tag "${PROXY_IMAGE}" localhost/kube-auth-proxy:kind
kind load docker-image --name "${CLUSTER}" localhost/ai-grid-provider-console:kind \
  localhost/ai-grid-backend:kind localhost/kube-auth-proxy:kind >/dev/null
IMAGES=(--set images.console.repository=localhost/ai-grid-provider-console --set images.console.tag=kind
  --set images.backend.repository=localhost/ai-grid-backend --set images.backend.tag=kind
  --set images.authProxy.repository=localhost/kube-auth-proxy --set images.authProxy.tag=kind)
# No service CA on kind: the test makes the certificate.
# The backend doesn't start without a Git URL (git mode, ai-grid-provider-backend#29). It clones in
# the background, so an unreachable one is enough: the console serves, and Models and
# Subscriptions answer 503 until the clone succeeds. .invalid never resolves, so the run needs no
# network or repository.
GIT_URL=https://git.invalid/catalog.git
VALUES=(--set tls.serviceCA=false --set backend.git.url="${GIT_URL}" "${IMAGES[@]}")

step "namespace ${NS} and the secrets the chart expects to exist"
k create namespace "${NS}" --dry-run=client -o yaml | k apply -f - >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=${NAME}.${NS}.svc" \
  -addext "subjectAltName=DNS:${NAME}.${NS}.svc,DNS:localhost" \
  -keyout "${TMP}/tls.key" -out "${TMP}/tls.crt" 2>/dev/null
k -n "${NS}" create secret tls "${NAME}-tls" --cert="${TMP}/tls.crt" --key="${TMP}/tls.key" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k -n "${NS}" create secret generic "${NAME}-oauth" --dry-run=client -o yaml \
  --from-literal=OAUTH2_PROXY_CLIENT_ID="${NAME}" \
  --from-literal=OAUTH2_PROXY_CLIENT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$(openssl rand -hex 16)" \
  --from-literal=OAUTH2_PROXY_REDIRECT_URL=https://console.example.com/oauth2/callback | k apply -f - >/dev/null
k -n "${NS}" create secret generic ai-grid-backend-keycloak --dry-run=client -o yaml \
  --from-literal=url=http://keycloak.invalid --from-literal=realm=ai-grid --from-literal=admin-realm=ai-grid \
  --from-literal=username=placeholder --from-literal=password=placeholder | k apply -f - >/dev/null
k -n "${NS}" create secret generic ai-grid-backend-git --dry-run=client -o yaml \
  --from-literal=token=placeholder | k apply -f - >/dev/null

rollout() {
  k -n "${NS}" rollout status "deploy/${NAME}" --timeout=300s >/dev/null || {
    k -n "${NS}" get pods >&2
    k -n "${NS}" describe pods >&2
    fail "the console pod did not become ready"
  }
}
forward() {
  [[ -n "${pf}" ]] && kill "${pf}" 2>/dev/null || true
  # exec, so $! is kubectl itself: killing only a subshell would leave the old port-forward
  # holding the port, and the next one would fail to bind while curl reached the old one.
  (exec kubectl --context "${CTX}" -n "${NS}" port-forward "svc/${NAME}" "${PORT}:8443" >/dev/null 2>&1) &
  pf=$!
  for _ in $(seq 1 30); do
    curl -sk -o /dev/null "https://127.0.0.1:${PORT}/readyz" && return
    sleep 1
  done
  fail "no answer on the port-forward"
}
call() { curl -sk -o "${TMP}/body" -w '%{http_code}' "$@"; }
expect() { # expect <status> <description> curl-args...
  local want=$1 what=$2
  shift 2
  local got
  got="$(call "$@")"
  [[ "${got}" == "${want}" ]] || fail "${what}: got ${got}, want ${want}: $(head -c 300 "${TMP}/body")"
  pass "${what} (${got})"
}

base_install() {
  kubectl kustomize "${ROOT}/manifests/base" 2>/dev/null |
    sed -e "s#ghcr.io/ai-grid-cloud/ai-grid-provider-console:latest#localhost/ai-grid-provider-console:kind#" \
      -e "s#ghcr.io/ai-grid-cloud/ai-grid-provider-backend:latest#localhost/ai-grid-backend:kind#" \
      -e "s#quay.io/opendatahub/odh-kube-auth-proxy:latest#localhost/kube-auth-proxy:kind#" |
    k apply -f - >/dev/null
  # manifests/base has the chart's defaults, which set no Git URL (see VALUES).
  k -n "${NS}" set env "deploy/${NAME}" -c ai-grid-backend AI_GRID_GIT_URL="${GIT_URL}" >/dev/null
  rollout
  pass "manifests/base is ready"
}

step "1. manifests/base, then the chart over it: as Argo CD applies it, and as a Helm release"
base_install
helm template console "${CHART}" -n "${NS}" "${VALUES[@]}" >"${TMP}/chart.yaml"
k apply -f "${TMP}/chart.yaml" >/dev/null || fail "the chart does not apply over manifests/base"
rollout
forward
expect 200 "readyz after moving to the chart" "https://127.0.0.1:${PORT}/readyz"
k delete -f "${TMP}/chart.yaml" --wait >/dev/null
base_install
KUBECTL=kubectl KUBE_CONTEXT="${CTX}" "${ROOT}/hack/chart-takeover.sh" console "${NS}" "${VALUES[@]}" \
  --set route.host=console.apps.example.com >/dev/null
helm --kube-context "${CTX}" upgrade --install console "${CHART}" -n "${NS}" "${VALUES[@]}" \
  --set route.host=console.apps.example.com --wait --timeout 300s >/dev/null || fail "helm does not take over manifests/base"
rollout
[[ "$(k -n "${NS}" get route "${NAME}" -o jsonpath='{.spec.host}')" == console.apps.example.com ]] ||
  fail "the taken-over Route lacks the chart's host"
[[ -n "$(k -n "${NS}" get deployment "${NAME}" -o jsonpath='{.metadata.labels.helm\.sh/chart}')" ]] ||
  fail "the taken-over Deployment lacks the chart's labels"
pass "a Helm release takes over manifests/base in place"
helm --kube-context "${CTX}" uninstall console -n "${NS}" --wait >/dev/null

step "2. helm install"
helm --kube-context "${CTX}" install console "${CHART}" -n "${NS}" "${VALUES[@]}" --wait --timeout 300s >/dev/null
rollout
forward
u="https://127.0.0.1:${PORT}"
expect 200 "readyz without a login, and the backend answers its ping" "${u}/readyz"
grep -q '"backend":"ok"' "${TMP}/body" || fail "readyz: backend not ok: $(cat "${TMP}/body")"
expect 302 "the API without a login goes to sign-in" "${u}/api/v1/user"
expect 302 "a token the cluster rejects goes to sign-in" -H "Authorization: Bearer not-a-token" "${u}/api/v1/user"
k -n default create serviceaccount tester --dry-run=client -o yaml | k apply -f - >/dev/null
TOKEN="$(k -n default create token tester)"
auth=(-H "Authorization: Bearer ${TOKEN}")
expect 200 "a ServiceAccount token signs in" "${auth[@]}" "${u}/api/v1/user"
grep -q '"isProviderAdmin":false' "${TMP}/body" || fail "isProviderAdmin should be false: $(cat "${TMP}/body")"
# The BFF trusts the proxy's identity headers, so the proxy must drop the ones a caller sends.
# A forged access token that got through would reach the hub's access review and fail it.
expect 200 "identity headers a caller sends are dropped" "${auth[@]}" \
  -H "X-Forwarded-User: forged-admin" -H "X-Forwarded-Email: forged@example.com" \
  -H "X-Forwarded-Groups: forged-group" -H "X-Forwarded-Preferred-Username: forged-admin" \
  -H "X-Forwarded-Access-Token: forged-token" "${u}/api/v1/user"
! grep -q forged "${TMP}/body" || fail "a forged identity header reached the BFF: $(cat "${TMP}/body")"
expect 403 "a non-admin may not list clusters" "${auth[@]}" "${u}/api/v1/clusters"
k create clusterrole tester-managedclusters --verb=patch \
  --resource=managedclusters.cluster.open-cluster-management.io --dry-run=client -o yaml | k apply -f - >/dev/null
k create clusterrolebinding tester-managedclusters --clusterrole=tester-managedclusters \
  --serviceaccount=default:tester --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f - >/dev/null <<'YAML'
apiVersion: cluster.open-cluster-management.io/v1
kind: ManagedCluster
metadata: { name: site-a, labels: { location: us-east } }
spec: { hubAcceptsClient: true }
YAML
expect 200 "with patch on ManagedClusters the caller is a provider admin" "${auth[@]}" "${u}/api/v1/user"
grep -q '"isProviderAdmin":true' "${TMP}/body" || fail "isProviderAdmin should be true: $(cat "${TMP}/body")"
expect 200 "the backend lists ManagedClusters with its ServiceAccount" "${auth[@]}" "${u}/api/v1/clusters"
grep -q '"name":"site-a"' "${TMP}/body" || fail "site-a missing: $(cat "${TMP}/body")"
expect 503 "Models wait for the Git clone, which can't reach git.invalid" "${auth[@]}" "${u}/api/v1/models"
expect 200 "the frontend is served" "${auth[@]}" "${u}/"

# Only the proxy may listen off loopback: the BFF trusts identity headers, and the backend's gRPC
# port and REST gateway have no authentication of their own.
pod="$(k -n "${NS}" get pods -l app.kubernetes.io/name="${NAME}" -o jsonpath='{.items[0].metadata.name}')"
cat >"${TMP}/debug.json" <<'JSON'
{"securityContext": {"runAsNonRoot": true, "runAsUser": 65534, "allowPrivilegeEscalation": false,
  "capabilities": {"drop": ["ALL"]}, "seccompProfile": {"type": "RuntimeDefault"}}}
JSON
k -n "${NS}" debug "${pod}" -c listeners --image=busybox:1.36 --custom="${TMP}/debug.json" -- netstat -ltn >/dev/null
for _ in $(seq 1 60); do
  state="$(k -n "${NS}" get pod "${pod}" -o jsonpath='{.status.ephemeralContainerStatuses[?(@.name=="listeners")].state.terminated.reason}')"
  [[ -n "${state}" ]] && break
  sleep 2
done
listeners="$(k -n "${NS}" logs "${pod}" -c listeners | awk '/LISTEN/ {print $4}' | sort)"
while read -r addr; do echo "    listening: ${addr}"; done <<<"${listeners}"
for addr in 127.0.0.1:8080 127.0.0.1:9090 127.0.0.1:8081; do
  grep -qx "${addr}" <<<"${listeners}" || fail "${addr} is not listening"
done
open="$(grep -v -e '^127\.0\.0\.1:' -e '^::1:' <<<"${listeners}" || true)"
[[ "$(sed -E 's/.*:([0-9]+)$/\1/' <<<"${open}" | sort -u)" == 8443 ]] || fail "only :8443 may listen off loopback, got: ${open}"
pass "only the proxy's :8443 listens off loopback"

step "3. helm upgrade with backend.clusterWrites"
helm --kube-context "${CTX}" upgrade console "${CHART}" -n "${NS}" "${VALUES[@]}" \
  --set backend.clusterWrites=true --wait --timeout 300s >/dev/null
for _ in $(seq 1 30); do # the policy takes a moment to load
  k label managedcluster site-a policy-probe=1 --as="${SA}" --dry-run=server >/dev/null 2>&1 || break
  sleep 2
done
k label managedcluster site-a ai-grid/enabled=true --as="${SA}" >/dev/null || fail "the backend may not set ai-grid/enabled"
pass "the backend may set ai-grid/enabled"
k label managedcluster site-a location=eu-west --overwrite --as="${SA}" >/dev/null || fail "the backend may not set location"
pass "the backend may change location"
refused() { # refused <description> <message> kubectl-args...
  local what=$1 msg=$2
  shift 2
  if out="$(k "$@" --as="${SA}" 2>&1)"; then fail "${what} was allowed"; fi
  grep -q "${msg}" <<<"${out}" || fail "${what}: unexpected error: ${out}"
  pass "${what} is refused"
}
refused "another label" "may change only ai-grid/\* and location labels" label managedcluster site-a team=a
refused "a spec change" "may not change a ManagedCluster's spec" \
  patch managedcluster site-a --type=merge -p '{"spec":{"hubAcceptsClient":false}}'
refused "another annotation" "may change only ai-grid/\* annotations" annotate managedcluster site-a note=x
k label managedcluster site-a team=a >/dev/null || fail "the policy must not apply to other users"
pass "other users are not limited"

step "4. helm uninstall"
helm --kube-context "${CTX}" uninstall console -n "${NS}" --wait >/dev/null
left="$(k get clusterrole,clusterrolebinding,validatingadmissionpolicy,validatingadmissionpolicybinding \
  -l app.kubernetes.io/name="${NAME}" -o name)"
[[ -z "${left}" ]] || fail "uninstall left: ${left}"
pass "no cluster-scoped objects remain"

echo "test-chart-kind: all checks passed"
