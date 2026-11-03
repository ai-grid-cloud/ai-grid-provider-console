# ai-grid-provider-console chart

The AI Grid provider console for one ACM hub: one pod with kube-auth-proxy, the console (BFF and
frontend) and `ai-grid-provider-backend`. `hack/deploy.sh` (`make deploy`) installs it with the
OAuthClient and Secrets it expects; `docs/dev-setup.md`, "Deploy to a cluster", has the details.
`values.yaml` documents every value and `values.schema.json` refuses any it doesn't list.

## Images

Each image is `repository:tag`, `repository@digest`, or `repository:tag@digest` when both are set.

- **Backend** (`images.backend`): the build of the backend commit in `.backend-api-version`,
  `ghcr.io/ai-grid-cloud/ai-grid-provider-backend:sha-<commit>` with its digest. That is the commit
  the console's API is generated from, and a console ships with the backend it was built against:
  a newer backend can refuse what an older console sends. `make backend-pin SHA=<commit>` sets it,
  with `manifests/base` and `hack/test-chart-kind.sh`, and `make check-generated-api` fails CI when
  one of them names another build. Override it only to run a backend you built yourself.
- **Console** (`images.console`): `latest` by default. A chart in this repository can't name the
  build of its own commit, which is published only after the commit merges. Set `images.console.tag`
  to `sha-<commit>` (or a digest) when you install; `make deploy` requires `TAG`. Once the chart is
  published, the plan is to stamp the console's tag and digest at release time, as OSAC's
  `osac-installer` does in `.github/workflows/publish-charts.yaml` ("Update image tags in
  values.yaml", before `helm package`).
- **Proxy** (`images.authProxy`): `quay.io/opendatahub/odh-kube-auth-proxy:latest`; the kind test
  pins a digest.

## Accelerator configurations

`servingOptions` is the list of accelerator configurations the Deploy model wizard offers and the
backend checks a model's `spec.base_refs` against (`Models/ListServingOptions`). Each is an OpenShift AI
accelerator preset (an `LLMInferenceServiceConfig`). It's one list for every cluster. The backend
reads two ConfigMaps in the release's namespace on every call, so a change applies without a restart:

- **Defaults:** `<fullname>-serving-options`, which the chart renders from `servingOptions`: the vLLM
  CPU, NVIDIA single-node and AMD ROCm presets OpenShift AI 3.6 installs. `values.yaml` cites the
  sources. Helm or Argo CD manages this ConfigMap, so don't edit it on the cluster: an upgrade or sync
  puts it back.
- **Custom:** `<fullname>-serving-options-custom` (or `servingOptions.customConfigMap`), which you
  own. The chart never creates or changes it.

The backend's ServiceAccount can `get` those two ConfigMaps only.

### Add your own entries

Write the custom ConfigMap in the same format as the defaults, under the key
`serving-options.yaml`. Use full preset names, release prefix included. A custom entry replaces the
default with the same name, and any other entry is added:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ai-grid-provider-console-serving-options-custom
  namespace: ai-grid
data:
  serving-options.yaml: |
    baseRefs:
      # Offer Intel Gaudi, which the defaults leave out.
      - name: v3-6-0-kserve-config-llm-template-intel-gaudi
        displayName: vLLM Intel Gaudi
        description: vLLM with Intel Gaudi accelerators.
        accelerators: [habana.ai/gaudi]
```

`accelerators` lists the node resources the preset needs (its
`opendatahub.io/recommended-accelerators`): the wizard asks for a count of the first one, and an
empty list runs on CPUs. If the backend can't read or parse the custom ConfigMap, it logs why and
offers the defaults alone. Delete the ConfigMap to go back to the defaults.

### Limits

- OpenShift AI installs on each cluster only the presets its nodes can run. A model that names a GPU
  preset fails on a cluster without that accelerator, and its status says so.
- Preset names carry the OpenShift AI release (`v3-6-0-...`). After an OpenShift AI upgrade, list the
  presets on the clusters (`oc get llminferenceserviceconfigs -n redhat-ods-applications -l
  opendatahub.io/config-type=accelerator`) and set `servingOptions.openshiftAIRelease` to the new
  release. A preset the upgrade didn't change keeps its older name: give that entry its own
  `release`. Models keep the preset they were made with. Custom entries aren't renamed: update them.
- Each preset sets the runtime image on each cluster; a model's own Runtime image, when one is
  entered, replaces it.
- The vLLM CPU preset reserves 4 GiB of memory for the KV cache (`VLLM_CPU_KVCACHE_SPACE=4`), so a
  CPU model needs about 8 GiB, where the wizard's Memory field starts. With less, vLLM stops at start.
