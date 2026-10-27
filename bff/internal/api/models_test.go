package api

import (
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
)

func modelCondition(typ string, st aigridv1.ConditionStatus, reason, message string) *aigridv1.Condition {
	c := &aigridv1.Condition{Type: typ, Status: st, LastTransitionTime: timestamppb.New(time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC))}
	if reason != "" {
		c.Reason = proto.String(reason)
	}
	if message != "" {
		c.Message = proto.String(message)
	}
	return c
}

func seedModels() []*aigridv1.Model {
	return []*aigridv1.Model{
		{
			Name:     "tiny-llm",
			Metadata: &aigridv1.ObjectMeta{Namespace: "ai-grid-models", ResourceVersion: "7", Generation: 1, Labels: map[string]string{"ai-grid/family": "tiny"}, Annotations: map[string]string{AnnotationDisplayName: "Tiny LLM", AnnotationDescription: "CPU smoke test"}, CreationTimestamp: timestamppb.New(time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC))},
			Spec: &aigridv1.ModelSpec{
				Model: &aigridv1.ModelSource{Uri: "hf://example-org/tiny-llm", Name: "example-org/tiny-llm"}, Replicas: proto.Int32(1), BaseRefs: []string{"v3-6-0-kserve-config-llm-template-cpu"},
				Router: &aigridv1.Router{GatewayRefs: []*aigridv1.GatewayRef{{Name: DefaultGatewayName, Namespace: DefaultGatewayNamespace}}, ManagedRoute: true, Scheduler: true},
				Main:   &aigridv1.Container{Requests: map[string]string{"cpu": "4"}, Env: []*aigridv1.EnvVar{{Name: "VLLM_CPU_KVCACHE_SPACE", Value: "8"}}},
			},
			Status: &aigridv1.ModelStatus{
				Phase: aigridv1.ModelPhase_MODEL_PHASE_READY, Url: "https://openshift-ai-inference.apps.hub.example.com/ai-grid-models/tiny-llm", ObservedGeneration: 1,
				Addresses:      []*aigridv1.Address{{Name: "gateway-external", Url: "https://openshift-ai-inference.apps.hub.example.com/ai-grid-models/tiny-llm", Models: []string{"publishers/ai-grid-models/models/example-org/tiny-llm", "example-org/tiny-llm"}}},
				Conditions:     []*aigridv1.Condition{modelCondition("Ready", aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, "", ""), modelCondition("PresetsCombined", aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, "", "")},
				AppliedConfigs: []*aigridv1.AppliedConfig{{Name: "v3-6-0-kserve-config-llm-template", Namespace: "redhat-ods-applications", Source: "Preset"}},
			},
		},
		{
			Name:     "granite-8b-instruct",
			Metadata: &aigridv1.ObjectMeta{Namespace: "ai-grid-models", ResourceVersion: "9", Generation: 2, Labels: map[string]string{"ai-grid/family": "granite"}},
			Spec: &aigridv1.ModelSpec{
				Model: &aigridv1.ModelSource{Uri: "hf://example-org/granite-8b-instruct"}, Replicas: proto.Int32(1),
				Main:      &aigridv1.Container{Image: "quay.io/example/vllm-cuda:v0.11.0", Requests: map[string]string{"nvidia.com/gpu": "1"}, Limits: map[string]string{"nvidia.com/gpu": "1"}},
				Placement: &aigridv1.Placement{ClusterSets: []string{"global"}, LabelSelector: &aigridv1.LabelSelector{MatchLabels: map[string]string{"ai-grid/enabled": "true"}, MatchExpressions: []*aigridv1.LabelSelectorRequirement{{Key: "ai-grid/region", Operator: "In", Values: []string{"europe-west"}}}}, Tolerations: []*aigridv1.Toleration{{Key: "cluster.open-cluster-management.io/unreachable", Operator: "Exists", TolerationSeconds: proto.Int64(600)}}},
				Rollout:   &aigridv1.Rollout{Strategy: aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_PROGRESSIVE, MaxConcurrency: "1", ProgressDeadline: "15m"},
			},
			Status: &aigridv1.ModelStatus{
				Phase: aigridv1.ModelPhase_MODEL_PHASE_PENDING, Reason: "Processing",
				Placement: &aigridv1.PlacementStatus{NumberOfSelectedClusters: 2, Decisions: []*aigridv1.ClusterDecision{{ClusterName: "site-paris-1"}, {ClusterName: "site-madrid-1"}}, Locations: []string{"madrid", "paris"},
					Conditions: []*aigridv1.Condition{modelCondition("PlacementSatisfied", aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, "AllDecisionsScheduled", "All cluster decisions scheduled")}},
				Rollout: &aigridv1.RolloutStatus{
					Summary:    &aigridv1.RolloutSummary{Total: 2, Applied: 2, Available: 1, Progressing: 1, Updated: 2}, // updated is never written by OCM; the BFF drops it
					Conditions: []*aigridv1.Condition{modelCondition("PlacementRolledOut", aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, "Progressing", ""), modelCondition("ManifestworkApplied", aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, "Processing", "")},
					Works: []*aigridv1.ManifestWorkStatus{
						{ClusterName: "site-madrid-1", WorkName: "model-granite-8b-instructx7k2p", Generation: 2}, // agent not reporting: empty status
						{ClusterName: "site-paris-1", WorkName: "model-granite-8b-instructm4q8z", Generation: 2, ObservedGeneration: 2,
							Conditions: []*aigridv1.Condition{modelCondition("Applied", aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, "AppliedManifestWorkComplete", "Apply manifest work complete"), modelCondition("Available", aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, "ResourcesAvailable", "All resources are available"), modelCondition("Progressing", aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, "ConditionRulesAggregated", "LLMInferenceService rolling out"), modelCondition("Degraded", aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, "ConditionRulesAggregated", "LLMInferenceService not ready")},
							Manifests:  []*aigridv1.ManifestStatus{{Resource: &aigridv1.ResourceIdentifier{Ordinal: 1, Kind: "LLMInferenceService"}, Feedback: []*aigridv1.FeedbackValue{{Name: "ready", Type: "String", Value: "False"}, {Name: "url", Type: "String", Value: "https://openshift-ai-inference.apps.site-paris-1.example.com/ai-grid-models/granite-8b-instruct"}}}}},
					},
				},
			},
		},
		{
			Name:     "other",
			Metadata: &aigridv1.ObjectMeta{Namespace: "team-b", ResourceVersion: "3", Generation: 1},
			Spec:     &aigridv1.ModelSpec{Model: &aigridv1.ModelSource{Uri: "s3://bucket/other"}, Scaling: &aigridv1.Scaling{MinReplicas: 1, MaxReplicas: 4, Keda: true}},
			Status:   &aigridv1.ModelStatus{Phase: aigridv1.ModelPhase_MODEL_PHASE_FAILED, Reason: "ConfigNotFound", Message: `LLMInferenceServiceConfig "x" not found in namespaces [team-b redhat-ods-applications]`},
		},
	}
}

func TestListModels(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels()}
	app := newTestApp(t, testConfig(t), fake)
	var list []Model
	rec := serve(app, asUser(http.MethodGet, "/api/v1/models"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	meta := decodeList(t, rec, &list)
	if len(list) != 3 || list[0].Name != "granite-8b-instruct" || list[2].Namespace != "team-b" || total(meta) != 3 {
		t.Fatalf("list = %+v meta %+v", list, meta)
	}
	if fake.LastListModels.Filter != nil {
		t.Errorf("no query means no filter: %v", fake.LastListModels)
	}
	tiny := list[1]
	if tiny.DisplayName != "Tiny LLM" || tiny.Description != "CPU smoke test" || tiny.ModelURI != "hf://example-org/tiny-llm" || tiny.ModelName != "example-org/tiny-llm" || tiny.Replicas == nil || *tiny.Replicas != 1 || tiny.Phase != PhaseReady || tiny.URL == "" || len(tiny.Addresses) != 1 || len(tiny.Addresses[0].Models) != 2 || len(tiny.Conditions) != 2 || len(tiny.AppliedConfigs) != 1 || tiny.Env[0].Name != "VLLM_CPU_KVCACHE_SPACE" || tiny.Gateways[0].Name != DefaultGatewayName || tiny.Requests["cpu"] != "4" || tiny.Placement != nil || tiny.Rollout != nil || tiny.ResourceVersion != "7" || tiny.CreationTimestamp == nil {
		t.Errorf("tiny = %+v", tiny)
	}
	granite := list[0]
	if granite.ModelName != "granite-8b-instruct" || granite.Phase != PhasePending || granite.Reason != "Processing" || granite.Placement == nil || granite.Rollout == nil {
		t.Fatalf("granite = %+v", granite)
	}
	p := granite.Placement
	if !p.Satisfied || p.Reason != "AllDecisionsScheduled" || len(p.SelectedClusters) != 2 || !slices.Equal(p.Locations, []string{"madrid", "paris"}) || p.MatchLabels["ai-grid/enabled"] != "true" || p.MatchExpressions[0].Values[0] != "europe-west" || p.Tolerations[0].TolerationSeconds == nil || *p.Tolerations[0].TolerationSeconds != 600 || p.ClusterSets[0] != "global" {
		t.Errorf("placement = %+v", p)
	}
	r := granite.Rollout
	if r.Strategy != StrategyProgressive || r.MaxConcurrency != "1" || r.Summary.Total != 2 || r.Summary.Progressing != 1 || r.RolledOut || r.Applied || r.Reason != "Processing" || len(r.Works) != 2 {
		t.Errorf("rollout = %+v", r)
	}
	if strings.Contains(rec.Body.String(), `"updated"`) || strings.Contains(rec.Body.String(), `"desiredTotal"`) {
		t.Errorf("summary carries updated/desiredTotal, which OCM never writes: %s", rec.Body.String())
	}
	madrid, paris := r.Works[0], r.Works[1]
	if madrid.Applied != "" || madrid.Available != "" || madrid.Progressing != "" || madrid.Feedback.Ready != "" || madrid.Conditions == nil || madrid.ObservedGeneration != 0 {
		t.Errorf("madrid work = %+v", madrid)
	}
	if paris.Progressing != "True" || paris.Degraded != "False" || paris.Feedback.Ready != "False" || !strings.HasPrefix(paris.Feedback.URL, "https://openshift-ai-inference.apps.site-paris-1") || paris.WorkName != "model-granite-8b-instructm4q8z" || paris.ObservedGeneration != 2 {
		t.Errorf("paris work = %+v", paris)
	}
	other := list[2]
	if other.Replicas != nil || other.Scaling == nil || other.Scaling.MaxReplicas != 4 || other.Phase != PhaseFailed || other.Reason != "ConfigNotFound" || other.ModelName != "other" || other.BaseRefs == nil || other.Env == nil || other.Addresses == nil || other.Labels == nil {
		t.Errorf("other = %+v (collections are always present)", other)
	}

	// The client writes the CEL (the guarded label form, so a model without
	// the label is false instead of a `no such key` error); the BFF forwards it.
	const tinyFamily = `this.metadata.namespace == "ai-grid-models" && "ai-grid/family" in this.metadata.labels && this.metadata.labels["ai-grid/family"] == "tiny"`
	rec = serve(app, asUser(http.MethodGet, "/api/v1/models?offset=0&limit=5&filter="+url.QueryEscape(tinyFamily)))
	meta = decodeList(t, rec, &list)
	if fake.LastListModels.GetFilter() != tinyFamily || fake.LastListModels.GetLimit() != 5 {
		t.Errorf("query not mapped: %v", fake.LastListModels)
	}
	if len(list) != 1 || list[0].Name != "tiny-llm" || meta.Limit == nil || *meta.Limit != 5 || total(meta) != 1 {
		t.Errorf("filtered = %+v %+v", list, meta)
	}
	rec = serve(app, asUser(http.MethodGet, "/api/v1/models?filter="+url.QueryEscape(`this.status.phase == ai_grid.v1.ModelPhase.MODEL_PHASE_FAILED`)))
	if decodeList(t, rec, &list); rec.Code != http.StatusOK || len(list) != 1 || list[0].Name != "other" {
		t.Errorf("any CEL over the model = %d %+v", rec.Code, list)
	}
	// An unguarded index fails on a model without the key: the backend's
	// InvalidArgument, 422.
	rec = serve(app, asUser(http.MethodGet, "/api/v1/models?filter="+url.QueryEscape(`this.metadata.labels["ai-grid/family"] == "tiny"`)))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(decodeError(t, rec).Error.Message, "no such key") {
		t.Errorf("unguarded index = %d %s", rec.Code, rec.Body.String())
	}
	for q, want := range map[string]string{
		"namespace=team-b":             `query parameter "namespace" is not supported; send a CEL filter in "filter"`,
		"label=ai-grid/family%3Dtiny":  `query parameter "label" is not supported; send a CEL filter in "filter"`,
		"label=nokey":                  `query parameter "label" is not supported; send a CEL filter in "filter"`,
		"offset=-1":                    `query parameter "offset" must be an integer between 0 and 2147483647`,
		"limit=x":                      `query parameter "limit" must be an integer between 0 and 2147483647`,
		"filter=true&namespace=team-b": `query parameter "namespace" is not supported; send a CEL filter in "filter"`,
	} {
		fake.Calls = nil
		if rec := serve(app, asUser(http.MethodGet, "/api/v1/models?"+q)); rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != want || len(fake.Calls) != 0 {
			t.Errorf("%s -> %d %s, calls %v; want 422 %q", q, rec.Code, rec.Body.String(), fake.Calls, want)
		}
	}
}

func TestGetModel(t *testing.T) {
	app := newTestApp(t, testConfig(t), &backendtest.Fake{Models: seedModels()})
	var m Model
	rec := serve(app, asUser(http.MethodGet, "/api/v1/models/team-b/other"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &m)
	if m.Name != "other" || m.Namespace != "team-b" || m.Message == "" {
		t.Errorf("model = %+v", m)
	}
	rec = serve(app, asUser(http.MethodGet, "/api/v1/models/team-b/nope"))
	if rec.Code != http.StatusNotFound || decodeError(t, rec).Error.Message != "object with identifier 'team-b/nope' not found" {
		t.Errorf("not found = %d %s", rec.Code, rec.Body.String())
	}
}

func TestCreateModel(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels()}
	app := newTestApp(t, testConfig(t), fake)
	body := `{"name": "mistral-7b", "namespace": "ai-grid-models", "modelUri": "oci://registry.example.com/models/mistral:v0.3", "modelName": "example-org/mistral-7b",
	  "runtimeImage": "quay.io/example/vllm-cuda:v0.11.0", "replicas": 2, "baseRefs": ["v3-6-0-kserve-config-llm-template"], "cpu": "8", "memory": "32Gi", "gpuCount": 1, "env": [{"name": "VLLM_ADDITIONAL_ARGS", "value": "--max-model-len 8192"}],
	  "placement": {"matchLabels": {"ai-grid/enabled": "true"}, "matchExpressions": [{"key": "location", "operator": "In", "values": ["paris", "madrid"]}], "tolerations": [{"key": "cluster.open-cluster-management.io/unreachable", "operator": "Exists", "tolerationSeconds": 600}], "numberOfClusters": 2},
	  "rollout": {"strategy": "Progressive", "maxConcurrency": "1", "progressDeadline": "15m"}, "labels": {"ai-grid/family": "mistral"}, "annotations": {"openshift.io/display-name": "Mistral 7B", "openshift.io/description": "EU sites"}}`
	rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/models", body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc != "/api/v1/models/ai-grid-models/mistral-7b" {
		t.Errorf("Location = %q", loc)
	}
	var m Model
	decodeData(t, rec, &m)
	if m.Name != "mistral-7b" || m.DisplayName != "Mistral 7B" || m.Phase != PhasePending || m.Placement == nil || m.Rollout.Strategy != StrategyProgressive {
		t.Errorf("created = %+v", m)
	}
	sent := fake.LastCreateModel.GetObject()
	if sent.GetMetadata().GetAnnotations()[AnnotationDisplayName] != "Mistral 7B" || sent.GetMetadata().GetAnnotations()[AnnotationDescription] != "EU sites" || sent.GetMetadata().GetLabels()["ai-grid/family"] != "mistral" {
		t.Errorf("annotations/labels = %v", sent.GetMetadata())
	}
	spec := sent.GetSpec()
	if spec.GetModel().GetUri() != "oci://registry.example.com/models/mistral:v0.3" || spec.GetModel().GetName() != "example-org/mistral-7b" || spec.GetReplicas() != 2 || spec.GetBaseRefs()[0] != "v3-6-0-kserve-config-llm-template" {
		t.Errorf("spec = %v", spec)
	}
	if main := spec.GetMain(); main.GetImage() != "quay.io/example/vllm-cuda:v0.11.0" || main.GetRequests()[ResourceCPU] != "8" || main.GetRequests()[ResourceMemory] != "32Gi" || main.GetRequests()[ResourceGPU] != "1" || main.GetLimits()[ResourceGPU] != "1" || main.GetEnv()[0].GetValue() != "--max-model-len 8192" {
		t.Errorf("main = %v", main)
	}
	if r := spec.GetRouter(); !r.GetManagedRoute() || !r.GetScheduler() || r.GetGatewayRefs()[0].GetName() != DefaultGatewayName || r.GetGatewayRefs()[0].GetNamespace() != DefaultGatewayNamespace {
		t.Errorf("router = %v", r)
	}
	if p := spec.GetPlacement(); p.GetLabelSelector().GetMatchLabels()["ai-grid/enabled"] != "true" || p.GetLabelSelector().GetMatchExpressions()[0].GetValues()[1] != "madrid" || p.GetTolerations()[0].GetTolerationSeconds() != 600 || p.GetNumberOfClusters() != 2 {
		t.Errorf("placement = %v", p)
	}
	if r := spec.GetRollout(); r.GetStrategy() != aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_PROGRESSIVE || r.GetMaxConcurrency() != "1" || r.GetProgressDeadline() != "15m" {
		t.Errorf("rollout = %v", r)
	}

	// Scaling becomes a keda block with its triggers.
	rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "scaled", "namespace": "ai-grid-models", "modelUri": "hf://example-org/scaled", "scaling": {"minReplicas": 1, "maxReplicas": 4, "triggers": [{"type": "prometheus", "metadata": {"query": "vllm:num_requests_waiting"}}]}}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if sc := fake.LastCreateModel.GetObject().GetSpec().GetScaling(); !sc.GetKeda() || sc.GetMinReplicas() != 1 || sc.GetMaxReplicas() != 4 || len(sc.GetTriggers()) != 1 || sc.GetTriggers()[0].GetType() != "prometheus" || sc.GetTriggers()[0].GetMetadata()["query"] != "vllm:num_requests_waiting" {
		t.Errorf("scaling = %v", sc)
	}
	var scaled Model
	decodeData(t, rec, &scaled)
	if scaled.Scaling == nil || scaled.Scaling.MaxReplicas != 4 || len(scaled.Scaling.Triggers) != 1 || scaled.Replicas != nil {
		t.Errorf("scaled = %+v", scaled)
	}

	// A hub-only model: no placement, no GPU request without gpuCount.
	rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "cpu-only", "namespace": "ai-grid-models", "modelUri": "hf://example-org/cpu-only"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if sent := fake.LastCreateModel.GetObject(); sent.GetSpec().GetPlacement() != nil || sent.GetSpec().Replicas != nil || len(sent.GetSpec().GetMain().GetRequests()) != 0 || sent.GetSpec().GetRollout() != nil {
		t.Errorf("hub-only = %v", sent.GetSpec())
	}

	calls := len(fake.Calls)
	for _, tc := range []struct {
		name, body string
		code       int
		message    string
	}{
		{"unknown field", `{"name": "x", "namespace": "n", "modelUri": "hf://x", "locations": ["a"]}`, http.StatusUnprocessableEntity, `invalid request body: json: unknown field "locations"`},
		{"bad strategy", `{"name": "x", "namespace": "n", "modelUri": "hf://x", "placement": {}, "rollout": {"strategy": "Canary"}}`, http.StatusUnprocessableEntity, "rollout.strategy must be All, Progressive or ProgressivePerGroup"},
		{"negative gpu", `{"name": "x", "namespace": "n", "modelUri": "hf://x", "gpuCount": -1}`, http.StatusUnprocessableEntity, "gpuCount must not be negative"},
		{"malformed", `{"name": `, http.StatusUnprocessableEntity, "invalid request body: malformed JSON"},
		{"null", `null`, http.StatusUnprocessableEntity, "invalid request body: must be a JSON object"},
		{"nested type", `{"name": "x", "placement": {"clusterSets": "x"}}`, http.StatusUnprocessableEntity, `invalid request body: field "placement.clusterSets" must be an array`},
	} {
		rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/models", tc.body))
		if rec.Code != tc.code || decodeError(t, rec).Error.Message != tc.message {
			t.Errorf("%s: %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	if len(fake.Calls) != calls {
		t.Errorf("an invalid body must not reach the backend: %v", fake.Calls[calls:])
	}

	// Backend answers: the CRD's message as 422, a taken name as 409, the gate as 412.
	rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "tiny-llm", "namespace": "ai-grid-models", "modelUri": "hf://x"}`))
	if rec.Code != http.StatusConflict || decodeError(t, rec).Error.Message != `llminferenceservices.serving.kserve.io "tiny-llm" already exists` {
		t.Errorf("duplicate = %d %s", rec.Code, rec.Body.String())
	}
	fake.Errs = map[string]error{"CreateModel": backendtest.Status(codes.FailedPrecondition, "ManifestWorkReplicaSet feature gate disabled on hub")}
	rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "y", "namespace": "n", "modelUri": "hf://y", "placement": {}}`))
	if rec.Code != http.StatusPreconditionFailed || decodeError(t, rec).Error.Message != "ManifestWorkReplicaSet feature gate disabled on hub" {
		t.Errorf("gate off = %d %s", rec.Code, rec.Body.String())
	}
	fake.Errs = map[string]error{"CreateModel": backendtest.Status(codes.InvalidArgument, "either wva or keda must be specified when scaling is configured")}
	rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "y", "namespace": "n", "modelUri": "hf://y"}`))
	if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != "either wva or keda must be specified when scaling is configured" {
		t.Errorf("CRD message = %d %s", rec.Code, rec.Body.String())
	}
	fake.Errs = map[string]error{"CreateModel": backendtest.Status(codes.PermissionDenied, `User "alice" is not a provider admin: cannot patch resource "managedclusters" in API group "cluster.open-cluster-management.io" at the cluster scope`)}
	if rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "y", "namespace": "n", "modelUri": "hf://y"}`)); rec.Code != http.StatusForbidden {
		t.Errorf("viewer = %d", rec.Code)
	}
}

func TestPatchModel(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels()}
	app := newTestApp(t, testConfig(t), fake)
	const tiny = "/api/v1/models/ai-grid-models/tiny-llm"
	rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{"replicas": 3, "runtimeImage": "quay.io/example/vllm:v2", "env": [], "labels": {"team": "a"}, "annotations": {"openshift.io/display-name": "Tiny LLM v2"}}`), `"7"`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var m Model
	decodeData(t, rec, &m)
	// The annotations are a whole map: the description the client left out is gone.
	if m.Replicas == nil || *m.Replicas != 3 || m.RuntimeImage != "quay.io/example/vllm:v2" || len(m.Env) != 0 || m.DisplayName != "Tiny LLM v2" || m.Description != "" || m.Labels["team"] != "a" || m.ResourceVersion != "8" {
		t.Errorf("patched = %+v", m)
	}
	if strings.Join(fake.Calls, ",") != "UpdateModel" {
		t.Errorf("the BFF must not read the model first: calls %v", fake.Calls)
	}
	req := fake.LastUpdateModel
	if !req.GetLock() || req.GetObject().GetMetadata().GetResourceVersion() != "7" || strings.Join(req.GetUpdateMask().GetPaths(), ",") != "spec.replicas,spec.main.image,spec.main.env,metadata.labels,metadata.annotations" {
		t.Errorf("update request = %v", req)
	}
	if ann := req.GetObject().GetMetadata().GetAnnotations(); len(ann) != 1 || ann[AnnotationDisplayName] != "Tiny LLM v2" {
		t.Errorf("annotations go as sent, nothing merged: %v", ann)
	}
	if len(req.GetObject().GetSpec().GetMain().GetEnv()) != 0 {
		t.Errorf("env: [] clears the variables (the mask path carries the intent), sent %v", req.GetObject().GetSpec().GetMain())
	}

	// A placement alone is only spec.placement: the BFF adds no rollout.
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{"placement": {"matchLabels": {"ai-grid/enabled": "true"}}}`), `"8"`))
	if rec.Code != http.StatusOK || strings.Join(fake.LastUpdateModel.GetUpdateMask().GetPaths(), ",") != "spec.placement" || fake.LastUpdateModel.GetObject().GetSpec().GetRollout() != nil {
		t.Errorf("placement only = %d %v", rec.Code, fake.LastUpdateModel)
	}
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{"placement": {"matchLabels": {"ai-grid/enabled": "true"}}, "rollout": {"strategy": "All", "progressDeadline": "10m"}}`), `"9"`))
	req = fake.LastUpdateModel
	if rec.Code != http.StatusOK || strings.Join(req.GetUpdateMask().GetPaths(), ",") != "spec.placement,spec.rollout" || req.GetObject().GetSpec().GetPlacement().GetLabelSelector().GetMatchLabels()["ai-grid/enabled"] != "true" || req.GetObject().GetSpec().GetRollout().GetProgressDeadline() != "10m" {
		t.Errorf("placement update = %d %v", rec.Code, req)
	}
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{"placement": null}`), `"10"`))
	if rec.Code != http.StatusOK || fake.LastUpdateModel.GetObject().GetSpec().GetPlacement() != nil || strings.Join(fake.LastUpdateModel.GetUpdateMask().GetPaths(), ",") != "spec.placement" {
		t.Errorf("placement: null removes it: %d %v", rec.Code, fake.LastUpdateModel)
	}

	// An empty body is 422 and calls nothing, so a stale If-Match is never
	// answered with the current object.
	fake.Calls = nil
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{}`), `"1"`))
	if rec.Code != http.StatusUnprocessableEntity || len(fake.Calls) != 0 || decodeError(t, rec).Error.Message != "the request body names no field to change" {
		t.Errorf("empty patch = %d %s, calls %v", rec.Code, rec.Body.String(), fake.Calls)
	}
	fake.Calls = nil
	for _, tc := range []struct{ body, message string }{
		{`{"nope": 1}`, `invalid request body: json: unknown field "nope"`},
		// The display name and description are annotation keys now.
		{`{"displayName": "Tiny"}`, `invalid request body: json: unknown field "displayName"`},
		{`{"replicas": "2"}`, `invalid request body: field "replicas" must be a whole number`},
		{`{"description": "x"}`, `invalid request body: json: unknown field "description"`},
		{`{"rollout": {"strategy": "Blue"}}`, "rollout.strategy must be All, Progressive or ProgressivePerGroup"},
		{`{"placement": {"nope": 1}}`, `invalid request body: json: unknown field "nope"`},
		// A nested field is named by its whole path, as on POST.
		{`{"placement": {"clusterSets": "x"}}`, `invalid request body: field "placement.clusterSets" must be an array`},
		// Go 1.27 names an array element by its index; Go 1.26 (the CI toolchain) leaves it out.
		{`{"placement": {"matchExpressions": [{"values": "x"}]}}`, `invalid request body: field "placement.matchExpressions.0.values" must be an array|invalid request body: field "placement.matchExpressions.values" must be an array`},
	} {
		rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, tc.body), `"11"`))
		if rec.Code != http.StatusUnprocessableEntity || !slices.Contains(strings.Split(tc.message, "|"), decodeError(t, rec).Error.Message) {
			t.Errorf("%s: %d %s", tc.body, rec.Code, rec.Body.String())
		}
	}
	if len(fake.Calls) != 0 {
		t.Errorf("invalid patches reached the backend: %v", fake.Calls)
	}
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/models/ai-grid-models/nope", `{"replicas": 1}`), `"1"`))
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown model = %d", rec.Code)
	}
	// A write that landed since the client read is the backend's Aborted, 409.
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{"replicas": 4}`), `"10"`))
	if rec.Code != http.StatusConflict || !strings.Contains(decodeError(t, rec).Error.Message, `carries "10"`) {
		t.Errorf("stale write = %d %s", rec.Code, rec.Body.String())
	}
}

func TestDeleteModel(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels()}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/models/team-b/other"), `"3"`))
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 || fake.LastDeleteModel.GetNamespace() != "team-b" || fake.LastDeleteModel.GetName() != "other" {
		t.Errorf("delete = %d %q %v", rec.Code, rec.Body.String(), fake.LastDeleteModel)
	}
	if rec := serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/models/team-b/other"), `"3"`)); rec.Code != http.StatusNotFound {
		t.Errorf("second delete = %d", rec.Code)
	}
	fake.Errs = map[string]error{"DeleteModel": backendtest.Status(codes.FailedPrecondition, "model ai-grid-models/tiny-llm is referenced by subscription acme/gold; remove those references first")}
	rec = serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/models/ai-grid-models/tiny-llm"), `"7"`))
	if rec.Code != http.StatusPreconditionFailed || !strings.Contains(decodeError(t, rec).Error.Message, "referenced by") {
		t.Errorf("referenced = %d %s", rec.Code, rec.Body.String())
	}
}

func TestCapabilities(t *testing.T) {
	fake := &backendtest.Fake{}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, asUser(http.MethodGet, "/api/v1/capabilities"))
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("today's backend has no GetHubCapabilities: %d %s", rec.Code, rec.Body.String())
	}
	fake.Capabilities = &aigridv1.HubCapabilities{ManifestWorkReplicaSetEnabled: false, ObservabilityInstalled: true, AcmVersion: "2.17.3"}
	rec = serve(app, asUser(http.MethodGet, "/api/v1/capabilities"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var c Capabilities
	decodeData(t, rec, &c)
	if c.ManifestWorkReplicaSetEnabled || !c.ObservabilityInstalled || c.ACMVersion != "2.17.3" {
		t.Errorf("capabilities = %+v", c)
	}
	if !strings.Contains(rec.Body.String(), `"manifestWorkReplicaSetEnabled":false`) {
		t.Errorf("false is serialised, not omitted: %s", rec.Body.String())
	}
}

func TestModelFromTodaysShapes(t *testing.T) {
	// A model without status, scaling or router renders with empty collections
	// and the name as model name, never nulls.
	m := toModel(&aigridv1.Model{Name: "bare", Metadata: &aigridv1.ObjectMeta{Namespace: "ns"}, Spec: &aigridv1.ModelSpec{Model: &aigridv1.ModelSource{Uri: "hf://x"}}})
	if m.ModelName != "bare" || m.Phase != "" || m.BaseRefs == nil || m.Requests == nil || m.Limits == nil || m.Env == nil || m.Gateways == nil || m.Addresses == nil || m.Conditions == nil || m.AppliedConfigs == nil || m.Labels == nil || m.Annotations == nil || m.Placement != nil {
		t.Errorf("bare = %+v", m)
	}
	// A placed model whose backend sent no rollout status still has a
	// placement with empty collections.
	m = toModel(&aigridv1.Model{Name: "p", Metadata: &aigridv1.ObjectMeta{Namespace: "ns"}, Spec: &aigridv1.ModelSpec{Placement: &aigridv1.Placement{}}})
	if m.Placement == nil || m.Placement.SelectedClusters == nil || m.Placement.Locations == nil || m.Placement.Conditions == nil || m.Rollout == nil || m.Rollout.Works == nil || m.Rollout.Strategy != StrategyAll {
		t.Errorf("placed = %+v", m)
	}
}

func TestModelVersions(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels()}
	app := newTestApp(t, testConfig(t), fake)
	const path = "/api/v1/models/ai-grid-models/tiny-llm"

	if rec := serve(app, asUser(http.MethodGet, path)); rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"7"` {
		t.Fatalf("GET = %d, ETag %q", rec.Code, rec.Header().Get("ETag"))
	}
	rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, path, `{"replicas": 2}`), `"6"`))
	if rec.Code != http.StatusConflict || !fake.LastUpdateModel.GetLock() || fake.LastUpdateModel.GetObject().GetMetadata().GetResourceVersion() != "6" {
		t.Fatalf("stale PATCH = %d %s, request %v", rec.Code, rec.Body.String(), fake.LastUpdateModel)
	}
	if fake.Models[0].GetSpec().GetReplicas() != 1 {
		t.Errorf("a stale write must not land")
	}
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, path, `{"replicas": 2}`), `"7"`))
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"8"` {
		t.Fatalf("matching PATCH = %d, ETag %q", rec.Code, rec.Header().Get("ETag"))
	}
	rec = serve(app, withIfMatch(asUser(http.MethodDelete, path), `"7"`))
	if rec.Code != http.StatusConflict || fake.LastDeleteModel.GetResourceVersion() != "7" || len(fake.Models) != 3 {
		t.Fatalf("stale DELETE = %d %s", rec.Code, rec.Body.String())
	}
	if rec := serve(app, withIfMatch(asUser(http.MethodDelete, path), `"8"`)); rec.Code != http.StatusNoContent || len(fake.Models) != 2 {
		t.Errorf("matching DELETE = %d", rec.Code)
	}
	if rec := serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/models/team-b/other"), `W/"3"`)); rec.Code != http.StatusUnprocessableEntity || len(fake.Models) != 2 {
		t.Errorf("weak If-Match on DELETE = %d", rec.Code)
	}
	fake.Calls = nil
	if rec := serve(app, asUser(http.MethodDelete, "/api/v1/models/team-b/other")); rec.Code != http.StatusPreconditionRequired || len(fake.Calls) != 0 || len(fake.Models) != 2 {
		t.Errorf("DELETE without If-Match = %d, calls %v; want 428 and no call", rec.Code, fake.Calls)
	}
}

// Resending what the page loaded goes to the backend with every present
// path; the backend sees that nothing changes and keeps the version.
func TestRepeatedModelPatchReachesTheBackend(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels()}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/models/ai-grid-models/tiny-llm", `{"replicas": 1, "env": [{"name": "VLLM_CPU_KVCACHE_SPACE", "value": "8"}], "labels": {"ai-grid/family": "tiny"}}`), `"7"`))
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"7"` || strings.Join(fake.LastUpdateModel.GetUpdateMask().GetPaths(), ",") != "spec.replicas,spec.main.env,metadata.labels" {
		t.Errorf("repeat = %d, ETag %q, mask %v", rec.Code, rec.Header().Get("ETag"), fake.LastUpdateModel.GetUpdateMask().GetPaths())
	}
}

func TestModelFilterOnTheShippedBackend(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels(), ShippedLists: true}
	app := newTestApp(t, testConfig(t), fake)
	for _, q := range []string{"filter=" + url.QueryEscape(`this.metadata.namespace == "team-b"`), "limit=1", "offset=2"} {
		rec := serve(app, asUser(http.MethodGet, "/api/v1/models?"+q))
		if rec.Code != http.StatusNotImplemented || !strings.Contains(decodeError(t, rec).Error.Message, "filtering or paging models") {
			t.Errorf("%s = %d %s, want 501", q, rec.Code, rec.Body.String())
		}
	}
	var list []Model
	rec := serve(app, asUser(http.MethodGet, "/api/v1/models"))
	if meta := decodeList(t, rec, &list); rec.Code != http.StatusOK || len(list) != 3 || total(meta) != 3 {
		t.Errorf("unfiltered = %d, %d models, meta %+v", rec.Code, len(list), meta)
	}
}

// Every present field goes in the mask, also for a model whose backend sent
// no spec: the BFF has nothing to compare with.
func TestPatchModelSendsEveryPresentField(t *testing.T) {
	fake := &backendtest.Fake{Models: []*aigridv1.Model{{Name: "bare", Metadata: &aigridv1.ObjectMeta{Namespace: "ns", ResourceVersion: "1"}}}}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/models/ns/bare", `{"replicas": 1, "runtimeImage": "img", "env": [], "placement": null, "rollout": {}, "labels": {}, "annotations": {}}`), `"1"`))
	if rec.Code != http.StatusOK || strings.Join(fake.LastUpdateModel.GetUpdateMask().GetPaths(), ",") != "spec.replicas,spec.main.image,spec.main.env,spec.placement,spec.rollout,metadata.labels,metadata.annotations" {
		t.Errorf("bare model = %d %s, mask %v", rec.Code, rec.Body.String(), fake.LastUpdateModel.GetUpdateMask().GetPaths())
	}
}

// The display name and description travel as annotations on create too,
// so a client sets them one way on both POST and PATCH.
func TestCreateModelTakesNoDisplayNameField(t *testing.T) {
	fake := &backendtest.Fake{Models: seedModels()}
	app := newTestApp(t, testConfig(t), fake)
	for _, field := range []string{"displayName", "description"} {
		body := `{"name": "m", "namespace": "ai-grid-models", "modelUri": "hf://example-org/m", "` + field + `": "x"}`
		rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/models", body))
		if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != `invalid request body: json: unknown field "`+field+`"` || fake.Reached("CreateModel") {
			t.Errorf("%s on create = %d %s", field, rec.Code, rec.Body.String())
		}
	}
}

// TestModelWithoutSpec: a model the backend sends without a spec (as a
// subscription's referenced model can be) maps instead of panicking into a 500.
func TestModelWithoutSpec(t *testing.T) {
	got := toModel(&aigridv1.Model{Name: "bare", Metadata: &aigridv1.ObjectMeta{Namespace: "ai-grid-models"}})
	if got.Name != "bare" || got.Replicas != nil {
		t.Fatalf("model %+v", got)
	}
}

// TestListLocations: GET /api/v1/locations passes ListLocations through.
func TestListLocations(t *testing.T) {
	fake := &backendtest.Fake{Locations: []string{"madrid", "paris"}}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, asUser(http.MethodGet, "/api/v1/locations"))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"data":["madrid","paris"]}` {
		t.Fatalf("locations: %d %s", rec.Code, rec.Body)
	}
	fake.Locations = nil
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/locations")); rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"data":[]}` {
		t.Fatalf("no locations: %d %s", rec.Code, rec.Body)
	}
}

// Each work's phase, reason and message, and a partially available model,
// pass through as the backend derived them (proposal P13).
func TestModelWorkPhasesPassThrough(t *testing.T) {
	m := &aigridv1.Model{
		Name:     "m",
		Metadata: &aigridv1.ObjectMeta{Namespace: "ai-grid-models"},
		Spec:     &aigridv1.ModelSpec{Placement: &aigridv1.Placement{}},
		Status: &aigridv1.ModelStatus{
			Phase: aigridv1.ModelPhase_MODEL_PHASE_PARTIALLY_AVAILABLE, Reason: "PartiallyAvailable", Message: "1 of 2 clusters are serving the model.",
			Rollout: &aigridv1.RolloutStatus{Works: []*aigridv1.ManifestWorkStatus{
				{ClusterName: "site-a", Phase: aigridv1.ModelPhase_MODEL_PHASE_READY},
				{ClusterName: "site-b", Phase: aigridv1.ModelPhase_MODEL_PHASE_FAILED, Reason: "AppliedManifestWorkFailed", Message: "Failed to apply manifest work"},
			}},
		},
	}
	out := toModel(m)
	if out.Phase != PhasePartiallyAvailable || out.Message != "1 of 2 clusters are serving the model." {
		t.Errorf("model phase %q, message %q", out.Phase, out.Message)
	}
	a, b := out.Rollout.Works[0], out.Rollout.Works[1]
	if a.Phase != PhaseReady || a.Reason != "" || b.Phase != PhaseFailed || b.Reason != "AppliedManifestWorkFailed" || b.Message != "Failed to apply manifest work" {
		t.Errorf("works = %+v, %+v", a, b)
	}
}
