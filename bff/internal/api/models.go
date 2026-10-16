package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Models are KServe LLMInferenceServices, optionally fanned out to managed
// clusters by an ACM Placement and a ManifestWorkReplicaSet. The JSON is close
// to the POC's ManagedModel (mock/research/models-maas.md 7.2) but carries only
// what the real objects carry: no `revision`, no `status: Saved`, no
// `hasDeployment`; the phase is the backend's derivation from the real
// conditions, and the per-site state comes from the generated ManifestWorks.

// Annotations the display name and description live in (the OpenShift
// convention the POC and the ODH dashboard use).
const (
	AnnotationDisplayName = "openshift.io/display-name"
	AnnotationDescription = "openshift.io/description"
)

// Resource names of the main container (`resources.requests`/`limits`).
const (
	ResourceCPU    = "cpu"
	ResourceMemory = "memory"
	ResourceGPU    = "nvidia.com/gpu"
)

// The product-default Gateway the console attaches a model to
// (`openshift-ingress/openshift-ai-inference`, the name RHOAI installs for
// KServe; mock/research/models-maas.md 1). A name, not a claim that any given
// hub has it.
const (
	DefaultGatewayName      = "openshift-ai-inference"
	DefaultGatewayNamespace = "openshift-ingress"
)

// Model phases, lowercase like the cluster statuses.
const (
	PhasePending = "pending"
	PhaseReady   = "ready"
	PhaseFailed  = "failed"
)

// Rollout strategy names as the CRD spells them.
const (
	StrategyAll                 = "All"
	StrategyProgressive         = "Progressive"
	StrategyProgressivePerGroup = "ProgressivePerGroup"
)

// Field-mask paths of UpdateModel.
const (
	maskReplicas    = "spec.replicas"
	maskImage       = "spec.main.image"
	maskEnv         = "spec.main.env"
	maskPlacement   = "spec.placement"
	maskRollout     = "spec.rollout"
	maskLabels      = "metadata.labels"
	maskAnnotations = "metadata.annotations"
)

var phaseStrings = map[aigridv1.ModelPhase]string{
	aigridv1.ModelPhase_MODEL_PHASE_PENDING: PhasePending,
	aigridv1.ModelPhase_MODEL_PHASE_READY:   PhaseReady,
	aigridv1.ModelPhase_MODEL_PHASE_FAILED:  PhaseFailed,
}

var strategyStrings = map[aigridv1.RolloutStrategy]string{
	aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_ALL:                   StrategyAll,
	aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_PROGRESSIVE:           StrategyProgressive,
	aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_PROGRESSIVE_PER_GROUP: StrategyProgressivePerGroup,
}

var strategyEnums = map[string]aigridv1.RolloutStrategy{
	StrategyAll:                 aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_ALL,
	StrategyProgressive:         aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_PROGRESSIVE,
	StrategyProgressivePerGroup: aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_PROGRESSIVE_PER_GROUP,
}

// Model is a model as the console shows it.
type Model struct {
	Name        string `json:"name"`
	Namespace   string `json:"namespace"`
	DisplayName string `json:"displayName,omitempty"`
	Description string `json:"description,omitempty"`
	// ModelURI is `spec.model.uri`; ModelName the identifier clients send.
	ModelURI     string `json:"modelUri"`
	ModelName    string `json:"modelName"`
	RuntimeImage string `json:"runtimeImage,omitempty"`
	Runtime      string `json:"runtime,omitempty"`
	// Replicas is `spec.replicas`; absent when the model autoscales.
	Replicas *int32        `json:"replicas,omitempty"`
	Scaling  *ModelScaling `json:"scaling,omitempty"`
	BaseRefs []string      `json:"baseRefs"`
	// Requests and Limits are the main container's resources, quantity strings.
	Requests map[string]string `json:"requests"`
	Limits   map[string]string `json:"limits"`
	Env      []EnvVar          `json:"env"`
	Gateways []GatewayRef      `json:"gateways"`
	// Phase is pending|ready|failed, derived by the backend; Reason and
	// Message come from the condition that decided it.
	Phase   string `json:"phase,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	// URL and Addresses are set as soon as the controller has written the
	// managed route, before the deployment is Ready, and kept through a
	// restart (KServe updateRoutingStatus); a Gateway that does not exist
	// leaves both unset.
	URL            string             `json:"url,omitempty"`
	Addresses      []ModelAddress     `json:"addresses"`
	Conditions     []ClusterCondition `json:"conditions"`
	AppliedConfigs []AppliedConfig    `json:"appliedConfigs"`
	// Placement and Rollout are set for a model deployed to managed clusters.
	Placement         *ModelPlacement   `json:"placement,omitempty"`
	Rollout           *ModelRollout     `json:"rollout,omitempty"`
	Labels            map[string]string `json:"labels"`
	Annotations       map[string]string `json:"annotations"`
	ResourceVersion   string            `json:"resourceVersion,omitempty"`
	Generation        int64             `json:"generation,omitempty"`
	CreationTimestamp *time.Time        `json:"creationTimestamp,omitempty"`
	DeletionTimestamp *time.Time        `json:"deletionTimestamp,omitempty"`
}

// ModelScaling is `spec.scaling`: direct KEDA scaling between `minReplicas`
// and `maxReplicas`, driven by at least one trigger (the CRD's rules).
type ModelScaling struct {
	MinReplicas int32         `json:"minReplicas"`
	MaxReplicas int32         `json:"maxReplicas"`
	Triggers    []KedaTrigger `json:"triggers"`
}

// KedaTrigger is one `spec.scaling.keda.triggers[]` entry.
type KedaTrigger struct {
	Type     string            `json:"type"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

// EnvVar is one environment variable of the main container.
type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// GatewayRef is one `spec.router.gateway.refs[]` entry.
type GatewayRef struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// ModelAddress is one `status.addresses[]` entry.
type ModelAddress struct {
	Name   string   `json:"name"`
	URL    string   `json:"url"`
	Models []string `json:"models"`
}

// AppliedConfig is one `status.appliedConfigs[]` entry.
type AppliedConfig struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Source    string `json:"source"`
}

// MatchExpression is one label or claim requirement.
type MatchExpression struct {
	Key      string   `json:"key"`
	Operator string   `json:"operator"`
	Values   []string `json:"values,omitempty"`
}

// Toleration is one Placement toleration.
type Toleration struct {
	Key               string `json:"key"`
	Operator          string `json:"operator,omitempty"`
	Value             string `json:"value,omitempty"`
	Effect            string `json:"effect,omitempty"`
	TolerationSeconds *int64 `json:"tolerationSeconds,omitempty"`
}

// PlacementSpec is the Placement a request writes.
type PlacementSpec struct {
	ClusterSets      []string          `json:"clusterSets,omitempty"`
	MatchLabels      map[string]string `json:"matchLabels,omitempty"`
	MatchExpressions []MatchExpression `json:"matchExpressions,omitempty"`
	ClaimExpressions []MatchExpression `json:"claimExpressions,omitempty"`
	Tolerations      []Toleration      `json:"tolerations,omitempty"`
	NumberOfClusters *int32            `json:"numberOfClusters,omitempty"`
}

// ModelPlacement is the Placement with its decisions.
type ModelPlacement struct {
	PlacementSpec
	// SelectedClusters are the PlacementDecision's clusters, in name order.
	SelectedClusters []string `json:"selectedClusters"`
	// Locations are the decided clusters' `location` labels (P8), as the
	// backend reports them.
	Locations []string `json:"locations"`
	// Satisfied is `PlacementSatisfied`; Reason and Message are its reason and message.
	Satisfied  bool               `json:"satisfied"`
	Reason     string             `json:"reason,omitempty"`
	Message    string             `json:"message,omitempty"`
	Conditions []ClusterCondition `json:"conditions"`
}

// RolloutSpec is the rollout strategy a request writes.
type RolloutSpec struct {
	// Strategy is All, Progressive or ProgressivePerGroup; All when empty.
	Strategy         string `json:"strategy,omitempty"`
	MaxConcurrency   string `json:"maxConcurrency,omitempty"`
	MaxFailures      string `json:"maxFailures,omitempty"`
	ProgressDeadline string `json:"progressDeadline,omitempty"`
	MinSuccessTime   string `json:"minSuccessTime,omitempty"`
}

// RolloutSummary is the ManifestWorkReplicaSet's `status.summary`: counts of
// the works at the current template (a work still carrying an older template
// is not counted). The CRD also declares `desiredTotal` and `updated`, which
// the controller never writes, so they are not exposed.
type RolloutSummary struct {
	Total       int32 `json:"total"`
	Applied     int32 `json:"applied"`
	Available   int32 `json:"available"`
	Progressing int32 `json:"progressing"`
	Degraded    int32 `json:"degraded"`
}

// ModelRollout is the ManifestWorkReplicaSet with its works.
type ModelRollout struct {
	RolloutSpec
	Summary RolloutSummary `json:"summary"`
	// RolledOut is `PlacementRolledOut` True; Applied is `ManifestworkApplied`
	// True; Reason is `ManifestworkApplied`'s reason.
	RolledOut  bool               `json:"rolledOut"`
	Applied    bool               `json:"applied"`
	Reason     string             `json:"reason,omitempty"`
	Conditions []ClusterCondition `json:"conditions"`
	Works      []WorkStatus       `json:"works"`
}

// WorkStatus is one generated ManifestWork, the model's state on one site.
type WorkStatus struct {
	Cluster  string `json:"cluster"`
	WorkName string `json:"workName"`
	// Condition statuses as True|False|Unknown, absent when the agent has not
	// written the condition.
	Applied     string `json:"applied,omitempty"`
	Available   string `json:"available,omitempty"`
	Progressing string `json:"progressing,omitempty"`
	Degraded    string `json:"degraded,omitempty"`
	// Feedback is the `ready` and `url` the agent scraped from the spoke object.
	Feedback           WorkFeedback       `json:"feedback"`
	Conditions         []ClusterCondition `json:"conditions"`
	Generation         int64              `json:"generation"`
	ObservedGeneration int64              `json:"observedGeneration"`
}

// WorkFeedback is the scraped status of the spoke LLMInferenceService.
type WorkFeedback struct {
	Ready string `json:"ready,omitempty"`
	URL   string `json:"url,omitempty"`
}

// Capabilities is what GET /api/v1/capabilities returns.
type Capabilities struct {
	ManifestWorkReplicaSetEnabled bool   `json:"manifestWorkReplicaSetEnabled"`
	ObservabilityInstalled        bool   `json:"observabilityInstalled"`
	ACMVersion                    string `json:"acmVersion"`
}

func toConditions(conds []*aigridv1.Condition) []ClusterCondition {
	out := make([]ClusterCondition, 0, len(conds))
	for _, c := range conds {
		cond := ClusterCondition{Type: c.GetType(), Status: conditionStatusStrings[c.GetStatus()], Reason: c.GetReason(), Message: c.GetMessage()}
		if ts := c.GetLastTransitionTime(); ts != nil {
			t := ts.AsTime().UTC()
			cond.LastTransitionTime = &t
		}
		out = append(out, cond)
	}
	return out
}

// conditionString is the status of one condition, "" when absent.
func conditionString(conds []*aigridv1.Condition, typ string) string {
	for _, c := range conds {
		if c.GetType() == typ {
			return conditionStatusStrings[c.GetStatus()]
		}
	}
	return ""
}

func findCondition(conds []*aigridv1.Condition, typ string) *aigridv1.Condition {
	for _, c := range conds {
		if c.GetType() == typ {
			return c
		}
	}
	return nil
}

func toExpressions(reqs []*aigridv1.LabelSelectorRequirement) []MatchExpression {
	out := make([]MatchExpression, 0, len(reqs))
	for _, r := range reqs {
		out = append(out, MatchExpression{Key: r.GetKey(), Operator: r.GetOperator(), Values: r.GetValues()})
	}
	return out
}

func toClaimExpressions(reqs []*aigridv1.ClaimExpression) []MatchExpression {
	out := make([]MatchExpression, 0, len(reqs))
	for _, r := range reqs {
		out = append(out, MatchExpression{Key: r.GetKey(), Operator: r.GetOperator(), Values: r.GetValues()})
	}
	return out
}

func toPlacementSpec(p *aigridv1.Placement) PlacementSpec {
	spec := PlacementSpec{ClusterSets: p.GetClusterSets(), MatchLabels: p.GetLabelSelector().GetMatchLabels(),
		MatchExpressions: toExpressions(p.GetLabelSelector().GetMatchExpressions()), ClaimExpressions: toClaimExpressions(p.GetClaimExpressions())}
	for _, t := range p.GetTolerations() {
		tol := Toleration{Key: t.GetKey(), Operator: t.GetOperator(), Value: t.GetValue(), Effect: t.GetEffect()}
		if t.TolerationSeconds != nil {
			tol.TolerationSeconds = proto.Int64(t.GetTolerationSeconds())
		}
		spec.Tolerations = append(spec.Tolerations, tol)
	}
	if p.NumberOfClusters != nil {
		spec.NumberOfClusters = proto.Int32(p.GetNumberOfClusters())
	}
	return spec
}

func toRolloutSpec(r *aigridv1.Rollout) RolloutSpec {
	strategy := strategyStrings[r.GetStrategy()]
	if strategy == "" {
		strategy = StrategyAll
	}
	return RolloutSpec{Strategy: strategy, MaxConcurrency: r.GetMaxConcurrency(), MaxFailures: r.GetMaxFailures(), ProgressDeadline: r.GetProgressDeadline(), MinSuccessTime: r.GetMinSuccessTime()}
}

func toModel(m *aigridv1.Model) Model {
	meta, spec, st := m.GetMetadata(), m.GetSpec(), m.GetStatus()
	annotations := copyMap(meta.GetAnnotations())
	out := Model{
		Name: m.GetName(), Namespace: meta.GetNamespace(),
		DisplayName: annotations[AnnotationDisplayName], Description: annotations[AnnotationDescription],
		ModelURI: spec.GetModel().GetUri(), ModelName: spec.GetModel().GetName(),
		RuntimeImage: spec.GetMain().GetImage(), Runtime: spec.GetRuntime(),
		BaseRefs: spec.GetBaseRefs(), Requests: copyMap(spec.GetMain().GetRequests()), Limits: copyMap(spec.GetMain().GetLimits()),
		Env: []EnvVar{}, Gateways: []GatewayRef{},
		Phase: phaseStrings[st.GetPhase()], Reason: st.GetReason(), Message: st.GetMessage(), URL: st.GetUrl(),
		Addresses: []ModelAddress{}, Conditions: toConditions(st.GetConditions()), AppliedConfigs: []AppliedConfig{},
		Labels: copyMap(meta.GetLabels()), Annotations: annotations,
		ResourceVersion: meta.GetResourceVersion(), Generation: meta.GetGeneration(),
	}
	if out.BaseRefs == nil {
		out.BaseRefs = []string{}
	}
	if out.ModelName == "" {
		out.ModelName = out.Name // the KServe default
	}
	if spec != nil && spec.Replicas != nil {
		out.Replicas = proto.Int32(spec.GetReplicas())
	}
	if sc := spec.GetScaling(); sc != nil {
		out.Scaling = &ModelScaling{MinReplicas: sc.GetMinReplicas(), MaxReplicas: sc.GetMaxReplicas(), Triggers: []KedaTrigger{}}
		for _, t := range sc.GetTriggers() {
			out.Scaling.Triggers = append(out.Scaling.Triggers, KedaTrigger{Type: t.GetType(), Metadata: copyMap(t.GetMetadata())})
		}
	}
	for _, e := range spec.GetMain().GetEnv() {
		out.Env = append(out.Env, EnvVar{Name: e.GetName(), Value: e.GetValue()})
	}
	for _, g := range spec.GetRouter().GetGatewayRefs() {
		out.Gateways = append(out.Gateways, GatewayRef{Name: g.GetName(), Namespace: g.GetNamespace()})
	}
	for _, a := range st.GetAddresses() {
		models := a.GetModels()
		if models == nil {
			models = []string{}
		}
		out.Addresses = append(out.Addresses, ModelAddress{Name: a.GetName(), URL: a.GetUrl(), Models: models})
	}
	for _, c := range st.GetAppliedConfigs() {
		out.AppliedConfigs = append(out.AppliedConfigs, AppliedConfig{Name: c.GetName(), Namespace: c.GetNamespace(), Source: c.GetSource()})
	}
	if ts := meta.GetCreationTimestamp(); ts != nil {
		t := ts.AsTime().UTC()
		out.CreationTimestamp = &t
	}
	if ts := meta.GetDeletionTimestamp(); ts != nil {
		t := ts.AsTime().UTC()
		out.DeletionTimestamp = &t
	}
	if p := spec.GetPlacement(); p != nil {
		ps := st.GetPlacement()
		placement := &ModelPlacement{PlacementSpec: toPlacementSpec(p), SelectedClusters: []string{}, Locations: append([]string{}, ps.GetLocations()...), Conditions: toConditions(ps.GetConditions())}
		for _, d := range ps.GetDecisions() {
			placement.SelectedClusters = append(placement.SelectedClusters, d.GetClusterName())
		}
		if sat := findCondition(ps.GetConditions(), "PlacementSatisfied"); sat != nil {
			placement.Satisfied = sat.GetStatus() == aigridv1.ConditionStatus_CONDITION_STATUS_TRUE
			placement.Reason, placement.Message = sat.GetReason(), sat.GetMessage()
		}
		out.Placement = placement
		rs := st.GetRollout()
		rollout := &ModelRollout{RolloutSpec: toRolloutSpec(spec.GetRollout()), Conditions: toConditions(rs.GetConditions()), Works: []WorkStatus{}}
		if sum := rs.GetSummary(); sum != nil {
			rollout.Summary = RolloutSummary{Total: sum.GetTotal(), Applied: sum.GetApplied(), Available: sum.GetAvailable(), Progressing: sum.GetProgressing(), Degraded: sum.GetDegraded()}
		}
		rollout.RolledOut = conditionString(rs.GetConditions(), "PlacementRolledOut") == "True"
		if applied := findCondition(rs.GetConditions(), "ManifestworkApplied"); applied != nil {
			rollout.Applied = applied.GetStatus() == aigridv1.ConditionStatus_CONDITION_STATUS_TRUE
			rollout.Reason = applied.GetReason()
		}
		for _, w := range rs.GetWorks() {
			ws := WorkStatus{Cluster: w.GetClusterName(), WorkName: w.GetWorkName(),
				Applied: conditionString(w.GetConditions(), "Applied"), Available: conditionString(w.GetConditions(), "Available"),
				Progressing: conditionString(w.GetConditions(), "Progressing"), Degraded: conditionString(w.GetConditions(), "Degraded"),
				Conditions: toConditions(w.GetConditions()), Generation: w.GetGeneration(), ObservedGeneration: w.GetObservedGeneration()}
			for _, mf := range w.GetManifests() {
				for _, fb := range mf.GetFeedback() {
					switch fb.GetName() {
					case "ready":
						ws.Feedback.Ready = fb.GetValue()
					case "url":
						ws.Feedback.URL = fb.GetValue()
					}
				}
			}
			rollout.Works = append(rollout.Works, ws)
		}
		out.Rollout = rollout
	}
	return out
}

// fromPlacementSpec builds the proto Placement.
func fromPlacementSpec(p *PlacementSpec) *aigridv1.Placement {
	out := &aigridv1.Placement{ClusterSets: p.ClusterSets, LabelSelector: &aigridv1.LabelSelector{MatchLabels: p.MatchLabels}}
	for _, e := range p.MatchExpressions {
		out.LabelSelector.MatchExpressions = append(out.LabelSelector.MatchExpressions, &aigridv1.LabelSelectorRequirement{Key: e.Key, Operator: e.Operator, Values: e.Values})
	}
	for _, e := range p.ClaimExpressions {
		out.ClaimExpressions = append(out.ClaimExpressions, &aigridv1.ClaimExpression{Key: e.Key, Operator: e.Operator, Values: e.Values})
	}
	for _, t := range p.Tolerations {
		tol := &aigridv1.Toleration{Key: t.Key, Operator: t.Operator, Value: t.Value, Effect: t.Effect}
		if t.TolerationSeconds != nil {
			tol.TolerationSeconds = proto.Int64(*t.TolerationSeconds)
		}
		out.Tolerations = append(out.Tolerations, tol)
	}
	if p.NumberOfClusters != nil {
		out.NumberOfClusters = proto.Int32(*p.NumberOfClusters)
	}
	return out
}

// fromRolloutSpec builds the proto Rollout; an unknown strategy is 422.
func fromRolloutSpec(r *RolloutSpec) (*aigridv1.Rollout, error) {
	strategy := aigridv1.RolloutStrategy_ROLLOUT_STRATEGY_ALL
	if r.Strategy != "" {
		s, ok := strategyEnums[r.Strategy]
		if !ok {
			return nil, Errorf(http.StatusUnprocessableEntity, fmt.Sprintf("rollout.strategy must be %s, %s or %s", StrategyAll, StrategyProgressive, StrategyProgressivePerGroup))
		}
		strategy = s
	}
	return &aigridv1.Rollout{Strategy: strategy, MaxConcurrency: r.MaxConcurrency, MaxFailures: r.MaxFailures, ProgressDeadline: r.ProgressDeadline, MinSuccessTime: r.MinSuccessTime}, nil
}

func fromEnv(env []EnvVar) []*aigridv1.EnvVar {
	out := make([]*aigridv1.EnvVar, 0, len(env))
	for _, e := range env {
		out = append(out, &aigridv1.EnvVar{Name: e.Name, Value: e.Value})
	}
	return out
}

// listModels answers GET /api/v1/models?offset=&limit=&filter=: the backend
// evaluates `filter` (listFilter) and returns the models by namespace and
// name.
func (a *App) listModels(w http.ResponseWriter, r *http.Request) {
	offset, err := queryInt(r, "offset")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	limit, err := queryInt(r, "limit")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	filter, err := listFilter(r, "namespace", "label")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	req := &aigridv1.ListModelsRequest{Filter: filter}
	if offset != nil {
		req.Offset = proto.Int32(int32(*offset))
	}
	if limit != nil {
		req.Limit = proto.Int32(int32(*limit))
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Models.ListModels(ctx, req)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	// The same rule as for tenants: no `total` means the backend did not
	// honour the filter or the page, so a filtered or paged request is 501.
	if err := requireTotal(pagedOrFiltered(offset, limit, req.Filter != nil), resp.Total, "models"); err != nil {
		a.respondError(w, r, err)
		return
	}
	out := make([]Model, 0, len(resp.GetItems()))
	for _, m := range resp.GetItems() {
		out = append(out, toModel(m))
	}
	writeList(w, http.StatusOK, out, listMeta(offset, limit, len(out), resp.Total))
}

// getModel answers GET /api/v1/models/{namespace}/{name}.
func (a *App) getModel(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Models.GetModel(ctx, &aigridv1.GetModelRequest{Namespace: r.PathValue("namespace"), Name: r.PathValue("name")})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	setETag(w, resp.GetObject().GetMetadata().GetResourceVersion())
	writeData(w, http.StatusOK, toModel(resp.GetObject()))
}

// ModelCreate is the body of POST /api/v1/models: the POC deploy wizard's
// inputs mapped to the LLMInferenceService spec (models-maas.md 7.3). The
// display name and description travel in `annotations`
// (`openshift.io/display-name`, `openshift.io/description`), as on PATCH.
// `cpu`, `memory` and `gpuCount` become the main container's requests (and
// the GPU its limit); `scaling` (exclusive with `replicas`) becomes a
// `spec.scaling.keda` block; `gateway` defaults to the hub's AI inference
// Gateway; the route and the scheduler are always managed.
type ModelCreate struct {
	Name         string            `json:"name"`
	Namespace    string            `json:"namespace"`
	ModelURI     string            `json:"modelUri"`
	ModelName    string            `json:"modelName"`
	RuntimeImage string            `json:"runtimeImage"`
	Runtime      string            `json:"runtime"`
	Replicas     *int32            `json:"replicas"`
	Scaling      *ModelScaling     `json:"scaling"`
	BaseRefs     []string          `json:"baseRefs"`
	CPU          string            `json:"cpu"`
	Memory       string            `json:"memory"`
	GPUCount     *int              `json:"gpuCount"`
	Env          []EnvVar          `json:"env"`
	Gateway      *GatewayRef       `json:"gateway"`
	Placement    *PlacementSpec    `json:"placement"`
	Rollout      *RolloutSpec      `json:"rollout"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
}

// createModel answers POST /api/v1/models: 201 with the model and a Location
// header. Validation is the backend's (the CRD's messages come back as 422,
// a taken name as 409, a disabled ManifestWorkReplicaSet gate as 412).
func (a *App) createModel(w http.ResponseWriter, r *http.Request) {
	var body ModelCreate
	if err := decodeBody(w, r, &body); err != nil {
		a.respondError(w, r, err)
		return
	}
	if body.GPUCount != nil && *body.GPUCount < 0 {
		a.respondError(w, r, Errorf(http.StatusUnprocessableEntity, "gpuCount must not be negative"))
		return
	}
	annotations := copyMap(body.Annotations)
	main := &aigridv1.Container{Image: body.RuntimeImage, Requests: map[string]string{}, Limits: map[string]string{}, Env: fromEnv(body.Env)}
	if body.CPU != "" {
		main.Requests[ResourceCPU] = body.CPU
	}
	if body.Memory != "" {
		main.Requests[ResourceMemory] = body.Memory
	}
	if body.GPUCount != nil && *body.GPUCount > 0 {
		gpu := fmt.Sprint(*body.GPUCount)
		main.Requests[ResourceGPU], main.Limits[ResourceGPU] = gpu, gpu
	}
	gateway := &aigridv1.GatewayRef{Name: DefaultGatewayName, Namespace: DefaultGatewayNamespace}
	if body.Gateway != nil {
		gateway = &aigridv1.GatewayRef{Name: body.Gateway.Name, Namespace: body.Gateway.Namespace}
	}
	obj := &aigridv1.Model{
		Name:     body.Name,
		Metadata: &aigridv1.ObjectMeta{Namespace: body.Namespace, Labels: copyMap(body.Labels), Annotations: annotations},
		Spec: &aigridv1.ModelSpec{
			Model:    &aigridv1.ModelSource{Uri: body.ModelURI, Name: body.ModelName},
			Replicas: body.Replicas,
			BaseRefs: body.BaseRefs,
			Runtime:  body.Runtime,
			Router:   &aigridv1.Router{GatewayRefs: []*aigridv1.GatewayRef{gateway}, ManagedRoute: true, Scheduler: true},
			Main:     main,
		},
	}
	if body.Scaling != nil {
		obj.Spec.Scaling = &aigridv1.Scaling{MinReplicas: body.Scaling.MinReplicas, MaxReplicas: body.Scaling.MaxReplicas, Keda: true}
		for _, t := range body.Scaling.Triggers {
			obj.Spec.Scaling.Triggers = append(obj.Spec.Scaling.Triggers, &aigridv1.KedaTrigger{Type: t.Type, Metadata: t.Metadata})
		}
	}
	if body.Placement != nil {
		obj.Spec.Placement = fromPlacementSpec(body.Placement)
	}
	if body.Rollout != nil {
		rollout, err := fromRolloutSpec(body.Rollout)
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		obj.Spec.Rollout = rollout
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Models.CreateModel(ctx, &aigridv1.CreateModelRequest{Object: obj})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	m := toModel(resp.GetObject())
	a.logger.Info("model created", "namespace", m.Namespace, "name", m.Name, "placed", m.Placement != nil)
	w.Header().Set("Location", APIPrefix+"/models/"+url.PathEscape(m.Namespace)+"/"+url.PathEscape(m.Name))
	setETag(w, m.ResourceVersion)
	writeData(w, http.StatusCreated, m)
}

// optionalPlacement tells apart absent, null (remove the placement) and an object.
type optionalPlacement struct {
	Set   bool
	Value *PlacementSpec
}

func (o *optionalPlacement) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		return nil
	}
	var v PlacementSpec
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// ModelPatch is the body of PATCH /api/v1/models/{namespace}/{name}. Every
// field is optional and an absent field is left alone; a present field
// replaces the stored one as a whole (`env: []` removes every variable,
// `placement: null` makes the model a hub deployment again, `labels` and
// `annotations` are whole maps). The display name and description are the
// `openshift.io/display-name` and `openshift.io/description` keys of
// `annotations`, which the client edits like any other key.
type ModelPatch struct {
	Replicas     *int32             `json:"replicas"`
	RuntimeImage *string            `json:"runtimeImage"`
	Env          *[]EnvVar          `json:"env"`
	Placement    optionalPlacement  `json:"placement"`
	Rollout      *RolloutSpec       `json:"rollout"`
	Labels       *map[string]string `json:"labels"`
	Annotations  *map[string]string `json:"annotations"`
}

// patchModel answers PATCH /api/v1/models/{namespace}/{name} with one
// UpdateModel: each present field goes into the object and its path into
// the mask, whatever the stored value (the backend skips an update that
// changes nothing, and drops a rollout whose placement goes), under
// optimistic locking on the If-Match version the client must send
// (requireIfMatch), so a stale tab or a concurrent change surfaces as 409.
// The BFF does not read the model first. A body that names no field is
// 422.
func (a *App) patchModel(w http.ResponseWriter, r *http.Request) {
	namespace, name := r.PathValue("namespace"), r.PathValue("name")
	if err := requireJSON(r); err != nil {
		a.respondError(w, r, err)
		return
	}
	expected, err := requireIfMatch(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var patch ModelPatch
	if err := decodeBody(w, r, &patch); err != nil {
		a.respondError(w, r, err)
		return
	}
	obj := &aigridv1.Model{Name: name, Metadata: &aigridv1.ObjectMeta{Namespace: namespace, ResourceVersion: expected}, Spec: &aigridv1.ModelSpec{Main: &aigridv1.Container{}}}
	var paths []string
	if patch.Replicas != nil {
		obj.Spec.Replicas = proto.Int32(*patch.Replicas)
		paths = append(paths, maskReplicas)
	}
	if patch.RuntimeImage != nil {
		obj.Spec.Main.Image = *patch.RuntimeImage
		paths = append(paths, maskImage)
	}
	if patch.Env != nil {
		obj.Spec.Main.Env = fromEnv(*patch.Env)
		paths = append(paths, maskEnv)
	}
	if patch.Placement.Set {
		if patch.Placement.Value != nil {
			obj.Spec.Placement = fromPlacementSpec(patch.Placement.Value)
		}
		paths = append(paths, maskPlacement)
	}
	if patch.Rollout != nil {
		rollout, err := fromRolloutSpec(patch.Rollout)
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		obj.Spec.Rollout = rollout
		paths = append(paths, maskRollout)
	}
	if patch.Labels != nil {
		obj.Metadata.Labels = *patch.Labels
		paths = append(paths, maskLabels)
	}
	if patch.Annotations != nil {
		obj.Metadata.Annotations = *patch.Annotations
		paths = append(paths, maskAnnotations)
	}
	if len(paths) == 0 {
		a.respondError(w, r, Errorf(http.StatusUnprocessableEntity, "the request body names no field to change"))
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	updated, err := a.backend.Models.UpdateModel(ctx, &aigridv1.UpdateModelRequest{Object: obj, UpdateMask: &fieldmaskpb.FieldMask{Paths: paths}, Lock: true})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	a.logger.Info("model updated", "namespace", namespace, "name", name, "paths", paths)
	setETag(w, updated.GetObject().GetMetadata().GetResourceVersion())
	writeData(w, http.StatusOK, toModel(updated.GetObject()))
}

// deleteModel answers DELETE /api/v1/models/{namespace}/{name} with 204; 412
// while a catalog entry or a subscription references the model. The
// If-Match version (required, requireIfMatch) is the request's
// `resource_version` precondition: 409 when the model changed since.
func (a *App) deleteModel(w http.ResponseWriter, r *http.Request) {
	namespace, name := r.PathValue("namespace"), r.PathValue("name")
	expected, err := requireIfMatch(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	if _, err := a.backend.Models.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: namespace, Name: name, ResourceVersion: expected}); err != nil {
		a.respondError(w, r, err)
		return
	}
	a.logger.Info("model deleted", "namespace", namespace, "name", name)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// getCapabilities answers GET /api/v1/capabilities from
// `AiGrid/GetHubCapabilities`; a backend without the RPC yields 501, which the
// UI treats as "unknown" rather than as an error.
func (a *App) getCapabilities(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Health.GetHubCapabilities(ctx, &aigridv1.GetHubCapabilitiesRequest{})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	c := resp.GetCapabilities()
	writeData(w, http.StatusOK, Capabilities{ManifestWorkReplicaSetEnabled: c.GetManifestWorkReplicaSetEnabled(), ObservabilityInstalled: c.GetObservabilityInstalled(), ACMVersion: c.GetAcmVersion()})
}
