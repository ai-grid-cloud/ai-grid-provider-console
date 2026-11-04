#!/usr/bin/env bash
# Checks the Helm chart (charts/ai-grid-provider-console):
#   - helm lint --strict, with the default values and with every option turned on;
#   - values.schema.json refuses a misspelled value instead of letting Helm drop it;
#   - the Deployment's strategy is Recreate (one backend at a time);
#   - with its default values, it renders the same objects as manifests/base, apart from the
#     Namespace (Helm installs into one: --create-namespace) and Helm's own labels. The chart is the
#     install path; manifests/base is kept for hack/undeploy.sh's fallback and the takeover test
#     (hack/test-chart-kind.sh), which only mean something while the two render the same.
# Needs helm, kubectl (kustomize) and yq (mikefarah).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHART="${ROOT}/charts/ai-grid-provider-console"
ALL=(--set backend.clusterWrites=true --set backend.git.url=https://github.com/example/catalog.git
  --set backend.git.gridNamespace=grid --set backend.git.modelsNamespace=ai-grid-internal-models --set route.host=console.apps.example.com --set tls.serviceCA=false
  --set images.console.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000
  --set 'imagePullSecrets[0].name=pull' --set imagePullPolicy=Always
  --set console.perses.url=https://perses.openshift-cluster-observability-operator.svc:8080
  --set console.perses.project=ai-grid)

helm lint --strict "${CHART}" >/dev/null
helm lint --strict "${CHART}" "${ALL[@]}" >/dev/null
helm template console "${CHART}" -n ai-grid "${ALL[@]}" >/dev/null
# refused <what> helm-template-args...: values.schema.json refuses them. Only the schema's error
# counts, so a template that fails for another reason doesn't pass for a refusal.
refused() {
  local what=$1 out
  shift
  if out="$(helm template console "${CHART}" -n ai-grid "$@" 2>&1 >/dev/null)"; then
    echo "check-chart: ${what} renders; values.schema.json must refuse it" >&2
    exit 1
  fi
  grep -q "values don't meet the specifications of the schema" <<<"${out}" || {
    echo "check-chart: ${what} fails, but not on values.schema.json: ${out}" >&2
    exit 1
  }
}
refused "a misspelled value (backend.clusterwrites)" --set backend.clusterwrites=true
# backend.git.url is https:// without credentials: the backend refuses anything else at start.
for url in http://github.com/example/catalog.git https://user:token@github.com/example/catalog.git \
  'https://?q=/catalog.git' https://:443/catalog.git https://github.com; do
  refused "backend.git.url=${url}" --set-string "backend.git.url=${url}"
done
for key in gridNamespace modelsNamespace; do
  refused "backend.git.${key}=Not_A_Namespace" --set-string backend.git.url=https://github.com/example/catalog.git \
    --set-string "backend.git.${key}=Not_A_Namespace"
done
# backend.git.modelsNamespace sets AI_GRID_MODELS_NAMESPACE; empty leaves the backend's default.
models_ns() {
  helm template console "${CHART}" -n ai-grid --set-string backend.git.url=https://github.com/example/catalog.git "$@" |
    yq 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "ai-grid-backend")
      | .env[] | select(.name == "AI_GRID_MODELS_NAMESPACE") | .value'
}
got="$(models_ns --set-string backend.git.modelsNamespace=ai-grid-internal-models)"
[[ "${got}" == ai-grid-internal-models ]] || {
  echo "check-chart: backend.git.modelsNamespace=ai-grid-internal-models sets AI_GRID_MODELS_NAMESPACE to '${got}'" >&2
  exit 1
}
got="$(models_ns)"
[[ -z "${got}" ]] || { echo "check-chart: without backend.git.modelsNamespace, AI_GRID_MODELS_NAMESPACE is '${got}'" >&2; exit 1; }
for url in https://github.com/example/catalog.git https://git.example.com:8443/team/repo@archive.git; do
  helm template console "${CHART}" -n ai-grid --set-string "backend.git.url=${url}" >/dev/null || {
    echo "check-chart: backend.git.url=${url} doesn't render; values.schema.json must accept it" >&2
    exit 1
  }
done
# The BFF reads the log level case-insensitively (slog.Level), so the schema takes both spellings.
helm template console "${CHART}" -n ai-grid --set console.logLevel=INFO >/dev/null
refused "console.logLevel=verbose" --set console.logLevel=verbose

# console.models.hardware: the schema refuses what the BFF would refuse at start
# (bff/internal/config/hardware.go), and a list is rendered as MODEL_HARDWARE, JSON.
hw='"id":"gpu","label":"GPU","accelerator":"nvidia.com/gpu"'
# Unicode spaces, which the BFF trims and refuses in an image (unicode.IsSpace) as the schema does.
nbsp=$'\u00a0' em_space=$'\u2003'
# An accelerator is a Kubernetes extended resource name: labels and the name at most 63 characters,
# the prefix at most 244 (so that requests.<prefix> is a DNS subdomain).
label63="$(printf 'a%.0s' {1..63})"
long_name="${label63}a" long_label="${label63}a"
long_prefix="${label63}.${label63}.${label63}.$(printf 'b%.0s' {1..52})"
for ok in "${long_prefix}/gpu" "nvidia.com/${label63}" amd.com/gpu habana.ai/gaudi nvidia.com/mig-1g.10gb; do
  helm template console "${CHART}" -n ai-grid \
    --set-json "console.models.hardware=[{\"id\":\"gpu\",\"label\":\"GPU\",\"accelerator\":\"${ok}\"}]" >/dev/null || {
    echo "check-chart: accelerator ${ok} doesn't render; values.schema.json must accept it" >&2
    exit 1
  }
done
for bad in \
  '[{"id":"cpu","label":"CPU","nodeSelector":{"kubernetes.io/arch":"amd64"}}]' \
  '[{"id":"gpu","label":"GPU","acelerator":"nvidia.com/gpu"}]' \
  '[{"id":"cpu","label":"CPU","defaults":{"memroy":"8Gi"}}]' \
  '[{"label":"CPU"}]' '[{"id":"cpu"}]' '[{"id":"CPU","label":"CPU"}]' '[{"id":"cpu-","label":"CPU"}]' \
  '[{"id":"gpu","label":"GPU","accelerator":"gpu"}]' \
  '[{"id":"gpu","label":"GPU","accelerator":"nvidia..com/gpu"}]' \
  '[{"id":"gpu","label":"GPU","accelerator":"Nvidia.com/gpu"}]' \
  '[{"id":"gpu","label":"GPU","accelerator":"nvidia.com/gpu/x"}]' \
  "[{\"id\":\"gpu\",\"label\":\"GPU\",\"accelerator\":\"nvidia.com/${long_name}\"}]" \
  "[{\"id\":\"gpu\",\"label\":\"GPU\",\"accelerator\":\"${long_label}.com/gpu\"}]" \
  "[{\"id\":\"gpu\",\"label\":\"GPU\",\"accelerator\":\"${long_prefix}b/gpu\"}]" \
  '[{"id":"gpu","label":"GPU","accelerator":"kubernetes.io/gpu"}]' \
  '[{"id":"gpu","label":"GPU","accelerator":"gpu.kubernetes.io/x"}]' \
  '[{"id":"gpu","label":"GPU","accelerator":"examplekubernetes.io/gpu"}]' \
  "[{\"id\":\"cpu\",\"label\":\"${nbsp}\"}]" "[{\"id\":\"cpu\",\"label\":\"${em_space}\"}]" \
  "[{\"id\":\"cpu\",\"label\":\"CPU\",\"image\":\"quay.io/vllm${nbsp}cpu:1\"}]" \
  '[{"id":"gpu","label":"GPU","accelerator":"requests.nvidia.com/gpu"}]' \
  '[{"id":"cpu","label":"CPU","image":"quay.io/vllm cpu:1"}]' \
  '[{"id":"cpu","label":"CPU","env":{"1THREADS":"4"}}]' \
  '[{"id":"cpu","label":"CPU","env":{"VLLM_ADDITIONAL_ARGS":"--x"}}]' \
  '[{"id":"cpu","label":"CPU","env":{"OMP_NUM_THREADS":4}}]' \
  '[{"id":"cpu","label":"CPU","defaults":{"accelerators":1}}]' \
  '[{"id":"cpu","label":"CPU","accelerator":"","defaults":{"accelerators":1}}]' \
  "[{${hw},\"defaults\":{\"accelerators\":0}}]" "[{${hw},\"defaults\":{\"accelerators\":65}}]" \
  "[{${hw},\"defaults\":{\"accelerators\":1.5}}]" \
  '[{"id":"cpu","label":"CPU","defaults":{"cpu":"2 cores"}}]' '[{"id":"cpu","label":"CPU","defaults":{"cpu":"0"}}]' \
  '[{"id":"cpu","label":"CPU","defaults":{"memory":"16G"}}]' '[{"id":"cpu","label":"CPU","defaults":{"memory":16}}]'; do
  refused "console.models.hardware=${bad}" --set-json "console.models.hardware=${bad}"
done
# A schema can't refuse a duplicate id; the template does.
if out="$(helm template console "${CHART}" -n ai-grid \
  --set-json 'console.models.hardware=[{"id":"cpu","label":"CPU"},{"id":"cpu","label":"CPU again"}]' 2>&1 >/dev/null)" ||
  ! grep -q 'console.models.hardware: id "cpu" is used by more than one entry' <<<"${out}"; then
  echo "check-chart: a duplicate console.models.hardware id must fail the render: ${out}" >&2
  exit 1
fi
model_hardware() {
  helm template console "${CHART}" -n ai-grid "$@" |
    yq 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "bff")
      | .env[] | select(.name == "MODEL_HARDWARE") | .value'
}
# The chart's default list is the BFF's own (config.DefaultModelHardware, which a local run without
# MODEL_HARDWARE uses), as the BFF's golden GET /api/v1/config records it.
got="$(model_hardware)"
golden="$(yq -p=json -o=json -I=0 '.body.data.models.hardware | sort_keys(..)' "${ROOT}/mock/examples/get-config.json")"
[[ -n "${got}" && "$(yq -p=json -o=json -I=0 'sort_keys(..)' <<<"${got}")" == "${golden}" ]] || {
  echo "check-chart: the default console.models.hardware differs from the BFF's built-in list (mock/examples/get-config.json):" >&2
  diff <(yq -p=json -P 'sort_keys(..)' <<<"${got:-null}") <(yq -p=json -P '.' <<<"${golden}") >&2 || true
  exit 1
}
# A values file that empties console.models renders, without MODEL_HARDWARE.
got="$(model_hardware --set console.models=null)"
[[ -z "${got}" ]] || { echo "check-chart: console.models=null sets MODEL_HARDWARE to '${got}'" >&2; exit 1; }
# An empty list renders no MODEL_HARDWARE: the BFF's own copy of the defaults applies.
got="$(model_hardware --set-json 'console.models.hardware=[]')"
[[ -z "${got}" ]] || { echo "check-chart: console.models.hardware=[] sets MODEL_HARDWARE to '${got}'" >&2; exit 1; }
list='[{"id":"amd-gpu","label":"AMD GPU","description":"For clusters with AMD GPUs.","accelerator":"amd.com/gpu",
  "image":"quay.io/example/vllm-rocm:1","env":{"VLLM_USE_TRITON_FLASH_ATTN":"0"},"defaults":{"accelerators":2,"cpu":"500m","memory":"32Gi"}},
  {"id":"cpu","label":"CPU only","accelerator":""}]'
got="$(model_hardware --set-json "console.models.hardware=${list}")"
[[ "$(yq -p=json -o=json -I=0 'sort_keys(..)' <<<"${got}")" == "$(yq -p=json -o=json -I=0 'sort_keys(..)' <<<"${list}")" ]] || {
  echo "check-chart: console.models.hardware renders MODEL_HARDWARE as '${got}'" >&2
  exit 1
}

# console.perses.extraDashboards renders PERSES_EXTRA_DASHBOARDS, only with console.perses.url.
perses_extra() {
  helm template console "${CHART}" -n ai-grid "$@" |
    yq 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "bff")
      | .env[] | select(.name == "PERSES_EXTRA_DASHBOARDS") | .value'
}
PERSES=(--set console.perses.url=https://perses.example.svc:8080 --set console.perses.project=ai-grid)
ACM='[{"project":"open-cluster-management-observability","dashboards":[{"name":"acm-clusters-overview","title":"Clusters overview"},{"name":"acm-alerts-by-cluster"}],"datasources":["rbac-query-proxy-datasource"]}]'
# Opt-in: the default list is empty, so no PERSES_EXTRA_DASHBOARDS.
got="$(perses_extra "${PERSES[@]}")"
[[ -z "${got}" ]] || { echo "check-chart: the default console.perses.extraDashboards sets PERSES_EXTRA_DASHBOARDS to '${got}'" >&2; exit 1; }
got="$(perses_extra "${PERSES[@]}" --set-json "console.perses.extraDashboards=${ACM}")"
[[ "$(yq -p=json -o=json -I=0 'sort_keys(..)' <<<"${got:-null}")" == "$(yq -p=json -o=json -I=0 'sort_keys(..)' <<<"${ACM}")" ]] || {
  echo "check-chart: console.perses.extraDashboards renders PERSES_EXTRA_DASHBOARDS as '${got}'" >&2
  exit 1
}
got="$(perses_extra --set-json "console.perses.extraDashboards=${ACM}")"
[[ -z "${got}" ]] || { echo "check-chart: without console.perses.url, PERSES_EXTRA_DASHBOARDS is '${got}'" >&2; exit 1; }
for bad in '[{"project":"..","dashboards":[{"name":"d"}],"datasources":["s"]}]' \
  '[{"project":"p","dashboards":[{"name":"a/b"}],"datasources":["s"]}]' \
  '[{"project":"p","dashboards":[{"name":"d","title":" x"}],"datasources":["s"]}]' \
  '[{"project":"p","dashboards":[],"datasources":["s"]}]' \
  '[{"project":"p","dashboards":[{"name":"d"}]}]' \
  '[{"project":"p","dashboards":[{"name":"d"}],"datasources":["s"],"all":true}]'; do
  refused "console.perses.extraDashboards=${bad}" "${PERSES[@]}" --set-json "console.perses.extraDashboards=${bad}"
done
# Titles the BFF refuses at start: a control character inside, a no-break space at either end.
for title in 'a\tb' '\u00a0x' 'x\u00a0'; do
  refused "console.perses.extraDashboards title \"${title}\"" "${PERSES[@]}" \
    --set-json "console.perses.extraDashboards=[{\"project\":\"p\",\"dashboards\":[{\"name\":\"d\",\"title\":\"${title}\"}],\"datasources\":[\"s\"]}]"
done
# The main project again would stop the BFF from starting: the template refuses it.
if out="$(helm template console "${CHART}" -n ai-grid --set console.perses.url=https://perses.example.svc:8080 \
  --set console.perses.project=open-cluster-management-observability --set-json "console.perses.extraDashboards=${ACM}" 2>&1 >/dev/null)"; then
  echo "check-chart: console.perses.extraDashboards naming console.perses.project renders" >&2
  exit 1
fi
grep -q "is console.perses.project" <<<"${out}" || { echo "check-chart: the main project in extraDashboards fails, but not on its check: ${out}" >&2; exit 1; }

# One line per object, keys sorted, Helm's labels dropped, in a stable order.
canonical() {
  yq -o=json -I=0 'select(. != null and .kind != "Namespace")
    | del(.metadata.labels."app.kubernetes.io/instance", .metadata.labels."app.kubernetes.io/managed-by",
          .metadata.labels."app.kubernetes.io/version", .metadata.labels."helm.sh/chart")
    | sort_keys(..)' | sort
}
# One backend at a time: its per-organization write locks live in its process (Recreate, not RollingUpdate).
strategy="$(helm template console "${CHART}" -n ai-grid | yq 'select(.kind == "Deployment") | .spec.strategy.type')"
[[ "${strategy}" == Recreate ]] || { echo "check-chart: the Deployment's strategy is '${strategy}', not Recreate" >&2; exit 1; }
chart="$(helm template console "${CHART}" -n ai-grid | canonical)"
base="$(kubectl kustomize "${ROOT}/manifests/base" | canonical)"
if [[ "${chart}" != "${base}" ]]; then
  echo "check-chart: the chart's defaults and manifests/base differ (< chart, > base):" >&2
  diff <(yq -p=json -P '.' <<<"${chart}") <(yq -p=json -P '.' <<<"${base}") >&2 || true
  exit 1
fi
echo "check-chart: lint passes; the chart's defaults render manifests/base"
