# Spike: model serving, MaaS, Kuadrant and Praxis grid resources for the console

Read-only research against the AI Grid dev hub (`oc get`/`oc explain`/CRD YAML), the
upstream repositories (fetched with `gh api`), the Praxis docs folder in the scratchpad, and
the POC repository cloned to `scratchpad/poc`. All example values below are fictional.
Nothing in the repo was modified.

Source shorthand used in citations:

- `CRD:<name>` = `oc get crd <name> -o yaml` (openAPIV3Schema, `additionalPrinterColumns`, `x-kubernetes-validations`).
- `explain:<res>.<path>` = `oc explain`.
- `hub:` = anonymised shape of a live instance on the dev hub.
- `kserve:<file>` = `opendatahub-io/kserve` `pkg/apis/serving/v1alpha2/<file>` or `pkg/controller/v1alpha2/llmisvc/<file>` (the fork RHOAI ships; upstream `kserve/kserve` has the same v1alpha2 package).
- `maas:<file>` = `opendatahub-io/models-as-a-service` `maas-controller/api/maas/v1alpha1/<file>` or `docs/content/<path>`.
- `praxis:<file>` = `praxis-proxy/grid` `docs/<path>`; `odh-mc:` = `opendatahub-io/odh-model-controller docs/grid-inference-providers.md`.
- `poc:<file>` = `krisv/ai-grid-cloud-provider-poc`.

## Summary

1. The hub runs RHOAI 3.6 with KServe v0.21 (`LLMInferenceService` v1alpha2 is the storage version, `InferenceService` v1beta1), the ODH `AIGateway` component (`modelsAsAService: Managed`, `batchGateway: Removed`, `aiGrid: Removed` by default) and Kuadrant v1 policies. One `LLMInferenceService` exists (a small CPU model in an internal models namespace), zero `InferenceService`s.
2. MaaS is live with exactly one tenant: `Config/default` -> `AITenant` (in the controller infra namespace `ai-tenants`) -> tenant namespace `models-as-a-service` holding `MaasTenantConfig/default-tenant`, one `MaaSModelRef`, one `MaaSSubscription` (phase `Active`), one `MaaSAuthPolicy` (phase `Active`) and one `ExternalModel`. The legacy `Tenant` CRD has no instances.
3. Entitlement is a dual check: `MaaSAuthPolicy` (access, `subjects`) AND `MaaSSubscription` (quota, `owner` + `modelRefs[].tokenRateLimits`). Both reference `MaaSModelRef` by `{name, namespace}`. The controller materialises one Kuadrant `TokenRateLimitPolicy` per model (`maas-trlp-<modelref>`) targeting the model's HTTPRoute, and reports it back in `status.tokenRateLimitStatuses`.
4. `MaaSSubscription.spec.tokenMetadata {organizationId, costCenter, labels}` exists exactly as the POC expects; `MaaSAuthPolicy.spec.meteringMetadata` is the same shape. Phases for subscription/policy are `Pending|Active|Degraded|Failed|Invalid`; model ref phases are `Pending|Ready|Unhealthy|Failed|Invalid`.
5. On the hub the model behind MaaS is NOT the local `LLMInferenceService`; it is an `ExternalModel` (`inference.opendatahub.io/v1alpha1`) pointing at an `ExternalProvider` whose endpoint is the Praxis grid gateway service. That is how "grid" models surface in MaaS today. `MaaSModelRef.spec.modelRef.kind` is `LLMInferenceService | ExternalModel`.
6. Kuadrant `AuthPolicy`/`RateLimitPolicy`/`TokenRateLimitPolicy`/`PlanPolicy` all attach through `spec.targetRef {group: gateway.networking.k8s.io, kind: Gateway|HTTPRoute(|GRPCRoute), name, sectionName?}` and expose `Accepted` and `Enforced` conditions with reasons `Accepted`/`Enforced` (plus `Unknown` + an "overridden" message when a policy is shadowed). The devportal `APIKey`/`APIKeyRequest`/`APIKeyApproval`/`APIProduct` CRDs are installed but unused; MaaS API keys (`sk-oai-*`) live in `maas-api` + PostgreSQL via `POST /maas-api/v1/api-keys`.
7. Praxis grid CRDs (`grid.praxis.fast/v1alpha1`: `GridNetwork`, `GridSite`, `InferenceProvider`, `SiteInvite`, `AgentToolProvider`) are NOT installed on the hub (`oc get crd | grep praxis` empty; `AIGateway.status` condition `AIGridReady=False/Removed`, "CRDs are kept"). Their documented schemas and phase machines are in section 5. The scratchpad `praxis-ai-docs/` folder only documents the Praxis AI proxy metering filters, not the grid CRDs.
8. The POC does not store the catalog in ConfigMaps. It stores CR-shaped JSON files in a Git working tree (`models/<ns>/<name>.json` is a `MaaSModelRef`, `deployments/...` an `LLMInferenceService`, plus `Placement` and `ManifestWorkReplicaSet`). "Catalog in ConfigMaps" is the console plan's own choice (`docs/plan/bff-api.md` line 105); nothing on the hub or in the POC defines a ConfigMap catalog schema yet.
9. The POC's REST shapes (`/api/models`, `/api/subscriptions`, `/api/tenants`, `/api/clusters`, `/api/grid/overview`, `/api/locations`) mostly flatten the real CRs; its inventions are `revision`/`If-Match`, `status: Saved|Registered`, `phase: Saved`, `locations[]`, `hasDeployment`, `availableForSubscriptions`, the `osac.portal/v1alpha1 Tenant`, and all grid metrics.
10. Section 7 proposes proto messages that mirror the CRDs (not the POC inventions) and lists what the fake backend must simulate (Pending -> Ready transitions, `Unhealthy`/`Degraded` paths, delete with finalizer-style `Terminating`, uniqueness, `InvalidArgument` for CRD validation rules).

## 1. Hub inventory (anonymised)

| API group | Kinds present (CRD) | Instances on hub |
|---|---|---|
| `serving.kserve.io` | `llminferenceservices` (v1alpha1 served, v1alpha2 storage), `llminferenceserviceconfigs` (v1alpha2), `inferenceservices` (v1beta1), `servingruntimes`, `clusterservingruntimes`, `inferencegraphs`, `trainedmodels`, `clusterstoragecontainers` | 1 `LLMInferenceService` in a `*-internal-models` namespace; 0 `InferenceService`; ~45 `LLMInferenceServiceConfig` presets in the RHOAI applications namespace named `v3-6-0-kserve-config-llm-*` (template, template-cpu, decode/prefill templates, scheduler, router-route, tokenizer, tracing, worker-data-parallel, accelerator variants); ~27 `ClusterServingRuntime` named `csr-kserve-vllm-<accel>[-fast-N]`, `csr-kserve-ovms`, `csr-kserve-mlserver*` |
| `maas.opendatahub.io/v1alpha1` | `configs` (cluster, alias `maasconfig`), `aitenants` (alias `ait`), `tenants`, `maastenantconfigs`, `maassubscriptions`, `maasmodelrefs`, `maasauthpolicies`, `externalmodels` (legacy) | 1 `Config/default`; 1 `AITenant` (ns `ai-tenants`); 0 `Tenant`; 1 `MaasTenantConfig/default-tenant`; 1 `MaaSModelRef` (phase `Ready`); 1 `MaaSSubscription` (phase `Active`, priority 0); 1 `MaaSAuthPolicy` (phase `Active`); all in ns `models-as-a-service` |
| `inference.opendatahub.io/v1alpha1` | `externalmodels`, `externalproviders` | 1 `ExternalModel` (phase `Ready`), 1 `ExternalProvider` (phase `Ready`) in `models-as-a-service` |
| `kuadrant.io` | `authpolicies` v1, `ratelimitpolicies` v1, `tokenratelimitpolicies` v1alpha1, `dnspolicies`, `tlspolicies`, `kuadrants` v1beta1 | 5 `AuthPolicy` (2 on Gateways, 3 on HTTPRoutes), 0 `RateLimitPolicy`, 5 `TokenRateLimitPolicy` (1 MaaS-generated on the model HTTPRoute, 1 gateway-wide default-deny owned by `Config/default`, 3 for UI routes), 1 `Kuadrant` |
| `extensions.kuadrant.io/v1alpha1` | `planpolicies`, `telemetrypolicies`, `oidcpolicies` | none |
| `devportal.kuadrant.io/v1alpha1` | `apikeys` (alias `apik`), `apikeyrequests`, `apikeyapprovals`, `apiproducts` | none |
| `gateway.networking.k8s.io/v1` | `gateways`, `httproutes`, `grpcroutes`, `gatewayclasses`, `referencegrants`, `backendtlspolicies` | 3 Gateways in `openshift-ingress`: `data-science-gateway` (class `data-science-gateway-class`), `maas-default-gateway` (class `maas-gateway-class`), `openshift-ai-inference` (class `openshift-ai-inference`); 9 HTTPRoutes |
| `components.platform.opendatahub.io/v1alpha1` | `aigateways`, `kserves`, `dashboards`, ... | `AIGateway/default-aigateway` (Ready, version 1.26.7), `Kserve/default-kserve` |
| `datasciencecluster.opendatahub.io/v3` | `datascienceclusters` | `default-dsc` |
| `grid.praxis.fast` | none | none (`oc get crd \| grep -i praxis` empty) |

## 2. Model serving

### 2.1 LLMInferenceService (`serving.kserve.io/v1alpha2`, alias `llmisvc`)

Printer columns (`CRD:llminferenceservices.serving.kserve.io`): `URL=.status.url`, `Ready=.status.conditions[?(@.type=='Ready')].status`, `Reason=.status.conditions[?(@.type=='Ready')].reason`, `Age`, wide `URLs=.status.addresses[*].url`.

Spec essentials (`explain:llminferenceservice.spec`, `kserve:llm_inference_service_types.go`). The CRD carries no descriptions (`oc explain` prints `<no description>`), so meanings come from the Go types.

| Path | Type | Default / validation | Who sets | Meaning |
|---|---|---|---|---|
| `spec.model.uri` | string (URL) | required; schemes seen/documented: `hf://`, `s3://`, `pvc://`, `oci://` | user | Model artifact location; storage-initializer downloads it |
| `spec.model.name` | string | defaults to `metadata.name` (`kserve:llm_inference_service_defaults.go`) | user | Value clients send in the request `model` field |
| `spec.model.lora`, `spec.model.confidential` | object | optional | user | LoRA adapters; confidential (TEE) serving |
| `spec.replicas` | int32 | CEL: `replicas` and `scaling` mutually exclusive | user | Static replica count |
| `spec.scaling.minReplicas` / `maxReplicas` / `keda` / `wva` | int32 / objects | `minReplicas` default 1; `maxReplicas` required inside `scaling`; `wva` is `Forbidden` by the webhook ("WVA autoscaling is no longer supported") | user | Autoscaling |
| `spec.baseRefs[].name` | string | default `""` | user | `LLMInferenceServiceConfig` presets merged under the spec; recorded in `status.appliedConfigs` |
| `spec.runtime` | string | optional | user | `ServingRuntime`/`ClusterServingRuntime` name contributing the container (`AppliedConfigSource=ServingRuntime`) |
| `spec.router.route` | object | `{}` = controller-managed HTTPRoute; `.http.refs[]` (BYO routes) or `.http.spec` (inline HTTPRouteSpec); `.group` (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, 1-63) + `.weight` (0..1000000) for weighted routing groups | user | Gateway API route |
| `spec.router.gateway.refs[]` | `{name, namespace, sectionName?}` | `{}` = default Gateway | user | BYO Gateway(s). On the hub the instance refs `openshift-ai-inference` in `openshift-ingress` |
| `spec.router.ingress` | object | mutually exclusive with route/gateway | user | Ingress instead of Gateway API |
| `spec.router.scheduler` | `{pool, replicas, config{inline|ref}, template, tokenizer, labels, annotations}` | `{}` enables the EPP scheduler + `InferencePool`; `replicas` must be > 0; `config` needs exactly one of `inline`/`ref` | user | llm-d inference scheduler |
| `spec.template.containers[]` | PodSpec | container named `main` carries `image`, `resources`, `env` | user | Main workload pod template |
| `spec.prefill`, `spec.worker`, `spec.parallelism{tensor,pipeline,data,dataLocal,dataRPCPort,expert}` | objects | webhook: worker requires data or pipeline parallelism; pipeline and data exclusive; `data`/`dataLocal` set together; total parallelism immutable | user | P/D disaggregation, multi-node |
| `spec.rolloutStrategy{maxSurge,maxUnavailable}`, `spec.tracing`, `spec.storageInitializer`, `spec.kvCacheOffloading` | objects | optional | user | Rollout, OTEL tracing, init, KV offload |

Status (`kserve:llm_inference_service_types.go` `LLMInferenceServiceStatus`, `RouterStatus`, `WorkloadStatus`, `SourcedAddress`):

| Path | Meaning |
|---|---|
| `status.url` | Primary address: external if any, else first discovered (may be cluster-local) |
| `status.addresses[]` | `{name, url, audience?, CACerts?, origin{group,kind,name,namespace}, models[]{name}}`. On the hub the names are `gateway-external`, `gateway-external-model-routing`, `gateway-internal`, `gateway-internal-model-routing`; each Gateway yields a root URL (model-routing by header) and path URLs `/<ns>/<name>` and `/publishers/<ns>/models/<model.name>`; `models[]` lists the identifiers that address accepts (`publishers/<ns>/models/<model>` and the bare model name) |
| `status.address` | deprecated, never populated |
| `status.router.gateways[]` | `{group,kind,name,namespace, listeners[], httpRoutes[]{group,kind,name,namespace}}` observed attachments |
| `status.router.scheduler{inferencePool, service}` | observed `InferencePool` (`inference.networking.k8s.io`) and EPP Service |
| `status.router.group{name, members[]{name,weight,stopped,backendRef}}` | routing group topology |
| `status.workloads.primary|prefill|scheduler{apiGroup,kind,name,readyReplicas}`, `status.workloads.service` | observed Deployment/LeaderWorkerSet and Service |
| `status.appliedConfigs[]` | `{name, namespace?, source: Preset|UserRef|ServingRuntime}` in merge precedence order |
| `status.annotations` | `serving.kserve.io/config-llm-*` -> resolved preset names, `serving.kserve.io/accelerator-type` |
| `status.observedGeneration` | |
| `status.conditions[]` | Knative-style `{type, status, reason?, message?, severity?, lastTransitionTime}` |

Condition types and reasons (`kserve:llm_inference_service_lifecycle.go`; reasons from `config_merge.go`, `workload.go`, `router.go`):

| Type | Rolls up into | True when | False reasons (exact strings) |
|---|---|---|---|
| `Ready` | top | `PresetsCombined`, `WorkloadsReady`, `RouterReady` all True (Knative `LivingConditionSet`) | inherits the first failing dependent's reason/message |
| `PresetsCombined` | Ready | all `baseRefs` found, merged, validated | `ConfigNotFound`, `LoRAMountPathCollision`, `KVTransferSlotConflict`, `CombineBaseError`, `InvalidRenderedConfig`, `Stopped`; `Unknown` with `ValidationUnavailable` |
| `WorkloadsReady` | Ready | present sub-conditions True | copies the failing sub-condition's reason |
| `MainWorkloadReady` (single-node) / `WorkerWorkloadReady` (multi-node) | WorkloadsReady | Deployment/LWS at desired replicas and passing readiness | `Stopped`, `ComputeWorkloadRevisionError`, `ReconcileCertsError`, `ReconcileWorkloadPermissionsError`, `ReconcileDisaggregatedSetError`, `ReconcileMultiNodeWorkloadError`, `ReconcileSingleNodeWorkloadError`, `ReconcileWorkloadServiceError`, `ScalingCRDNotFound`, `ReconcileScalingError` |
| `PrefillWorkloadReady`, `PrefillWorkerWorkloadReady`, `ScalingReady`, `PrefillScalingReady` | WorkloadsReady | only present when configured; `ScalingReady` with reason `WVAUnsupported` is a non-blocking warning | |
| `RouterReady` | Ready | present router sub-conditions True | copies the failing sub-condition |
| `GatewaysReady` | RouterReady | all referenced Gateways exist and are Programmed | `GatewaysNotReady` ("The following Gateways are not ready: ..."), `Stopped` |
| `HTTPRoutesReady` | RouterReady | managed/BYO routes accepted by parents | `HTTPRouteNotObserved`, `HTTPRoutesNotReady`, `WaitingForGateway`, `GatewayPreconditionNotMet`, `RoutingPreconditionNotMet`, `InvalidHTTPRoute`, `HTTPRouteReconcileError`, `PlatformNetworkingReconcileError`, `Stopped` |
| `InferencePoolReady` | RouterReady | pool exists and ready | `InferencePoolNotReady`, `InferencePoolFetchError`, `WaitingForGateway`, `Stopped` |
| `SchedulerWorkloadReady`, `TokenizerReady` | RouterReady | EPP / tokenizer Deployments ready | `SchedulerReconcileError` |
| `GroupReady`, `GroupDegraded`, `PerModelPathsDropped`, `DisaggregatedSetUsed` | independent (do not block Ready) | | `ModelNameMismatch`, `ModelNameAmbiguous`, `BackendResolutionFailed`; `SetOnService`/`SetOnAllGateways`; `FeatureGateDisabled`, `CRDNotInstalled`, `NoPrefillWorkload`, `AutoscalingNotSupported`, `ReplicasMismatch` |

Hub instance shape (`hub:`): one `LLMInferenceService` in an internal-models namespace, created by Argo CD (annotations `argocd.argoproj.io/sync-wave`, `argocd.argoproj.io/tracking-id`), `baseRefs: [v3-6-0-kserve-config-llm-template-cpu]`, `model.uri: hf://<publisher>/<model>`, `model.name: <publisher>/<model>`, `replicas: 1`, `router: {gateway: {refs: [{name: openshift-ai-inference, namespace: openshift-ingress}]}, route: {}, scheduler: {}}`, a `main` container with CPU/memory requests and a `VLLM_CPU_KVCACHE_SPACE` env. Status: 9 conditions all `True` (`GatewaysReady`, `HTTPRoutesReady`, `InferencePoolReady`, `MainWorkloadReady`, `PresetsCombined`, `Ready`, `RouterReady`, `SchedulerWorkloadReady`, `WorkloadsReady`), six `addresses` (3 external via the Gateway load balancer, 3 internal via `<gateway>-<gateway>.openshift-ingress.svc.cluster.local`), `appliedConfigs` with three `Preset`s and one `UserRef`. The controller also creates an HTTPRoute `<name>-kserve-route` (labels `app.kubernetes.io/part-of: llminferenceservice`, `app.kubernetes.io/component: llminferenceservice-router`, annotation `serving.kserve.io/inference-pool-migrated: v1`) with one rule per OpenAI path (`/v1/completions`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, ...) matching `/<ns>/<name>/v1/...`, rewriting to `/v1/...`, backend `InferencePool <name>-inference-pool` port 8000, and `timeouts.request: 0s`.

Healthy example (fictional):

```yaml
apiVersion: serving.kserve.io/v1alpha2
kind: LLMInferenceService
metadata:
  name: tiny-llm
  namespace: provider-models
spec:
  baseRefs: [{name: v3-6-0-kserve-config-llm-template-cpu}]
  model: {uri: hf://example-org/tiny-llm, name: example-org/tiny-llm}
  replicas: 1
  router:
    gateway: {refs: [{name: openshift-ai-inference, namespace: openshift-ingress}]}
    route: {}
    scheduler: {}
  template:
    containers:
      - name: main
        resources: {requests: {cpu: 100m, memory: 8Gi}, limits: {cpu: "1", memory: 10Gi}}
status:
  observedGeneration: 1
  url: https://gw.example.test/provider-models/tiny-llm
  addresses:
    - name: gateway-external
      url: https://gw.example.test/provider-models/tiny-llm
      origin: {group: gateway.networking.k8s.io, kind: Gateway, name: openshift-ai-inference, namespace: openshift-ingress}
      models: [{name: publishers/provider-models/models/example-org/tiny-llm}, {name: example-org/tiny-llm}]
    - name: gateway-internal
      url: https://openshift-ai-inference-openshift-ai-inference.openshift-ingress.svc.cluster.local/provider-models/tiny-llm
      origin: {group: gateway.networking.k8s.io, kind: Gateway, name: openshift-ai-inference, namespace: openshift-ingress}
      models: [{name: publishers/provider-models/models/example-org/tiny-llm}, {name: example-org/tiny-llm}]
  appliedConfigs:
    - {name: v3-6-0-kserve-config-llm-scheduler, namespace: redhat-ods-applications, source: Preset}
    - {name: v3-6-0-kserve-config-llm-router-route, namespace: redhat-ods-applications, source: Preset}
    - {name: v3-6-0-kserve-config-llm-template, namespace: redhat-ods-applications, source: Preset}
    - {name: v3-6-0-kserve-config-llm-template-cpu, namespace: redhat-ods-applications, source: UserRef}
  router:
    gateways:
      - {group: gateway.networking.k8s.io, kind: Gateway, name: openshift-ai-inference, namespace: openshift-ingress,
         httpRoutes: [{group: gateway.networking.k8s.io, kind: HTTPRoute, name: tiny-llm-kserve-route, namespace: provider-models}]}
    scheduler:
      inferencePool: {group: inference.networking.k8s.io, kind: InferencePool, name: tiny-llm-inference-pool}
  workloads:
    primary: {apiGroup: apps, kind: Deployment, name: tiny-llm-kserve, readyReplicas: 1}
    scheduler: {apiGroup: apps, kind: Deployment, name: tiny-llm-kserve-scheduler, readyReplicas: 1}
  conditions:
    - {type: PresetsCombined, status: "True", lastTransitionTime: "2026-10-01T10:00:00Z"}
    - {type: MainWorkloadReady, status: "True", severity: Info, lastTransitionTime: "2026-10-01T10:03:00Z"}
    - {type: WorkloadsReady, status: "True", lastTransitionTime: "2026-10-01T10:03:00Z"}
    - {type: GatewaysReady, status: "True", severity: Info, lastTransitionTime: "2026-10-01T10:00:00Z"}
    - {type: HTTPRoutesReady, status: "True", severity: Info, lastTransitionTime: "2026-10-01T10:01:00Z"}
    - {type: InferencePoolReady, status: "True", severity: Info, lastTransitionTime: "2026-10-01T10:01:00Z"}
    - {type: SchedulerWorkloadReady, status: "True", severity: Info, lastTransitionTime: "2026-10-01T10:02:00Z"}
    - {type: RouterReady, status: "True", lastTransitionTime: "2026-10-01T10:02:00Z"}
    - {type: Ready, status: "True", lastTransitionTime: "2026-10-01T10:03:00Z"}
```

Failing examples (fictional, reasons are real strings):

```yaml
# a) bad preset reference: controller stops before creating anything
status:
  conditions:
    - {type: PresetsCombined, status: "False", reason: ConfigNotFound,
       message: 'llminferenceserviceconfig "v3-6-0-kserve-config-llm-template-tpu" not found'}
    - {type: Ready, status: "False", reason: ConfigNotFound,
       message: 'llminferenceserviceconfig "v3-6-0-kserve-config-llm-template-tpu" not found'}
# b) pods never become ready (OOM / image pull / model download) - WorkloadsReady stays False, Ready False
status:
  conditions:
    - {type: PresetsCombined, status: "True"}
    - {type: MainWorkloadReady, status: "False", reason: ReconcileSingleNodeWorkloadError,
       message: 'deployment "tiny-llm-kserve" is not ready: 0/1 replicas available'}
    - {type: WorkloadsReady, status: "False", reason: ReconcileSingleNodeWorkloadError, message: '...'}
    - {type: RouterReady, status: "True"}
    - {type: Ready, status: "False", reason: ReconcileSingleNodeWorkloadError, message: '...'}
# c) gateway not programmed
    - {type: GatewaysReady, status: "False", reason: GatewaysNotReady,
       message: 'The following Gateways are not ready: [openshift-ingress/openshift-ai-inference]'}
    - {type: HTTPRoutesReady, status: "False", reason: WaitingForGateway, message: '...'}
    - {type: RouterReady, status: "False", reason: GatewaysNotReady}
    - {type: Ready, status: "False", reason: GatewaysNotReady}
```

While the workload is starting, conditions that have not been evaluated are simply absent or `Unknown`; `Ready` is `Unknown` until all three dependents are set (Knative semantics). There is no `phase` field on LLMISvc; the UI's "Pending/Ready/Failed" has to be derived (`Ready=True` -> Ready; `Ready=False` -> Failed/NotReady with reason; otherwise Pending).

### 2.2 InferenceService (`serving.kserve.io/v1beta1`, alias `isvc`) - no instances on the hub

Spec: `spec.predictor` required; `spec.predictor.model{modelFormat{name,version}, runtime, storageUri, storage, resources, args, env, ...}` (`explain:inferenceservice.spec.predictor.model`). Status (`explain:inferenceservice.status`): `url`, `address`, `components{predictor{url, restUrl, grpcUrl, latestReadyRevision, latestCreatedRevision, latestRolledoutRevision, previousRolledoutRevision, traffic[]}}`, `deploymentMode`, `servingRuntimeName`, `clusterServingRuntimeName`, `conditions`, `modelStatus`.

`status.modelStatus` (`CRD:inferenceservices.serving.kserve.io`, `kserve/kserve pkg/apis/serving/v1beta1/inference_service_status.go`):

| Path | Enum / default |
|---|---|
| `transitionStatus` (required) | `""`, `UpToDate` (default), `InProgress`, `BlockedByFailedLoad`, `InvalidSpec` |
| `states.activeModelState` (required) | `""`, `Pending` (default), `Standby`, `Loading`, `Loaded`, `FailedToLoad` |
| `states.targetModelState` | same enum, default `""` |
| `lastFailureInfo.reason` | `ModelLoadFailed`, `RuntimeUnhealthy`, `RuntimeDisabled`, `NoSupportingRuntime`, `RuntimeNotRecognized`, `InvalidPredictorSpec`; plus `message`, `location`, `exitCode`, `modelRevisionName`, `time` |
| `copies.failedCopies` (required, default 0), `copies.totalCopies` | |

Condition types: `PredictorReady`, `PredictorRouteReady`, `PredictorConfigurationReady`, `TransformerReady`, `ExplainerReady`, `IngressReady`, `RoutesReady`, `LatestDeploymentReady`, `CanaryPredictorReady`, `Stopped`, `Ready`. Printer columns: `URL`, `Ready`, `Prev`, `Latest`, `PrevRolledoutRevision`, `LatestReadyRevision`, `Age`.

Recommendation: the console's Models page should be built on `LLMInferenceService` (what RHOAI 3.6 llm-d serving, the MaaS `modelRef.kind` enum, and the POC all use). Support for `InferenceService` can stay a read-only "other deployments" list if ever needed.

## 3. MaaS CRDs (`maas.opendatahub.io/v1alpha1`)

Common enums (`maas:common_types.go`):

- `Phase` (subscription, auth policy): `Pending | Active | Degraded | Failed | Invalid`.
- `ConditionReason` (used in `status.conditions[].reason` and in every per-item `ResourceRefStatus.reason`): `Reconciled, ReconcileFailed, PartialFailure, Valid, NotFound, GetFailed, Accepted, AcceptedEnforced, NotAccepted, Enforced, NotEnforced, BackendNotReady, ConditionsNotFound, InvalidSpec, Unknown, NoPairingFound, GovernancePaired, GovernanceGap, RuntimeHealthy, RuntimeHealthFailure`.
- `ResourceRefStatus {name, namespace, ready bool, reason, message(<=1024)}` is embedded by `modelRefStatuses[]`, `tokenRateLimitStatuses[]` (+`model`), `authPolicies[]` (+`model`, `modelNamespace`).
- `GuardrailAttachment {ref{name}, checks[]}` appears on AITenant, MaasTenantConfig, MaaSSubscription (and per modelRef), MaaSModelRef; the referenced `AIGuardrail` CRD (`aigateway.opendatahub.io`) is not on the hub.
- Display metadata is NOT in spec: `openshift.io/display-name` and `openshift.io/description` annotations (`maas:reference/crds/maas-subscription.md` "Annotations"). The hub subscription carries `openshift.io/display-name`; the hub auth policy carries `openshift.io/description: Auth policy created for subscription "<name>"`.

### 3.1 Config (cluster-scoped, alias `maasconfig`)

Purpose: single platform anchor, name must be `default` (CEL `self.metadata.name == 'default'`). Spec (`CRD:configs.maas.opendatahub.io`): `limitadorScrapeInterval` (default `30s`, pattern `^([0-9]+(\.[0-9]+)?(ms|s|m|h))+$`), `usageLogging` (bool, default false; deploys the OTel access-log EnvoyFilter), `usageMetricsDashboard` (bool, default false). Status: `conditions[]` with `Ready` (reason `AllOperandsReady`) and `TenantsHealthy` (reason `AllTenantsHealthy`, message "all N tenant(s) healthy"). Printer: `Ready`, `Age`. The controller sets annotation `maas.opendatahub.io/default-aitenant-bootstrapped: "true"` and owns the default `AITenant`, the `MaasTenantConfig` and the gateway-wide `TokenRateLimitPolicy` (ownerReferences on the hub).

### 3.2 AITenant (namespaced, alias `ait`)

Purpose (`maas:reference/crds/ai-tenant.md`): bootstraps a tenant: validates the Gateway, creates/labels the tenant namespace (`ai-tenant-<name>` for non-default; the default keeps `models-as-a-service`), creates `MaasTenantConfig/default-tenant` in it, creates tenant-admin Roles. Must live in the controller infra namespace (default `ai-tenants`, flag `--aitenant-namespace`); name <= 41 chars and DNS-1123 label (root CEL).

| Path | Type / default | Meaning |
|---|---|---|
| `spec.gateway.name` | string, default = AITenant name | Existing Gateway (namespace is controller config) |
| `spec.oidc.issuerUrl` (required in oidc), `spec.oidc.clientId` (required), `spec.oidc.ttl` (default 300, min 30) | | Tenant's external OIDC |
| `spec.guardrails[]` | GuardrailAttachment | Tenant baseline |
| `spec.rbac.admins[]{kind: User|Group|ServiceAccount, name, namespace}` | deprecated, ignored | |
| `status.phase` | `Pending | Active | Failed | Terminating` | |
| `status.tenantNamespace` | string | reconciled namespace |
| `status.gatewayRef{name (default maas-default-gateway), namespace (default openshift-ingress)}` | | resolved Gateway |
| `status.conditions[]` | `Ready` (reason `Reconciled`, msg "AITenant bootstrap resources are reconciled"); `Ready=False/DeletionBlocked` while cleanup fails | |

Printer: `Ready`, `Tenant Namespace=.status.tenantNamespace`, `Gateway=.status.gatewayRef.name`, `Age`. Finalizer `maas.opendatahub.io/aitenant-cleanup`. Hub: one AITenant named after the default tenant, `spec.gateway.name: maas-default-gateway`, `spec.oidc` set, `status.phase: Active`.

Tenant namespace labels set by the controller (hub, on `MaasTenantConfig`): `ai-gateway.opendatahub.io/tenant=<tenant>`, `maas.opendatahub.io/managed-by-aitenant=true`, `maas.opendatahub.io/tenant-name`, `maas.opendatahub.io/tenant-namespace`, `maas.opendatahub.io/gateway-access=true`, `app.kubernetes.io/managed-by=maas-controller`, `app.kubernetes.io/part-of=modelsasservice`.

### 3.3 MaasTenantConfig (namespaced) and legacy Tenant

`MaasTenantConfig`: name must be `default-tenant` (CEL), one per tenant namespace, created by AITenant (annotations `maas.opendatahub.io/aitenant-name`, `maas.opendatahub.io/aitenant-namespace`, `maas.opendatahub.io/payload-processing-status: steady`). Spec (`CRD:maastenantconfigs.maas.opendatahub.io`): `apiKeys{deletionRetentionDays (1..106751, doc default 90), maxExpirationDays}`, `guardrails[]`, `maasApi{replicas 1..100, resources}`, `payloadProcessing` / `payloadPreProcessing` `{replicas, resources, autoscaling{maxReplicas default 10, targetCPUUtilization default 70, targetMemoryUtilization default 80}}`, `telemetry{enabled default true, metrics{captureGroup false, captureModelUsage true, captureOrganization true, captureUser false}, logs{captureUser false}}`. Status: `phase` `Pending|Active|Degraded|Failed`, `infraNamespace` (where `maas-api` runs; hub: `redhat-ai-gateway-infra`), conditions `Ready`, `DependenciesAvailable` (`DependenciesMet`), `MaaSPrerequisitesAvailable` (`PrerequisitesMet`), `DeploymentsAvailable` (`DeploymentsReady`), `Degraded` (`NoWarnings` when False). Printer: `Ready`, `Reason`, `Age`, `InfraNamespace`. Finalizers `maas.opendatahub.io/tenant-cleanup`, `ai-gateway-controller.opendatahub.io/praxis-cleanup`.

`Tenant` (legacy, name must be `default-tenant`): same spec plus `externalOIDC{issuerUrl, clientId, ttl}` and `gatewayRef{name default maas-default-gateway, namespace default openshift-ingress}` "for legacy/unmanaged Tenant resources"; no instances on the hub. The console should ignore it.

### 3.4 MaaSModelRef (namespaced) - the catalog entry

Purpose (`maas:concepts/model-reference.md`): pointer to an inference service (on-cluster or external); the controller collects endpoint/status and wires routing on the tenant Gateway; policies and subscriptions reference it by `{name, namespace}`.

| Path | Type / validation | Who sets | Meaning |
|---|---|---|---|
| `spec.modelRef.kind` | required enum `LLMInferenceService | ExternalModel` | user | backend kind |
| `spec.modelRef.name` | required, 1..253 | user | name of the LLMISvc or ExternalModel (same namespace as the MaaSModelRef) |
| `spec.endpointOverride` | string | user | overrides discovered endpoint |
| `spec.tenantRef` | DNS label | user (advanced) | AITenant name; otherwise auto-resolved from the HTTPRoute's Gateway parentRef |
| `spec.guardrails[]` | | user | |
| `status.phase` | `Pending | Ready | Unhealthy | Failed | Invalid` | controller | Pending = awaiting governance pairing or backend readiness; Ready = governed and runtime-healthy; Unhealthy = governed but runtime failed; Failed = reconcile error; Invalid = bad spec |
| `status.endpoint` | URL | controller | discovered or override; on the hub it is the tenant Gateway's `https://<gateway-host>` |
| `status.httpRouteName/Namespace`, `status.httpRouteGatewayName/Namespace`, `status.httpRouteHostnames[]` | | controller | the model's HTTPRoute and its parent Gateway |
| `status.resolvedTenantRef` | | controller | AITenant name |
| `status.resolvedModelAlias` | | controller | identity used by body-based routing: `publishers/<ns>/models/<spec.model.name>` for LLMISvc; `externalProviderRefs[0].targetModel` for ExternalModel |
| `status.conditions[]` | `Ready` (`Reconciled`, "Governed and runtime-healthy"), `GovernanceAttached` (`GovernancePaired` / `NoPairingFound` / `GovernanceGap`), `RuntimeReady` (`RuntimeHealthy` / `RuntimeHealthFailure` / `BackendNotReady`), `ModelIdentityUnique` (`UniqueIdentity`; the hub shows this type although it is not in the Go constants) | controller | |

Printer: `Phase`, `Endpoint`, `HTTPRoute=.status.httpRouteName`, `Gateway=.status.httpRouteGatewayName`, `Age`. Finalizer `maas.opendatahub.io/model-cleanup`.

Governance rule that matters for the UI: a `MaaSModelRef` is `Pending` with `GovernanceAttached=False/NoPairingFound` until at least one `Active` `MaaSSubscription` AND one `MaaSAuthPolicy` reference it. A freshly registered model therefore shows Pending until a subscription exists. When the backend later fails it becomes `Unhealthy` (`RuntimeReady=False/RuntimeHealthFailure`), not `Failed`.

Hub instance (anonymised): `spec.modelRef {kind: ExternalModel, name: <model>}`, `status.phase: Ready`, conditions `GovernanceAttached=True/GovernancePaired` ("Active governance pairing found"), `RuntimeReady=True/RuntimeHealthy` ("Backend is healthy"), `ModelIdentityUnique=True/UniqueIdentity`, `Ready=True/Reconciled`; `httpRouteName: external-model-<model>`, `httpRouteGatewayName: maas-default-gateway`, `httpRouteGatewayNamespace: openshift-ingress`, `resolvedModelAlias: <model>`, `resolvedTenantRef: <tenant>`.

### 3.5 MaaSSubscription (namespaced) - the Subscriptions page

| Path | Type / validation | Default | Meaning |
|---|---|---|---|
| `spec.owner` (required) | `{groups[]{name}, users[]}` | | Who may select/bind the subscription (opaque identity strings, not RBAC) |
| `spec.modelRefs[]` (required, minItems 1) | `{name (1..63), namespace (1..63), tokenRateLimits[] (minItems 1), unlimited bool, billingRate{perToken string}, guardrails[]}` | | CEL per item: "tokenRateLimits is required unless unlimited is true"; "tokenRateLimits must not be set when unlimited is true" |
| `spec.modelRefs[].tokenRateLimits[]` | `{limit int64 1..1_000_000_000, window string ^[1-9]\d{0,3}(s|m|h)$ (2..5 chars)}` | | `d` (days) is rejected; use `24h` |
| `spec.priority` | int32 | 0 | selection among a user's subscriptions (higher wins) |
| `spec.inferencePriority` | int32 (full range) | unset | published as `InferenceObjective.spec.priority`; unset = no objective |
| `spec.tokenMetadata` | `{organizationId, costCenter, labels{}}` | | token attribution and metering |
| `spec.organization.id` | string (Go type; not in the installed CRD schema) | | immutable org association (newer controller) |
| `spec.guardrails[]` | | | |
| `status.phase` | `Pending | Active | Degraded | Failed | Invalid` | | Degraded keeps access (flow-control failures); Invalid = spec rejected |
| `status.conditions[]` | `Ready` (`Reconciled`, "successfully reconciled"), `SpecPriorityDuplicate` (`NoDuplicatePeers` when False), `InferenceObjectivesReady` (only when `inferencePriority` set) | | |
| `status.modelRefStatuses[]` | ResourceRefStatus; reasons `Valid`, `NotFound`, `GetFailed`, `BackendNotReady`, ... | | per referenced model |
| `status.tokenRateLimitStatuses[]` | ResourceRefStatus + `model`; reasons `Accepted`, `AcceptedEnforced`, `NotAccepted`, `Enforced`, `NotEnforced`, `ConditionsNotFound` | | one generated `TokenRateLimitPolicy` per model, named `maas-trlp-<modelref>` in the model's namespace |
| `status.flowControlStatuses[]` | `{name, namespace, inferencePool{group,kind,name}, objectiveName, ready, reason, message}`; reasons `ObjectiveReconciled, PriorityUnset, NotApplicable, Unmanaged, PoolPending, ObjectivePending, Unsupported, NotOnTenantGateway, ObjectiveConflict, InferenceObjectiveAPIUnavailable, ReconcileFailed` | | request-priority wiring |

Printer: `Phase`, `Priority=.spec.priority`, `Age`. Finalizer `maas.opendatahub.io/subscription-cleanup` (deletion waits for a Job that soft-deletes the API keys bound to this subscription; failures keep it `Terminating`, `maas:reference/crds/maas-subscription.md`). Subscription selection at the gateway accepts phase `Active` or `Degraded` and rejects anything with a `deletionTimestamp` (OPA rule `subscription-valid` in the hub's gateway AuthPolicy).

Active example (fictional values, real structure, mirrors the hub):

```yaml
apiVersion: maas.opendatahub.io/v1alpha1
kind: MaaSSubscription
metadata:
  name: team-blue-standard
  namespace: models-as-a-service
  annotations:
    openshift.io/display-name: Team Blue standard
    openshift.io/description: 1k tokens/min on the tiny model
  finalizers: [maas.opendatahub.io/subscription-cleanup]
spec:
  owner:
    groups: [{name: team-blue}]
  priority: 10
  modelRefs:
    - name: tiny-llm
      namespace: models-as-a-service
      tokenRateLimits: [{limit: 1000, window: 1m}, {limit: 100000, window: 24h}]
  tokenMetadata:
    organizationId: org-blue
    costCenter: cc-4711
    labels: {environment: production}
status:
  phase: Active
  conditions:
    - {type: Ready, status: "True", reason: Reconciled, message: successfully reconciled, observedGeneration: 1, lastTransitionTime: "2026-10-01T10:00:00Z"}
    - {type: SpecPriorityDuplicate, status: "False", reason: NoDuplicatePeers, message: "", observedGeneration: 1, lastTransitionTime: "2026-10-01T10:00:00Z"}
  modelRefStatuses:
    - {name: tiny-llm, namespace: models-as-a-service, ready: true, reason: Valid}
  tokenRateLimitStatuses:
    - {model: tiny-llm, name: maas-trlp-tiny-llm, namespace: models-as-a-service, ready: true, reason: Accepted}
```

Pending / Degraded examples:

```yaml
# model ref missing -> Pending (or Failed when all refs fail)
status:
  phase: Pending
  conditions:
    - {type: Ready, status: "False", reason: PartialFailure, message: "1 of 2 model references not ready"}
  modelRefStatuses:
    - {name: tiny-llm, namespace: models-as-a-service, ready: true, reason: Valid}
    - {name: big-llm, namespace: models-as-a-service, ready: false, reason: NotFound, message: 'maasmodelrefs.maas.opendatahub.io "big-llm" not found'}
# TRLP accepted but not yet enforced -> Degraded-ish signal on the item, phase stays Active per controller docs
  tokenRateLimitStatuses:
    - {model: tiny-llm, name: maas-trlp-tiny-llm, namespace: models-as-a-service, ready: false, reason: NotEnforced, message: TokenRateLimitPolicy has been accepted but not enforced}
```

Generated `TokenRateLimitPolicy` (hub shape): labels `app.kubernetes.io/managed-by: maas-controller`, `app.kubernetes.io/part-of: maas-subscription`, `app.kubernetes.io/component: token-rate-limit-policy`, `maas.opendatahub.io/model`, `maas.opendatahub.io/model-namespace`; annotation `maas.opendatahub.io/subscriptions: <ns>/<sub>[,...]`; `ownerReferences` -> the model HTTPRoute; `spec.targetRef {group: gateway.networking.k8s.io, kind: HTTPRoute, name: <model route>}`; `spec.limits.tokens-<limit>-per-<window>: {counters: [{expression: auth.identity.selected_subscription_id}, {expression: auth.identity.userid}], rates: [{limit, window}], when: [{predicate: 'auth.identity.selected_subscription_id == "<opaque-id>" && !request.path.endsWith("/v1/models")'}]}`; status `Accepted=True/Accepted`, `Enforced=True/Enforced`. The opaque subscription id is also what the gateway returns in header `X-MaaS-Subscription-Rate-Limit-Id`.

### 3.6 MaaSAuthPolicy (namespaced)

| Path | Type / validation | Meaning |
|---|---|---|
| `spec.modelRefs[]` (required, minItems 1) | `{name 1..63, namespace 1..63}` | models this policy grants |
| `spec.subjects` (required) | `{groups[]{name}, users[]}`; CEL "at least one group or user must be specified in subjects" | OR logic |
| `spec.meteringMetadata` | `{organizationId, costCenter, labels{}}` | billing attribution |
| `status.phase` | `Pending | Active | Degraded | Failed | Invalid` | |
| `status.conditions[]` | `Ready` (`Reconciled`), `ConflictingAuthPolicy` (`NoConflict` when False: "No conflicting AuthPolicies detected on MaaS-managed HTTPRoutes") | |
| `status.authPolicies[]` | ResourceRefStatus + `model`, `modelNamespace` (generated Kuadrant AuthPolicies; empty on the hub because access is evaluated by `maas-api`, not by per-model AuthPolicies) | |

Printer: `Phase`, `Age`, `AuthPolicies=.status.authPolicies[*].name`. Finalizer `maas.opendatahub.io/authpolicy-cleanup`. Hub: one policy whose `subjects.groups` is the broad authenticated group and whose `modelRefs` equals the subscription's; annotation `openshift.io/description: Auth policy created for subscription "<sub>"` (the same convention the POC uses).

### 3.7 ExternalModel - two different CRDs

- `externalmodels.maas.opendatahub.io/v1alpha1` (legacy): `spec.provider`, `spec.targetModel`, `spec.endpoint` (FQDN), `spec.credentialRef.name` (Secret with key `api-key`); `status.phase` `Pending|Ready|Failed|Migrated` (`Migrated` = networking now managed by the inference.opendatahub.io ExternalModel). No instances.
- `externalmodels.inference.opendatahub.io/v1alpha1` (current, owned by the AI Gateway controller): this is what the hub uses.

| Path | Type / validation | Meaning |
|---|---|---|
| `spec.externalProviderRefs[]` (required, <= 64) | `{ref{name, namespace?}, apiFormat (required, e.g. openai-chat, messages), path (required, `^/.*`, e.g. /v1/chat/completions), targetModel (required), weight (0..100, default 1), auth{type: apikey|simple|sigv4|oauth2, secretRef{name}}, config{}}` | provider bindings with weights |
| `spec.modelName` | string | client-facing model name, defaults to `metadata.name` |
| `spec.gatewayRefs[]` | `{name, namespace}` (<= 16) | explicit Praxis gateways; omitted = tenant-local resolution |
| `status.phase` | `Pending | Ready | Failed` | Failed e.g. missing ExternalProvider or Secret |
| `status.httpRouteName`, `status.observedGeneration`, `status.overlayDigest`, `status.overlayGeneration`, `status.gateways[]{name, namespace, httpRouteRef, conditions[]}` | | overlay = routing document distributed to Praxis |
| `status.conditions[]` | `Ready` and `OverlayDistributed` (reason `Reconciled`, message "distributed routing overlay digest <sha256> generation N") | |

`ExternalProvider` (`inference.opendatahub.io/v1alpha1`): `spec.provider` (e.g. `openai`), `spec.endpoint` (FQDN, no scheme), `spec.auth{type, secretRef{name}}`, `spec.config{}`; annotations seen on the hub `inference.opendatahub.io/port: "443"`, `inference.opendatahub.io/tls: "true"`; `status.phase` `Pending|Ready|Failed`, condition `Ready/Reconciled` ("provider Secret reference and transport resources are ready"). Printer: `Provider`, `Endpoint`, `Phase`, `Age`.

Hub shape: `ExternalProvider/grid-provider` with `provider: openai`, `endpoint: grid-gateway.grid-system.svc.cluster.local`, `auth.type: apikey`; `ExternalModel/<model>` with one ref `{ref{name: grid-provider}, apiFormat: openai-chat, path: /v1/chat/completions, targetModel: <publisher>/<model>, weight: 1}`. The generated HTTPRoute `external-model-<model>` (labels `app.kubernetes.io/managed-by: ai-gateway-controller`, `inference.opendatahub.io/external-model: <model>`, owner `ExternalModel`) has parent `maas-default-gateway` and four rules: path `/<tenant-ns>/<model>` or header `X-Gateway-Model-Name: <model>`, each either with header `X-AI-Routing-Candidate: <model>/provider-<provider>` -> backend Service `provider-<provider>:443` with `URLRewrite.hostname` to the grid gateway, or without that header -> Service `provider-selection-required-<model>:443` (a sentinel that forces the routing filter to pick a candidate). `timeouts.request: 300s`. Route status parents: `openshift.io/gateway-controller/v1` (`Accepted`, `ResolvedRefs`) and `kuadrant.io/policy-controller` (`kuadrant.io/AuthPolicyAffected=True/Accepted`, `kuadrant.io/TokenRateLimitPolicyAffected=True/Accepted`).

## 4. Kuadrant and API keys

### 4.1 Policy attachment and status (all four policy kinds)

`spec.targetRef {group, kind, name, sectionName?}` with CEL: group must be `gateway.networking.k8s.io`; kind `HTTPRoute|GRPCRoute|Gateway` for AuthPolicy/RateLimitPolicy/PlanPolicy, `HTTPRoute|Gateway` for TokenRateLimitPolicy (`CRD:*policies*`). `sectionName` targets one listener/rule.

Spec shape: exactly one of implicit defaults (`rules`/`limits` at top level), `defaults{rules|limits, strategy: atomic|merge}`, or `overrides{...}` (CEL messages "Implicit and explicit defaults are mutually exclusive", "At least one spec.rules must be defined", "At least one spec.limits must be defined"). Optional `when[]` predicates (CEL) and `patterns`. AuthPolicy `rules` = Authorino `{authentication{}, metadata{}, authorization{}, response{success{headers{}, filters{}}, unauthenticated, unauthorized}, callbacks{}}`. RLP/TRLP `limits{<name>{rates[]{limit, window}, counters[]{expression}, when[]{predicate}}}`. PlanPolicy `spec.plans[]{tier, predicates, limits{daily, weekly, monthly, yearly, custom[]{limit, window}}}` (from `APIProduct.status.discoveredPlans`); the identity falls into the first matching plan.

Status for all: `observedGeneration` + `conditions[]` with types `Accepted` and `Enforced`. Observed messages/reasons on the hub:

| type | status | reason | message |
|---|---|---|---|
| `Accepted` | True | `Accepted` | "AuthPolicy has been accepted" / "TokenRateLimitPolicy has been accepted" |
| `Enforced` | True | `Enforced` | "... has been successfully enforced" |
| `Enforced` | True | `Enforced` | "AuthPolicy has been partially enforced" (gateway policy with some rules overridden by route policies) |
| `Enforced` | False | `Unknown` | "TokenRateLimitPolicy has encountered some issues: policy rule(s) overridden: <rule> by tokenratelimitpolicy.kuadrant.io:<ns>/<name>" |

Kuadrant docs (https://docs.kuadrant.io/) list further `Accepted=False` reasons `Invalid`, `TargetNotFound`, `Conflicted`, `Overridden` and `Enforced=False` reasons `Unknown`, `Overridden`; not observed on the hub. The affected Gateway/HTTPRoute gets `kuadrant.io/AuthPolicyAffected`, `kuadrant.io/TokenRateLimitPolicyAffected` (and `RateLimitPolicyAffected`) conditions with reason `Accepted` on the resource and on each listener/parent status.

Printer columns (priority 2 so hidden by default): `Accepted`, `Enforced`, `TargetKind=.spec.targetRef.kind`, `TargetName`, `TargetSection`, `Age`.

Hub AuthPolicies (anonymised): the MaaS gateway policy (ns `openshift-ingress`, target Gateway `maas-default-gateway`, managed by `maas-controller`) has `defaults.rules` with three authentication schemes ordered by `priority`: `api-keys` (plain `Authorization: Bearer sk-oai-...`), `oidc-identities` (JWT with the tenant issuer), `openshift-identities` (`kubernetesTokenReview`); two `metadata` HTTP callouts to `maas-api` internals (`/internal/v1/api-keys/validate`, `/internal/v1/subscriptions/select`); authorization rules `auth-valid`, `subscription-valid` (phase Active|Degraded, no deletionTimestamp), `require-group-membership` (`accessAllowed`), `oidc-client-bound`, `oidc-groups-safe`, `deny-client-identity-headers`, `deny-api-key-management`; and `response.success.headers` injecting `X-MaaS-Username`, `X-MaaS-Group`, `X-MaaS-Subscription`, `X-MaaS-Subscription-Rate-Limit-Id`, `X-MaaS-KeyName`, `x-gateway-inference-objective`, `x-gateway-inference-fairness-id`, `x-llm-d-inference-*`. The KServe gateway policy (target `openshift-ai-inference`, managed by `odh-model-controller`) uses `kubernetes-user` auth plus `inference-access`/`model-access-path` authorization and injects `x-maas-user`, `x-maas-groups`, `x-tenant-id`, `x-user-id`.

Example AuthPolicy Accepted+Enforced (fictional):

```yaml
apiVersion: kuadrant.io/v1
kind: AuthPolicy
metadata: {name: tenant-gateway-auth, namespace: openshift-ingress}
spec:
  targetRef: {group: gateway.networking.k8s.io, kind: Gateway, name: maas-default-gateway}
  defaults:
    rules:
      authentication:
        api-keys:
          plain: {selector: request.headers.authorization}
          when: [{selector: request.headers.authorization, operator: matches, value: '^Bearer sk-oai-.*'}]
status:
  observedGeneration: 2
  conditions:
    - {type: Accepted, status: "True", reason: Accepted, message: AuthPolicy has been accepted, lastTransitionTime: "2026-10-01T10:00:00Z"}
    - {type: Enforced, status: "True", reason: Enforced, message: AuthPolicy has been successfully enforced, lastTransitionTime: "2026-10-01T10:00:05Z"}
```

### 4.2 API keys: two models, one in use

Devportal CRDs (`CRD:*.devportal.kuadrant.io`), installed, unused:

- `APIProduct` (namespaced): `spec.displayName` (required), `spec.targetRef{group,kind,name}` (required; the HTTPRoute the product represents), `spec.approvalMode` `automatic|manual` (default `manual`), `spec.publishStatus` `Draft|Published` (default `Draft`), `description`, `version`, `tags[]`, `contact{email,slack,team,url}`, `documentation{docsURL, openAPISpecURL, swaggerUI, gitRepository, techdocsRef}`. Status: `conditions` (`Ready`), `discoveredAuthScheme` (Authorino scheme found on the route), `discoveredPlans[]{tier, limits{daily,weekly,monthly,yearly,custom[]}}` (from PlanPolicy), `oidcDiscovery{tokenEndpoint}`, `openapi{raw, lastSyncTime, maxSizeUsed}`.
- `APIKey` (namespaced): `spec.apiProductRef{name, namespace?}`, `spec.planTier` (e.g. basic/premium), `spec.requestedBy{userId, email}`, `spec.secretRef{name}` (consumer-created Secret with key `api_key`), `spec.useCase`. Status: `conditions` (`Approved`), `apiHostname`, `authScheme`, `limits{daily,...,custom[]}`. Printer: `Approved`, `API`, `Plan`, `User`, `Age`.
- `APIKeyRequest`: `spec.apiKeyRef{name, namespace}`, `spec.apiProductRef{name}`, `spec.planTier`, `spec.requestedBy`, `spec.useCase` (all required); `APIKeyApproval`: `spec.apiKeyRequestRef{name}`, `spec.approved bool`, `spec.reviewedBy`, `spec.reviewedAt`, `reason`, `message`. Flow: consumer creates Secret + `APIKey` -> controller creates `APIKeyRequest` -> admin (or automatic mode) creates `APIKeyApproval` -> `APIKey.status.conditions[Approved]=True`, Secret labelled so Authorino's `apiKey.selector` matches, `PlanPolicy` tier applies.

MaaS API keys (what the hub actually uses; `maas:reference/maas-api-overview.md`, `maas:user-guide/api-key-management.md`): `POST /maas-api/v1/api-keys` with an OpenShift or OIDC token, body `{name, description?, expiresIn? ("90d","1h"), subscription? (MaaSSubscription name; default highest priority), ephemeral? (<=1h), labels{} (<=50, k8s label syntax)}` -> `{key: "sk-oai-...", keyPrefix, id (uuid), name, subscription, createdAt, expiresAt, ephemeral, labels}`; key returned once, hash stored in PostgreSQL. `POST /v1/api-keys/search` (filters `status: active|revoked|expired`, `labelsContain`, `username` admin-only; sort `created_at|expires_at|last_used_at|name`; pagination limit <= 100), `GET /v1/api-keys/{id}` -> `{id, name, description, username, subscription, tenant, creationDate, expirationDate, status, ephemeral, labels}`, `DELETE /v1/api-keys/{id}`, `POST /v1/api-keys/bulk-revoke`, `GET /v1/models` (OpenAI list filtered by access), `GET /v1/subscriptions`, `GET /v1/model/{model-id}/subscriptions`. Internal (cluster-only, called by Authorino): `POST /internal/v1/api-keys/validate`, `POST /internal/v1/subscriptions/select`. The gateway `deny-api-key-management` rule forbids using an API key to manage API keys.

Consequence for the console: the tenant->API-key relationship is `MaaSSubscription` (bound at mint time) -> key rows in `maas-api`, not a CRD. A console "keys per subscription" view needs `maas-api` (`/v1/api-keys/search`, admin), not the Kubernetes API.

## 5. Praxis grid and the AI Gateway component

### 5.1 On the hub

`AIGateway/default-aigateway` (`components.platform.opendatahub.io/v1alpha1`, owned by `DataScienceCluster/default-dsc`): `spec.modelsAsAService.managementState: Managed`, `spec.batchGateway.managementState: Removed`; `spec.aiGrid.managementState` (enum `Managed|Removed`, default `Removed`, "controls whether the AI Grid CRDs are installed; Removed stops reconciling them but does not delete them") is unset. Status: `phase: Ready`, `module{version: 1.26.7, platform, buildSource, sources[]}`, `releases[]` (AI Gateway Operator v0.1.0, Batch Gateway v0.3.0, Async Processor v0.7.4, Model as a service v0.2.0, AI Gateway Payload Processing v0.1.0, platform 3.6.0), conditions `Ready`, `ProvisioningSucceeded`, `DeploymentsAvailable`, `ModelsAsAServiceReady=True/Ready`, `TenantsHealthy=True/AllTenantsHealthy`, `BatchGatewayReady=False/Removed`, `AIGridReady=False/Removed` ("aiGrid ManagementState is Removed; CRDs are kept"). `DataScienceCluster.spec.components.aigateway` only exposes `managementState`, `batchGateway.managementState`, `modelsAsAService.managementState` (`explain:dsc.spec.components.aigateway`); `aiGrid` is not yet plumbed through the DSC on this version.

The `grid.praxis.fast` CRDs are absent, but the grid data plane is present: an `ExternalProvider` points at `grid-gateway.grid-system.svc.cluster.local` and the `MaasTenantConfig` carries the `ai-gateway-controller.opendatahub.io/praxis-cleanup` finalizer. The scratchpad `praxis-ai-docs/` folder documents only Praxis AI proxy filters (`external_metering`: balance check `GET {metering_url}/api/v1/customers/{username}/entitlements/{feature_key}/value?model=`, usage report `POST {metering_url}/api/v1/events` CloudEvents; identity headers `x-tenant-username|group|subscription|model`; `token_count`, `token_usage_headers` -> `Praxis-Token-Input|Output|Total|Status`, `stream_usage_inject`). No grid CRD content there.

### 5.2 Documented CRDs (`praxis:docs/architecture/crds.md`, API group `grid.praxis.fast/v1alpha1`, all cluster-scoped)

GridNetwork (one per cluster; operator fails with more):

| Path | Values / default | Meaning |
|---|---|---|
| `spec.gridId` | auto-generated on first join | |
| `spec.seeds[]` | `host:port` | SWIM seeds |
| `spec.gatewayRefs[]` | `{name, namespace, localSiteName?, consumerConfig{enabled false, enableProjectedCredentials, supportsProjectedCredentials, credentialMountBase, configMapName (praxis-consumer-config), tlsCertMountPath, listenerPort 8080, clusterEndpoints[]{cluster, address, transport{mode: mutual_tls|tls|plaintext, sni, caSecretRef}}, mountReconciliation{enabled, deploymentName, containerName}}, providerHopEndpoints[]}` | Praxis gateways this network programs; the overlay ConfigMap is `grid-overlay-<network>-<gateway>` key `routing-overlay.json` |
| `spec.region`, `spec.zone` | strings | |
| `spec.swim{probeInterval, suspicionTimeout, gossipNodes}`, `spec.tls{caSecretRef, siteSecretRef, swimKeyRef}` | | |
| `spec.routingPolicy` | `geographyFirst` (default) \| `scoreFirst` | |
| `spec.scoringPolicy.strategy` | `noMetrics` (default) \| `queueDepth` \| `kvCachePressure` | |
| `spec.selectionPolicy.mode` | `deterministic` \| `roundRobin` \| `random` \| `weightedRandom` | |
| `spec.placementPolicy.strategy` | `static` (required iff weightedRandom) | |
| `spec.admissionPolicy{mode: instantaneous|stabilized, missingMetrics: existingOnly|excluded, pressure{enterThreshold .85, exitThreshold .70, failureThreshold 2, successThreshold 3, minimumStateDuration 10s, recoveryHoldDown 30s}}` | | |
| `spec.budgetPolicy.tenants[]{tenantId, capUsd}` | | status signal only |
| `status.phase` | `Pending -> Initializing -> Active -> Degraded` | |
| `status.gridId`, `connectedSites`, `distributedProviderCount`, `observedGeneration` | | |
| `status.conditions[]` | `PeerTimeValid`, `GatewayAgesRejected` (map keyed by type; never change phase) | |
| `status.consumerConfigStatus[]{namespace, configMapName, phase: Rendered|Error|Disabled, reason: MissingClusterEndpoint|ConsumerConfigRenderFailed|ConsumerConfigApplyFailed, message}` | | |
| `status.mountReconciliationStatus[]{phase: Ready|...}`, `budgetStatus[]`, `gatewayAgeReports[]` | | |

GridSite (one per peer site; label `grid.praxis.fast/network: <network>`):

| Path | Values | Meaning |
|---|---|---|
| `spec.gridNetworkRef` | name | |
| `spec.egress.address` | `host:port` | remote data-plane gateway |
| `spec.egress.tls{mode: Mutual (default)|Plaintext, serverName}` | | |
| `spec.trust.canonicalFingerprints[]` (sha256 hex of DER), `certFingerprint` (deprecated) | | |
| `spec.region`, `spec.zone`, `spec.sovereigntyZone` | strings | |
| `status.phase` | `Pending -> Discovered -> Connecting -> Active -> Unreachable -> Left` | flat `phase/reason/message` model, no `conditions[]` (explicitly: tools must not depend on conditions) |
| `status.reason` | `AwaitingDiscovery` (Pending), `SWIMDiscovered`, `GatewayAddressKnown`, `GatewayAddressMissing` (Discovered), `TlsVerified` (Active), `EgressMissing`, `IdentityVerificationRequired`, `PlaintextUnreachable`, `ConnectTimeout`, `ConnectionFailed`, `HandshakeTimeout`, `TlsProtocolError`, `UntrustedIssuer`, `IdentityMismatch`, `CertificateExpired`, `CertificateNotYetValid`, `PinMismatch`, `TrustMaterialMissing`, `TrustMaterialInvalid` (Connecting/Unreachable), `AdvertisedCertMismatch` (Active) | |
| `status.message`, `observedGeneration`, `publicCertPem`, `capabilities{inference, agentTools, agentToAgent}`, `lastProbeTime`, `lastTransitionTime`, `absentSince` | | |

Only `Active` sites' providers enter the routing overlay. A single-site deployment keeps its own GridSite `Pending/AwaitingDiscovery` forever and that is normal. Metric `grid_site_phase{site,phase}`.

InferenceProvider:

| Path | Values | Meaning |
|---|---|---|
| `spec.gridNetworkRef` | name | |
| `spec.providerKind` | doc enum `open_ai | anthropic | bedrock | vertex | self_hosted`; the ODH bridge writes `vllm` | string in CRD |
| `spec.backendKind` | doc values `local | remote | cloud_managed | api_provider`; the ODH bridge writes `local_model` | string in CRD; unrecognised values are not scored normally |
| `spec.endpoint` | URL incl. base path | |
| `spec.models[]{name, capabilities[] (text_generation,...)}` | | routing source of truth |
| `spec.auth{strategy: bearer_token, manual bool, secretRef{name, namespace, key}}` | | token bytes never leave the Secret |
| `spec.accessPolicy.siteSelector.matchLabels`, `spec.siteSelector.matchLabels` | | who may route / where hosted |
| `spec.healthCheck{path, endpoint, tls}`, `spec.metricsConfig{metricsEndpoint, path /metrics, timeout 2s, poolName, queueCapacity, signalNames{}, staleMetricsSeconds, tls}`, `spec.modelDiscovery.openAiModels{endpoint, path /v1/models}`, `spec.capacityWeight 1..1000`, `spec.trafficPolicy`, `spec.cost`, `spec.gatewayRef`, `spec.routingClusterRef` | | |
| `status.phase` | `Pending -> Available -> Degraded -> Unavailable` (follows configuration only) | |
| `status.conditions[Ready]` | `True/Ready`; `False/NoEndpointsReady|ScrapeTimedOut|ScrapeUnauthorized|TLSHandshakeFailed|ScrapeFailed|MetricsStale|ProviderUnavailable`; `Unknown/NoLivenessCheck|MetricsBodyTooLarge|AwaitingFirstScrape|MetricsNotConfigured` | readiness from metrics scrapes; `Ready=False` excludes from routing |
| `status.modelDiscoveryUrl`, `status.modelDiscoveryError` | | |

Printer: `NAME`, `PROVIDER=.spec.providerKind`, `READY` (condition status), wide `REASON`, `PHASE`.

`SiteInvite` (`spec.siteName, jurisdictions[], lifetime 24h (5m..168h), allowDeletedName, publicKeySHA256`; status with token id, Secret ref, expiry, redemption) and `AgentToolProvider`/`AgentToAgentProvider` exist too but are out of scope for the Models/Grid pages.

### 5.3 How LLMInferenceServices become grid providers (`odh-mc:`)

`odh-model-controller` publishes one cluster-scoped `InferenceProvider` per (LLMInferenceService, Gateway) pair when: the model Namespace has label `grid.opendatahub.io/allowed: "true"` and the Gateway (only in `openshift-ingress`, `redhat-ods-applications`, `opendatahub` by default; `GRID_GATEWAY_NAMESPACES`) carries annotation `grid.opendatahub.io/serving: '{"networkName","namespace","serviceAccount","tokenSecret","siteLabels"?}'`. It reads KServe's `status.addresses` named `gateway-internal` / `gateway-internal-model-routing` with a matching Gateway `origin` (prefers `/publishers/<ns>/models/<model>` paths), names the provider `kmeta.ChildName("grid-<ns>-<svc>", "-<uid>-<gw-digest>")`, labels it `opendatahub.io/managed: "true"`, annotates `grid.praxis.fast/source-name|source-namespace|source-uid`, `grid.opendatahub.io/gateway-name|gateway-namespace|gateway-uid`, writes `spec.providerKind: vllm`, `spec.backendKind: local_model`, `spec.models[0].name`, `spec.siteSelector.matchLabels` from `siteLabels`, `spec.auth{strategy: bearer_token, manual: false, secretRef{<namespace>/<tokenSecret>, key: token}}`, creates a model-scoped Role/RoleBinding for the grid service account, adds finalizer `grid.praxis.fast/inference-provider` on the LLMISvc, and emits Warning events `InferenceProviderReconcileFailed`. Neither the namespace label nor the Gateway annotation is present on the hub.

## 6. Relationships (text diagram)

```
Config/default (cluster)  ──owns──> AITenant/<tenant> (ns ai-tenants)
                                        │ status.tenantNamespace = <tenant-ns>, status.gatewayRef = openshift-ingress/maas-default-gateway
                                        ├──creates──> MaasTenantConfig/default-tenant (ns <tenant-ns>)  ──> maas-api Deployment (ns <infra-ns>)
                                        └──validates──> Gateway maas-default-gateway  <──targetRef── AuthPolicy (maas-controller) + TokenRateLimitPolicy gateway-default-deny
                                                                   ▲ parentRef
Tenant identity (Keycloak org / OpenShift group)                   │
   │ owner.groups / subjects.groups                                 │
   ▼                                                                │
MaaSSubscription/<sub> (ns <tenant-ns>) ──modelRefs{name,ns}──> MaaSModelRef/<model> (ns <tenant-ns>) ──spec.modelRef{kind,name}──┬──> LLMInferenceService/<model> ──> HTTPRoute <model>-kserve-route ──parentRef──> Gateway openshift-ai-inference ──> InferencePool/Deployment
MaaSAuthPolicy/<sub>-policy (ns <tenant-ns>) ──modelRefs{name,ns}──┘   status.httpRouteName/GatewayName               └──> ExternalModel/<model> ──> HTTPRoute external-model-<model> ──parentRef──> Gateway maas-default-gateway ──> Service provider-<p> ──> ExternalProvider/<p>.endpoint (grid gateway svc)
   │ status.tokenRateLimitStatuses[]                                                                                                                                                                            │
   └──generates──> TokenRateLimitPolicy maas-trlp-<model> ──targetRef──> that HTTPRoute (owner)                                                                                                                 ▼
                                                                                                                                                                   grid.praxis.fast GridNetwork ──> GridSite(s) ──> InferenceProvider(s) (not installed on hub)
API key (sk-oai-*, maas-api/PostgreSQL) ──bound at mint──> MaaSSubscription ; gateway AuthPolicy validates key via maas-api, selects subscription, TRLP counts tokens per (subscription id, user)
```

Gating summary for the UI: a model is usable by a tenant when `MaaSModelRef.status.phase == Ready` AND an `Active|Degraded` `MaaSSubscription` owned by the tenant lists it AND a `MaaSAuthPolicy` with the tenant as subject lists it; quota comes from the subscription's `tokenRateLimits` (or `unlimited`).

## 7. The POC (`krisv/ai-grid-cloud-provider-poc`)

### 7.1 Storage conventions (`poc:docs/git-backend.md`, `backend/GitResourceStore.mjs`, `backend/resources.mjs`)

Git working tree, JSON files that are valid Kubernetes manifests, one per resource; nothing is applied to a cluster:

| Folder | Kind / apiVersion | Notes |
|---|---|---|
| `models/<ns>/<name>.json` | `MaaSModelRef` `maas.opendatahub.io/v1alpha1` | the "catalog"; seeded with three entries whose `spec.modelRef.kind: LLMInferenceService` |
| `deployments/<ns>/<name>.json` | `LLMInferenceService` `serving.kserve.io/v1alpha2` | written by the deploy wizard |
| `placements/<ns>/<name>.json` | `Placement` `cluster.open-cluster-management.io/v1beta1` | `matchLabels {ai-grid/enabled: "true", ai-grid/provisioned: "true"}` + `matchExpressions [{key: location, operator: In, values}]` |
| `manifest-work-replica-sets/<ns>/<name>.json` | `ManifestWorkReplicaSet` `work.open-cluster-management.io/v1alpha1` | `placementRefs[{name, rolloutStrategy{type: All}}]`, embeds the LLMISvc in `manifestWorkTemplate.workload.manifests` |
| `subscriptions/<ns>/<name>.json` | `MaaSSubscription` | |
| `authorization-policies/<ns>/<name>-policy.json` | `MaaSAuthPolicy` | |
| `tenants/<ns>/<name>.json` | `Tenant` `osac.portal/v1alpha1` (POC invention) | `spec {domains[], identityProvider{title, description, enabled, config{clientId, clientSecretSecret{name}, issuer, authorizationUrl, tokenUrl, defaultScopes, userInfoUrl, jwksUrl, logoutUrl, validateSignature}}}` |
| `clusters/<name>.json` | `ManagedCluster` `cluster.open-cluster-management.io/v1` | labels `location`, `ai-grid/enabled`, `ai-grid/provisioned`, `ai-grid/site`, `ai-grid/region`; annotations `ai-grid/site-name`, `ai-grid/latitude`, `ai-grid/longitude`; condition `ManagedClusterConditionAvailable` |

Annotations the POC writes: `openshift.io/display-name`, `openshift.io/description` (match the real controller docs), plus its own `maas-admin.portal/created-at`, `maas-admin.portal/updated-at`, `maas-admin.portal/subscription` (on the generated policy), `maas-admin.portal/demo-phase`, label `maas-admin.portal/model` on Placement/MWRS. Namespace is fixed server-side (`MAAS_NAMESPACE`, default `maas`) and stripped from every response; requests containing `namespace` are rejected 422. No ConfigMaps anywhere.

### 7.2 REST shapes (`poc:docs/openapi.json`, `backend/*.mjs`, `src/app/types/*.ts`)

`GET /api/models` -> `ManagedModel[]`:

```json
{
  "name": "tiny-llm", "displayName": "Tiny LLM", "description": "...",
  "modelRef": {"kind": "LLMInferenceService", "name": "tiny-llm"},
  "endpoint": "https://...",
  "phase": "Saved", "status": "Saved", "statusMessage": "Saved to Git. ...", "reason": "GitOnly",
  "conditionType": null, "lastTransitionTime": null, "creationTimestamp": "2026-...", "deletionTimestamp": null,
  "revision": "<sha256>", "hasDeployment": true, "availableForSubscriptions": true,
  "modelUri": "hf://example-org/tiny-llm", "modelName": "example-org/tiny-llm",
  "runtimeImage": "quay.io/example/vllm:latest", "replicas": 1,
  "locations": ["site1", "site2"]
}
```

`POST /api/models` body (`CreateModel`): `{name, displayName, description?, modelUri (hf|oci|s3|pvc|http|https), modelName, runtimeImage, replicas 1..99, cpu ("2"|"500m"), memory ("4Gi"), gpuCount 0..64, runtimeArgs[] (joined into env VLLM_ADDITIONAL_ARGS), locations[] (>=1, from GET /api/locations)}` -> 201 + `ETag` + `Location`. `GET /api/models/{name}` -> `ManagedModel` + `ETag`; `DELETE` needs `If-Match` (428 missing, 412 stale, 409 when referenced by a subscription/policy, 204 ok). `GET /api/locations` -> `string[]` of `location` labels from clusters that are Ready + enabled + provisioned.

`GET /api/subscriptions` -> `Subscription[]`; `GET /api/subscriptions/{name}` -> `SubscriptionInfo {subscription, modelRefs: ModelSummary[], authPolicies: AuthorizationPolicy[], meteringMetadata?}`; `POST` body `CreateSubscription {name, displayName?, description?, owner{groups[]{name}, users[]?}, modelRefs[]{name, displayName?, description?, unlimited?, tokenRateLimits[]{limit, window}, billingRate?{perToken}, guardrails?}, priority (-1e6..1e6), tokenMetadata?{organizationId, costCenter, labels}, inferencePriority?, guardrails?, createAuthPolicy: bool}` -> `{subscription, authPolicy?}`; `PUT /{name}` (`UpdateSubscription`, same minus name/createAuthPolicy, `If-Match`); `DELETE` removes the generated `<name>-policy` too. `Subscription` JSON = `spec` flattened (`owner`, `modelRefs` with joined `displayName`/`description`, `priority`, `tokenMetadata`, `inferencePriority`, `guardrails`) + `name, displayName, description, phase ("Saved"), status, statusMessage, conditionType, reason ("GitOnly"), lastTransitionTime, creationTimestamp, deletionTimestamp, revision`. Mock fixtures use phases `Ready`/`Pending`/`Degraded` and reason `ModelNotReady`.

`GET/POST /api/tenants`, `GET/PUT/DELETE /api/tenants/{name}` -> `Tenant {name, domains[], identityProvider{...}, status: "Saved", revision, creationTimestamp, updatedAt}`; duplicates/overlapping domains 409.

`GET /api/clusters` -> `GridCluster[] {name, status: Ready|Offline|Unknown, aiGridEnabled, provisioned, provisioningStatus: Provisioned|Provisioning|"Not provisioned", location?, site?, siteName?, region?, latitude?, longitude?}`; `PATCH /api/clusters/{name}` body exactly `{"aiGridEnabled": true}` (merge-patch label `ai-grid/enabled: "true"` on the hub).

`GET /api/grid/overview?range=1h|6h|24h&site=&metrics=false` -> `GridOverview {updatedAt, inventorySource: acm|git|demo, demo, metricsSource: thanos|demo, clusters: GridCluster[], metrics: GridMetric[]{key: requests|errors|latency|gpu, label, unit, status: ok|not-configured|unavailable|no-data, message?, points[]{timestamp, value}}}`. PromQL contract: `ai_gateway_requests_total{cluster=~__CLUSTERS__}`, `ai_gateway_request_duration_seconds_bucket`, `DCGM_FI_DEV_GPU_UTIL`.

Errors: `{code: validation|not_found|conflict|unavailable, message, fieldErrors?}`; HTTP 400/413/415/422 -> validation, 404, 409/412/428 -> conflict, 503.

### 7.3 Mapping POC fields to real CRDs

| POC field | Real source | Verdict |
|---|---|---|
| `ManagedModel.name/displayName/description/modelRef/endpoint` | `MaaSModelRef.metadata.name`, annotations `openshift.io/display-name|description`, `spec.modelRef`, `status.endpoint` (or `spec.endpointOverride`) | real |
| `ManagedModel.phase/reason/statusMessage/conditionType/lastTransitionTime` | `MaaSModelRef.status.phase` + the `Ready` condition's `reason/message/type/lastTransitionTime` | real; POC fakes `Saved`/`GitOnly` |
| `ManagedModel.modelUri/modelName/replicas/runtimeImage` | `LLMInferenceService.spec.model.uri/name`, `spec.replicas`, `spec.template.containers[main].image` | real |
| `ManagedModel.locations[]` | `Placement.spec.predicates[].requiredClusterSelector.labelSelector.matchExpressions[location]` | POC convention for multi-cluster placement (ACM); not a model-serving field |
| `ManagedModel.status Saved|Registered`, `hasDeployment`, `availableForSubscriptions`, `revision` | none | POC invention (Git semantics). `revision` should become `metadata.resourceVersion` or be dropped |
| `CreateModel.cpu/memory/gpuCount/runtimeArgs` | `spec.template.containers[main].resources`, env `VLLM_ADDITIONAL_ARGS` | real (ODH dashboard convention) |
| `Subscription.*` spec fields | `MaaSSubscription.spec` 1:1 (`owner`, `modelRefs[]`, `priority`, `tokenMetadata`, `inferencePriority`, `guardrails`) | real |
| `Subscription.phase/reason/...` | `status.phase`, `Ready` condition | real; POC fakes `Saved` |
| `SubscriptionInfo.authPolicies[]` | `MaaSAuthPolicy` list filtered by shared `modelRefs` | real |
| `AuthorizationPolicy.meteringMetadata` | `MaaSAuthPolicy.spec.meteringMetadata` | real |
| `createAuthPolicy` + `<name>-policy` naming + `openshift.io/description: Auth policy created for subscription "<name>"` | matches what exists on the hub | convention worth keeping |
| `Tenant {domains, identityProvider}` | no CRD; console plan says Keycloak Organizations; `AITenant.spec.oidc{issuerUrl, clientId}` is the cluster-side piece | POC invention |
| `GridCluster.*` | ACM `ManagedCluster` labels/annotations/conditions | ACM convention, already in the console's `ManagedClusters` service |
| `GridOverview.metrics` | Thanos queries; `demo` generator | POC invention; nothing on the hub produces `ai_gateway_requests_total` today (unverified) |

## 8. Proposal for the console

### 8.1 Proto services (mirror the CRDs; `.cache/ai-grid-backend/proto/ai_grid/v1/ai_grid.proto` already has `AiGrid`, `ManagedClusters`, `Tenants`)

```proto
// Shared
message Condition { string type = 1; string status = 2; /* True|False|Unknown */ string reason = 3; string message = 4;
                    google.protobuf.Timestamp last_transition_time = 5; int64 observed_generation = 6; }
message ObjectMeta { string name = 1; string namespace = 2; string display_name = 3; string description = 4;   // from openshift.io/* annotations
                     google.protobuf.Timestamp creation_timestamp = 5; google.protobuf.Timestamp deletion_timestamp = 6;
                     string resource_version = 7; int64 generation = 8; map<string,string> labels = 9; }
message ResourceRefStatus { string name = 1; string namespace = 2; bool ready = 3; string reason = 4; string message = 5; }

// Models = LLMInferenceService (+ optional MaaS registration and placement)
service Models {
  rpc ListModels(ListModelsRequest) returns (ListModelsResponse);           // namespace filter, label selector
  rpc GetModel(GetModelRequest) returns (Model);
  rpc CreateModel(CreateModelRequest) returns (Model);                      // LLMISvc (+ MaaSModelRef when register=true, + Placement/MWRS when locations set)
  rpc UpdateModel(UpdateModelRequest) returns (Model);                      // replicas, resources, image, runtime args, locations
  rpc DeleteModel(DeleteModelRequest) returns (google.protobuf.Empty);     // FailedPrecondition when referenced by a subscription/policy
  rpc WatchModels(ListModelsRequest) returns (stream ModelEvent);           // optional; for Pending->Ready polling
}
message Model {
  ObjectMeta metadata = 1;
  LLMInferenceServiceSpec spec = 2;
  LLMInferenceServiceStatus status = 3;
  MaaSModelRefSummary registration = 4;        // null when not registered in MaaS
  repeated string locations = 5;               // from Placement; empty for single-cluster
}
message LLMInferenceServiceSpec { string model_uri = 1; string model_name = 2; int32 replicas = 3; Scaling scaling = 4;
  repeated string base_refs = 5; string runtime = 6; Router router = 7; Container main = 8; }
message Router { repeated GatewayRef gateway_refs = 1; bool managed_route = 2; bool scheduler = 3; string group = 4; int32 weight = 5; }
message GatewayRef { string name = 1; string namespace = 2; string section_name = 3; }
message Container { string image = 1; map<string,string> requests = 2; map<string,string> limits = 3; repeated EnvVar env = 4; }
message Scaling { int32 min_replicas = 1; int32 max_replicas = 2; }
message LLMInferenceServiceStatus { string url = 1; repeated Address addresses = 2; repeated Condition conditions = 3;
  repeated AppliedConfig applied_configs = 4; Workloads workloads = 5; RouterStatus router = 6; int64 observed_generation = 7;
  ModelPhase phase = 8; /* derived: PENDING (Ready absent/Unknown) | READY | FAILED (Ready=False), reason = Ready.reason */ }
message Address { string name = 1; string url = 2; ObjectRef origin = 3; repeated string models = 4; }
message AppliedConfig { string name = 1; string namespace = 2; string source = 3; /* Preset|UserRef|ServingRuntime */ }
message Workloads { WorkloadRef primary = 1; WorkloadRef prefill = 2; WorkloadRef scheduler = 3; }
message WorkloadRef { string kind = 1; string name = 2; int32 ready_replicas = 3; }

// Catalog = MaaSModelRef (tenant-facing model entries). ExternalModel/ExternalProvider for off-cluster/grid models.
service Catalog {
  rpc ListCatalogEntries(ListCatalogEntriesRequest) returns (ListCatalogEntriesResponse);
  rpc GetCatalogEntry(GetCatalogEntryRequest) returns (CatalogEntry);
  rpc CreateCatalogEntry(CreateCatalogEntryRequest) returns (CatalogEntry);   // AlreadyExists on duplicate name
  rpc UpdateCatalogEntry(UpdateCatalogEntryRequest) returns (CatalogEntry);
  rpc DeleteCatalogEntry(DeleteCatalogEntryRequest) returns (google.protobuf.Empty);  // FailedPrecondition when referenced
}
message CatalogEntry { ObjectMeta metadata = 1; ModelReference model_ref = 2; /* kind: LLMInferenceService|ExternalModel; name */
  string endpoint_override = 3; string tenant_ref = 4; repeated string capabilities = 5; /* console-owned, store as annotation */
  MaaSModelRefStatus status = 6; ExternalModelSummary external = 7; }
message MaaSModelRefStatus { string phase = 1; /* Pending|Ready|Unhealthy|Failed|Invalid */ string endpoint = 2;
  string http_route_name = 3; string http_route_namespace = 4; string gateway_name = 5; string gateway_namespace = 6;
  repeated string hostnames = 7; string resolved_tenant_ref = 8; string resolved_model_alias = 9; repeated Condition conditions = 10; }
message ExternalModelSummary { string provider = 1; string endpoint = 2; string api_format = 3; string path = 4; string target_model = 5; string phase = 6; }

// Subscriptions = MaaSSubscription + its MaaSAuthPolicy
service Subscriptions {
  rpc ListSubscriptions(ListSubscriptionsRequest) returns (ListSubscriptionsResponse);  // filter by owner group (tenant)
  rpc GetSubscription(GetSubscriptionRequest) returns (SubscriptionInfo);
  rpc CreateSubscription(CreateSubscriptionRequest) returns (SubscriptionInfo);          // create_auth_policy -> <name>-policy
  rpc UpdateSubscription(UpdateSubscriptionRequest) returns (SubscriptionInfo);
  rpc DeleteSubscription(DeleteSubscriptionRequest) returns (google.protobuf.Empty);     // also deletes generated policy
  rpc ListAuthPolicies(ListAuthPoliciesRequest) returns (ListAuthPoliciesResponse);
}
message Subscription { ObjectMeta metadata = 1; SubscriptionSpec spec = 2; SubscriptionStatus status = 3; }
message SubscriptionSpec { Owner owner = 1; repeated ModelSubscriptionRef model_refs = 2; int32 priority = 3;
  optional int32 inference_priority = 4; TokenMetadata token_metadata = 5; repeated GuardrailAttachment guardrails = 6; }
message Owner { repeated string groups = 1; repeated string users = 2; }
message ModelSubscriptionRef { string name = 1; string namespace = 2; repeated TokenRateLimit token_rate_limits = 3; bool unlimited = 4; string billing_rate_per_token = 5; }
message TokenRateLimit { int64 limit = 1; string window = 2; /* ^[1-9]\d{0,3}(s|m|h)$ */ }
message TokenMetadata { string organization_id = 1; string cost_center = 2; map<string,string> labels = 3; }
message SubscriptionStatus { string phase = 1; /* Pending|Active|Degraded|Failed|Invalid */ repeated Condition conditions = 2;
  repeated ResourceRefStatus model_ref_statuses = 3; repeated TokenRateLimitStatus token_rate_limit_statuses = 4; repeated FlowControlStatus flow_control_statuses = 5; }
message TokenRateLimitStatus { ResourceRefStatus ref = 1; string model = 2; }
message AuthPolicy { ObjectMeta metadata = 1; repeated ModelRef model_refs = 2; Owner subjects = 3; TokenMetadata metering_metadata = 4;
  string phase = 5; repeated Condition conditions = 6; repeated ResourceRefStatus auth_policies = 7; }
message SubscriptionInfo { Subscription subscription = 1; repeated CatalogEntry model_refs = 2; repeated AuthPolicy auth_policies = 3; }

// Grid = AIGateway component + grid.praxis.fast (when installed) + Praxis routing overlay facts
service Grid {
  rpc GetGridStatus(GetGridStatusRequest) returns (GridStatus);        // AIGateway conditions, crds_installed, network summary
  rpc ListGridSites(ListGridSitesRequest) returns (ListGridSitesResponse);
  rpc ListInferenceProviders(ListInferenceProvidersRequest) returns (ListInferenceProvidersResponse);
  rpc GetOverview(GetOverviewRequest) returns (GridOverview);            // POC metric contract (range, site, metrics=false)
}
message GridStatus { bool crds_installed = 1; string ai_grid_management_state = 2; /* Managed|Removed */ string maas_management_state = 3;
  repeated Condition aigateway_conditions = 4; GridNetwork network = 5; /* null when CRDs absent */ }
message GridNetwork { string name = 1; string phase = 2; /* Pending|Initializing|Active|Degraded */ string grid_id = 3; int32 connected_sites = 4;
  int32 distributed_provider_count = 5; string region = 6; string zone = 7; string routing_policy = 8; string scoring_strategy = 9; repeated Condition conditions = 10; }
message GridSite { string name = 1; string grid_network_ref = 2; string phase = 3; /* Pending|Discovered|Connecting|Active|Unreachable|Left */
  string reason = 4; string message = 5; string egress_address = 6; string region = 7; string zone = 8; string sovereignty_zone = 9;
  google.protobuf.Timestamp last_probe_time = 10; google.protobuf.Timestamp last_transition_time = 11; }
message InferenceProvider { string name = 1; string grid_network_ref = 2; string provider_kind = 3; string backend_kind = 4; string endpoint = 5;
  repeated string models = 6; string phase = 7; /* Pending|Available|Degraded|Unavailable */ Condition ready = 8; map<string,string> site_selector = 9;
  string source_name = 10; string source_namespace = 11; /* grid.praxis.fast/source-* annotations */ }
```

Status derivation rules the BFF/fake must share: `Model.status.phase` from the LLMISvc `Ready` condition; `CatalogEntry` phase is the CR's `status.phase`; subscription "effective access" = `phase in (Active, Degraded) && deletion_timestamp == null`. `display_name`/`description` are read/written through `openshift.io/display-name|description` annotations. Names must be DNS-1123 labels (<= 63 for `modelRefs[].name`; AITenant <= 41).

### 8.2 What the fake gRPC backend must simulate

Lifecycle (timers, deterministic, configurable speed):

- `CreateModel`: return the LLMISvc immediately with no conditions (phase `PENDING`); after T1 add `PresetsCombined=True`, `GatewaysReady=True`, `HTTPRoutesReady=False/HTTPRouteNotObserved`; after T2 `HTTPRoutesReady=True`, `InferencePoolReady=True`, `SchedulerWorkloadReady=True`, `RouterReady=True`, `MainWorkloadReady=False/ReconcileSingleNodeWorkloadError` ("0/1 replicas available"); after T3 `MainWorkloadReady=True`, `WorkloadsReady=True`, `Ready=True`, fill `url`, six `addresses` (external and internal, path and publishers forms), `workloads.primary.readyReplicas`. Failure modes selected by name/URI/annotation: unknown `baseRefs` -> `PresetsCombined=False/ConfigNotFound` and `Ready=False` same reason, never progresses; image or model name containing `oom`/`fail` -> stuck at `MainWorkloadReady=False`; gateway name not in the known set -> `GatewaysReady=False/GatewaysNotReady`. `replicas` + `scaling` together -> `InvalidArgument` with the CEL message; `scaling.wva` -> `InvalidArgument` ("WVA autoscaling is no longer supported"); `model.uri` missing or bad scheme -> `InvalidArgument`.
- `CreateCatalogEntry`: `MaaSModelRef` starts `phase: Pending`, `GovernanceAttached=False/NoPairingFound`, `RuntimeReady` from the backing model (`BackendNotReady` until the LLMISvc is Ready, or `RuntimeHealthy` when it is; `NotFound` -> `Failed` when the referenced model does not exist). Transition to `Ready` only when both an `Active` subscription and an auth policy reference it; set `endpoint` = tenant gateway URL, `httpRouteName` = `<name>-kserve-route` or `external-model-<name>`, `httpRouteGatewayName` = `openshift-ai-inference` (LLMISvc) or `maas-default-gateway` (ExternalModel), `resolvedModelAlias` = `publishers/<ns>/models/<model.name>` or `targetModel`, `resolvedTenantRef`. When the backing LLMISvc later turns `Ready=False`, flip to `Unhealthy` with `RuntimeReady=False/RuntimeHealthFailure`. Removing the last subscription/policy -> back to `Pending` with `GovernanceAttached=False/GovernanceGap`. `modelRef.kind` outside the enum -> `InvalidArgument`.
- `CreateSubscription`: validate CRD rules (`modelRefs` >= 1; each ref needs `tokenRateLimits` >= 1 unless `unlimited`; `unlimited` + limits -> `InvalidArgument` "tokenRateLimits must not be set when unlimited is true"; `limit` 1..1e9; `window` regex, reject `1d`; `owner` present; name uniqueness -> `AlreadyExists`). Status: start `Pending` with `modelRefStatuses` computed (`Valid` for existing refs, `NotFound` otherwise) and `tokenRateLimitStatuses` `ready:false/NotEnforced`; after T1 flip TRLP items to `Accepted`/`AcceptedEnforced` and `phase: Active`, `Ready=True/Reconciled`, `SpecPriorityDuplicate=False/NoDuplicatePeers` (or `True` when another subscription with the same priority exists for an overlapping owner group). Any `NotFound` ref -> `Ready=False/PartialFailure`, phase `Pending` (all refs missing -> `Failed`). `inferencePriority` set and model served by an ExternalModel -> `flowControlStatuses[].reason: NotApplicable, ready: true`; for LLMISvc -> `PoolPending` then `ObjectiveReconciled`. Optionally generate the `MaaSAuthPolicy` `<name>-policy` with `openshift.io/description: Auth policy created for subscription "<name>"`, phase `Active`, `ConflictingAuthPolicy=False/NoConflict`.
- Delete: set `deletionTimestamp`, keep the object listed for T (finalizer) with the same phase (`Terminating` is only an AITenant phase), then remove. `DeleteModel`/`DeleteCatalogEntry` -> `FailedPrecondition` while any subscription or policy references the name (the POC returns 409; the plan maps `FailedPrecondition` to 412 and `AlreadyExists` to 409, so pick `FailedPrecondition` and let the UI show "remove from subscriptions first").
- Uniqueness and names: `AlreadyExists` on duplicate `{namespace, name}` for every kind; `InvalidArgument` for non-DNS-1123 names, `modelRefs[].name` > 63 chars, display names > 253.
- Gateways/routes: expose fixed Gateways `openshift-ingress/openshift-ai-inference` and `openshift-ingress/maas-default-gateway` (Programmed=True) so `GatewaysReady` can be computed and `GridStatus`/`CatalogEntry` can reference them.
- Grid: default `crds_installed=false`, `ai_grid_management_state=Removed`, `AIGridReady=False/Removed`; a flag flips to an installed network with one local `GridSite` stuck `Pending/AwaitingDiscovery` (documented normal), N remote sites cycling `Discovered/GatewayAddressMissing` -> `Connecting/GatewayAddressKnown` -> `Active/TlsVerified` (and one `Connecting/TrustMaterialMissing`), and one `InferenceProvider` per Ready LLMISvc named `grid-<ns>-<name>-<uid>-<digest>` with `providerKind: vllm`, `backendKind: local_model`, `Ready=True/Ready` or `Unknown/MetricsNotConfigured`.
- Overview metrics: reuse the POC's deterministic generator contract (`metricsSource: demo`) until a Thanos contract exists.
- Watch/poll: UI polls list endpoints; if the fake exposes `WatchModels`, emit `ADDED/MODIFIED/DELETED` with full objects.

## 9. Open questions / unverified

1. `MaaSSubscription.spec.organization.id` and `AITenant.spec.oidc.audience/accessTokenPurpose*` exist in upstream `main` Go types and docs but not in the CRD installed on the hub (RHOAI 3.6 / MaaS v0.2.0). Decide which version the proto tracks.
2. The MaaS reason enum in the hub CRD has 20 values; the hub shows condition type `ModelIdentityUnique` with reason `UniqueIdentity`, which is not in the Go constants fetched from `main`. Treat the reason list as open.
3. Whether the console should create `MaaSModelRef` directly (tenant namespace, requires RBAC on `maas.opendatahub.io`) or rely on an ODH dashboard/BFF flow is a product decision; the hub's current objects were applied by Argo CD from an `acm-models-local-cluster` application, which suggests GitOps is the intended write path on this hub.
4. "Catalog in ConfigMaps" (console plan, Step 9) has no counterpart in the POC or on the hub. If the console needs its own catalog (descriptions, capabilities, cards), either store it as annotations on `MaaSModelRef` (`openshift.io/*` plus a console-owned prefix) or define the ConfigMap label/key convention explicitly; nothing exists to reuse.
5. API key listing per subscription requires `maas-api` admin access (`POST /maas-api/v1/api-keys/search` with `filters.username`); confirm whether the backend will proxy that or the console stays CRD-only.
6. The Praxis `InferenceProvider` enum values differ between the grid docs (`self_hosted|open_ai|...`, `local|remote|cloud_managed|api_provider`) and what `odh-model-controller` writes (`vllm`, `local_model`); the CRD stores plain strings. The fake should use the ODH values.
7. `TokenRateLimitPolicy` `when` predicates embed an opaque per-subscription id (`auth.identity.selected_subscription_id == "<hex>"`) that is not present in `MaaSSubscription.status`; it is minted by `maas-api`. The console can show the TRLP name/status from `tokenRateLimitStatuses` but not that id.
8. No `ai_gateway_requests_total`/DCGM metrics were checked on the hub (read-only spike did not query Thanos); the Grid overview metric contract remains the POC's assumption.
9. `AIGateway.spec.aiGrid.managementState` exists on the component CRD but `DataScienceCluster.spec.components.aigateway` does not expose it on this version, so flipping it would mean editing the component CR directly (not done; out of scope).
10. `LLMInferenceServiceConfig` presets are versioned by RHOAI release (`v3-6-0-*`); the fake should treat `baseRefs` as free strings validated against a configurable preset list rather than hard-coding names.
