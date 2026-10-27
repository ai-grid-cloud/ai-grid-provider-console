package backend

// Stopgap: the backend's real Models RPCs behind the draft's ModelsClient, so
// the API handlers are unchanged.
//
// Two differences between the APIs shape this adapter:
//
//   - The backend's models have an id and no namespace: it keeps every model in
//     one namespace of its own. The draft's namespace is the BFF's configured
//     models namespace (--models-namespace), which reads give back and the other
//     calls require.
//   - A location is one cluster, and the backend's git mode places a model by
//     the ACM `name` label (backend PR 29's placement rules). So the backend's
//     ListLocations answers cluster names, and the console's placement (the member
//     labels plus `location In [...]`) is sent as `name In [...]`; a read turns
//     `name In [...]` back into the console's shape. Any other placement is sent
//     as it is, and the backend decides.

import (
	"context"
	"slices"
	"strconv"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const (
	// labelClusterName is the label ACM sets on every ManagedCluster to its name.
	labelClusterName = "name"
	// labelLocation is the key the console's placement selects locations by.
	labelLocation = "location"
	// labelEnabled marks an AI Grid member cluster.
	labelEnabled = "ai-grid/enabled"
	// labelProvisioned is the other member label the console's placement carries.
	labelProvisioned = "ai-grid/provisioned"
)

type v1Models struct {
	conn      grpc.ClientConnInterface
	namespace string
}

var _ aigridv1.ModelsClient = v1Models{}

// ListModels forwards offset and limit. The backend's ModelsListRequest has a
// filter over its own field names (id, no namespace), so a draft filter is
// Unimplemented, and so is an order: the draft supports only its default.
func (c v1Models) ListModels(ctx context.Context, in *aigridv1.ListModelsRequest, opts ...grpc.CallOption) (*aigridv1.ListModelsResponse, error) {
	if in.Filter != nil || in.GetOrder() != "" {
		return nil, status.Error(codes.Unimplemented, "the backend's Models API does not take the console's filter or order")
	}
	resp := &backendv1.ModelsListResponse{}
	if err := c.conn.Invoke(ctx, methodModelsList, &backendv1.ModelsListRequest{Offset: in.Offset, Limit: in.Limit}, resp, opts...); err != nil {
		return nil, err
	}
	out := &aigridv1.ListModelsResponse{Size: resp.GetSize(), Total: proto.Int32(resp.GetTotal())}
	for _, m := range resp.GetItems() {
		out.Items = append(out.Items, c.fromV1(m))
	}
	return out, nil
}

func (c v1Models) GetModel(ctx context.Context, in *aigridv1.GetModelRequest, opts ...grpc.CallOption) (*aigridv1.GetModelResponse, error) {
	if err := c.inNamespace(in.GetNamespace(), in.GetName()); err != nil {
		return nil, err
	}
	resp := &backendv1.ModelsGetResponse{}
	if err := c.conn.Invoke(ctx, methodModelsGet, &backendv1.ModelsGetRequest{Id: in.GetName()}, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.GetModelResponse{Object: c.fromV1(resp.GetObject())}, nil
}

func (c v1Models) CreateModel(ctx context.Context, in *aigridv1.CreateModelRequest, opts ...grpc.CallOption) (*aigridv1.CreateModelResponse, error) {
	obj := in.GetObject()
	if obj.GetMetadata().GetNamespace() != c.namespace {
		return nil, status.Errorf(codes.InvalidArgument, "metadata.namespace must be %q, the namespace this backend keeps models in", c.namespace)
	}
	m, err := toV1Model(obj, 0)
	if err != nil {
		return nil, err
	}
	resp := &backendv1.ModelsCreateResponse{}
	if err := c.conn.Invoke(ctx, methodModelsCreate, &backendv1.ModelsCreateRequest{Object: m}, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.CreateModelResponse{Object: c.fromV1(resp.GetObject())}, nil
}

// UpdateModel sends the draft's mask as it is (both APIs name the same paths)
// and its resource_version as metadata.version.
func (c v1Models) UpdateModel(ctx context.Context, in *aigridv1.UpdateModelRequest, opts ...grpc.CallOption) (*aigridv1.UpdateModelResponse, error) {
	obj := in.GetObject()
	if err := c.inNamespace(obj.GetMetadata().GetNamespace(), obj.GetName()); err != nil {
		return nil, err
	}
	var version int32
	if in.GetLock() {
		v, err := v1Version(obj.GetMetadata().GetResourceVersion())
		if err != nil {
			return nil, err
		}
		version = v
	}
	m, err := toV1Model(obj, version)
	if err != nil {
		return nil, err
	}
	resp := &backendv1.ModelsUpdateResponse{}
	req := &backendv1.ModelsUpdateRequest{Object: m, UpdateMask: in.GetUpdateMask(), Lock: in.GetLock()}
	if err := c.conn.Invoke(ctx, methodModelsUpdate, req, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.UpdateModelResponse{Object: c.fromV1(resp.GetObject())}, nil
}

// DeleteModel sends the expected version; empty skips the check in both APIs
// (zero in the backend's).
func (c v1Models) DeleteModel(ctx context.Context, in *aigridv1.DeleteModelRequest, opts ...grpc.CallOption) (*aigridv1.DeleteModelResponse, error) {
	if err := c.inNamespace(in.GetNamespace(), in.GetName()); err != nil {
		return nil, err
	}
	req := &backendv1.ModelsDeleteRequest{Id: in.GetName()}
	if rv := in.GetResourceVersion(); rv != "" {
		v, err := v1DeleteVersion(rv)
		if err != nil {
			return nil, err
		}
		req.ResourceVersion = v
	}
	if err := c.conn.Invoke(ctx, methodModelsDelete, req, &backendv1.ModelsDeleteResponse{}, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.DeleteModelResponse{}, nil
}

// ListLocations passes the backend's Models/ListLocations through: the names
// of the members a model can run on (provisioned, Available, role inference
// or combined), which the console's placement selects by.
func (c v1Models) ListLocations(ctx context.Context, _ *aigridv1.ListLocationsRequest, opts ...grpc.CallOption) (*aigridv1.ListLocationsResponse, error) {
	resp := &backendv1.ModelsListLocationsResponse{}
	if err := c.conn.Invoke(ctx, methodModelsListLocations, &backendv1.ModelsListLocationsRequest{}, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.ListLocationsResponse{Locations: append([]string{}, resp.GetLocations()...)}, nil
}

// inNamespace answers the draft's NotFound for a model outside the configured
// namespace, which the backend can't hold.
func (c v1Models) inNamespace(namespace, name string) error {
	if namespace != c.namespace {
		return status.Errorf(codes.NotFound, "object with identifier '%s/%s' not found", namespace, name)
	}
	return nil
}

// toV1Model maps the draft's writable fields. Placement fields the backend
// lacks (claim expressions, tolerations, spread constraints) are Unimplemented.
func toV1Model(m *aigridv1.Model, version int32) (*backendv1.Model, error) {
	meta, spec := m.GetMetadata(), m.GetSpec()
	out := &backendv1.Model{
		Id:       m.GetName(),
		Metadata: &backendv1.Metadata{Name: m.GetName(), Labels: meta.GetLabels(), Annotations: meta.GetAnnotations(), Version: version},
	}
	if spec == nil {
		return out, nil
	}
	out.Spec = &backendv1.ModelSpec{
		Replicas: spec.Replicas,
		BaseRefs: spec.GetBaseRefs(),
		Runtime:  spec.GetRuntime(),
	}
	if src := spec.GetModel(); src != nil {
		out.Spec.Model = &backendv1.ModelSource{Uri: src.GetUri(), Name: src.GetName()}
	}
	if r := spec.GetRouter(); r != nil {
		out.Spec.Router = &backendv1.ModelRouter{ManagedRoute: r.GetManagedRoute(), Scheduler: r.GetScheduler()}
		for _, g := range r.GetGatewayRefs() {
			out.Spec.Router.GatewayRefs = append(out.Spec.Router.GatewayRefs, &backendv1.ModelGatewayRef{Name: g.GetName(), Namespace: g.GetNamespace(), SectionName: g.GetSectionName()})
		}
	}
	if c := spec.GetMain(); c != nil {
		out.Spec.Main = &backendv1.ModelContainer{Image: c.GetImage(), Requests: c.GetRequests(), Limits: c.GetLimits()}
		for _, e := range c.GetEnv() {
			out.Spec.Main.Env = append(out.Spec.Main.Env, &backendv1.ModelEnvVar{Name: e.GetName(), Value: e.GetValue()})
		}
	}
	if s := spec.GetScaling(); s != nil {
		out.Spec.Scaling = &backendv1.ModelScaling{MinReplicas: s.GetMinReplicas(), MaxReplicas: s.GetMaxReplicas(), Keda: s.GetKeda()}
		for _, t := range s.GetTriggers() {
			out.Spec.Scaling.Triggers = append(out.Spec.Scaling.Triggers, &backendv1.ModelKedaTrigger{Type: t.GetType(), Metadata: t.GetMetadata()})
		}
	}
	if p := spec.GetPlacement(); p != nil {
		placement, err := toV1Placement(p)
		if err != nil {
			return nil, err
		}
		out.Spec.Placement = placement
	}
	if r := spec.GetRollout(); r != nil {
		out.Spec.Rollout = &backendv1.ModelRollout{
			Strategy:       backendv1.ModelRolloutStrategy(r.GetStrategy()),
			MaxConcurrency: r.GetMaxConcurrency(), MaxFailures: r.GetMaxFailures(),
			ProgressDeadline: r.GetProgressDeadline(), MinSuccessTime: r.GetMinSuccessTime(),
		}
	}
	return out, nil
}

func toV1Placement(p *aigridv1.Placement) (*backendv1.ModelPlacement, error) {
	var missing []string
	if len(p.GetClaimExpressions()) > 0 {
		missing = append(missing, "spec.placement.claim_expressions")
	}
	if len(p.GetTolerations()) > 0 {
		missing = append(missing, "spec.placement.tolerations")
	}
	if len(p.GetSpreadConstraints()) > 0 {
		missing = append(missing, "spec.placement.spread_constraints")
	}
	if len(missing) > 0 {
		return nil, status.Errorf(codes.Unimplemented, "the backend's Models API has no %s", strings.Join(missing, ", "))
	}
	out := &backendv1.ModelPlacement{ClusterSets: p.GetClusterSets(), NumberOfClusters: p.NumberOfClusters}
	sel := p.GetLabelSelector()
	if clusters, ok := consoleLocations(p); ok {
		out.LabelSelector = &backendv1.ModelLabelSelector{MatchExpressions: []*backendv1.ModelLabelSelectorRequirement{
			{Key: labelClusterName, Operator: "In", Values: clusters},
		}}
		return out, nil
	}
	if sel != nil {
		out.LabelSelector = &backendv1.ModelLabelSelector{MatchLabels: sel.GetMatchLabels()}
		for _, r := range sel.GetMatchExpressions() {
			out.LabelSelector.MatchExpressions = append(out.LabelSelector.MatchExpressions, &backendv1.ModelLabelSelectorRequirement{Key: r.GetKey(), Operator: r.GetOperator(), Values: r.GetValues()})
		}
	}
	return out, nil
}

// consoleLocations returns the locations of the console's own placement shape:
// the member labels and one `location In [...]`, nothing else.
func consoleLocations(p *aigridv1.Placement) ([]string, bool) {
	sel := p.GetLabelSelector()
	labels, exprs := sel.GetMatchLabels(), sel.GetMatchExpressions()
	if len(p.GetClusterSets()) > 0 || p.NumberOfClusters != nil || len(exprs) != 1 ||
		len(labels) != 2 || labels[labelEnabled] != "true" || labels[labelProvisioned] != "true" {
		return nil, false
	}
	if e := exprs[0]; e.GetKey() == labelLocation && e.GetOperator() == "In" {
		return e.GetValues(), true
	}
	return nil, false
}

func (c v1Models) fromV1(m *backendv1.Model) *aigridv1.Model {
	meta, spec := m.GetMetadata(), m.GetSpec()
	out := &aigridv1.Model{
		Name: m.GetId(),
		Metadata: &aigridv1.ObjectMeta{
			Namespace:         c.namespace,
			ResourceVersion:   strconv.Itoa(int(meta.GetVersion())),
			Labels:            meta.GetLabels(),
			Annotations:       meta.GetAnnotations(),
			CreationTimestamp: meta.GetCreationTimestamp(),
			DeletionTimestamp: meta.GetDeletionTimestamp(),
		},
		Status: fromV1ModelStatus(m.GetStatus()),
	}
	if spec == nil {
		return out
	}
	out.Spec = &aigridv1.ModelSpec{Replicas: spec.Replicas, BaseRefs: spec.GetBaseRefs(), Runtime: spec.GetRuntime()}
	if src := spec.GetModel(); src != nil {
		out.Spec.Model = &aigridv1.ModelSource{Uri: src.GetUri(), Name: src.GetName()}
	}
	if r := spec.GetRouter(); r != nil {
		out.Spec.Router = &aigridv1.Router{ManagedRoute: r.GetManagedRoute(), Scheduler: r.GetScheduler()}
		for _, g := range r.GetGatewayRefs() {
			out.Spec.Router.GatewayRefs = append(out.Spec.Router.GatewayRefs, &aigridv1.GatewayRef{Name: g.GetName(), Namespace: g.GetNamespace(), SectionName: g.GetSectionName()})
		}
	}
	if ct := spec.GetMain(); ct != nil {
		out.Spec.Main = &aigridv1.Container{Image: ct.GetImage(), Requests: ct.GetRequests(), Limits: ct.GetLimits()}
		for _, e := range ct.GetEnv() {
			out.Spec.Main.Env = append(out.Spec.Main.Env, &aigridv1.EnvVar{Name: e.GetName(), Value: e.GetValue()})
		}
	}
	if s := spec.GetScaling(); s != nil {
		out.Spec.Scaling = &aigridv1.Scaling{MinReplicas: s.GetMinReplicas(), MaxReplicas: s.GetMaxReplicas(), Keda: s.GetKeda()}
		for _, t := range s.GetTriggers() {
			out.Spec.Scaling.Triggers = append(out.Spec.Scaling.Triggers, &aigridv1.KedaTrigger{Type: t.GetType(), Metadata: t.GetMetadata()})
		}
	}
	if p := spec.GetPlacement(); p != nil {
		out.Spec.Placement = fromV1Placement(p)
	}
	if r := spec.GetRollout(); r != nil {
		out.Spec.Rollout = &aigridv1.Rollout{
			Strategy:       aigridv1.RolloutStrategy(r.GetStrategy()),
			MaxConcurrency: r.GetMaxConcurrency(), MaxFailures: r.GetMaxFailures(),
			ProgressDeadline: r.GetProgressDeadline(), MinSuccessTime: r.GetMinSuccessTime(),
		}
	}
	return out
}

// fromV1Placement turns a lone `name In [...]` back into the console's shape.
func fromV1Placement(p *backendv1.ModelPlacement) *aigridv1.Placement {
	out := &aigridv1.Placement{ClusterSets: p.GetClusterSets(), NumberOfClusters: p.NumberOfClusters}
	sel := p.GetLabelSelector()
	if sel == nil {
		return out
	}
	exprs := sel.GetMatchExpressions()
	if len(p.GetClusterSets()) == 0 && p.NumberOfClusters == nil && len(sel.GetMatchLabels()) == 0 &&
		len(exprs) == 1 && exprs[0].GetKey() == labelClusterName && exprs[0].GetOperator() == "In" {
		out.LabelSelector = &aigridv1.LabelSelector{
			MatchLabels:      map[string]string{labelEnabled: "true", labelProvisioned: "true"},
			MatchExpressions: []*aigridv1.LabelSelectorRequirement{{Key: labelLocation, Operator: "In", Values: exprs[0].GetValues()}},
		}
		return out
	}
	out.LabelSelector = &aigridv1.LabelSelector{MatchLabels: sel.GetMatchLabels()}
	for _, r := range exprs {
		out.LabelSelector.MatchExpressions = append(out.LabelSelector.MatchExpressions, &aigridv1.LabelSelectorRequirement{Key: r.GetKey(), Operator: r.GetOperator(), Values: r.GetValues()})
	}
	return out
}

// fromV1ModelStatus maps the status; the selected clusters are both the
// decisions and, a location being a cluster, the locations.
func fromV1ModelStatus(st *backendv1.ModelStatus) *aigridv1.ModelStatus {
	if st == nil {
		return nil
	}
	out := &aigridv1.ModelStatus{
		Url:                st.GetUrl(),
		Conditions:         fromV1Conditions(st.GetConditions()),
		Phase:              aigridv1.ModelPhase(st.GetPhase()),
		Reason:             st.GetReason(),
		Message:            st.GetMessage(),
		ObservedGeneration: st.GetObservedGeneration(),
	}
	if ps := st.GetPlacement(); ps != nil {
		selected := slices.Clone(ps.GetSelectedClusters())
		slices.Sort(selected)
		selected = slices.Compact(selected)
		out.Placement = &aigridv1.PlacementStatus{
			NumberOfSelectedClusters: ps.GetNumberOfSelectedClusters(),
			Conditions:               fromV1Conditions(ps.GetConditions()),
			Locations:                selected,
		}
		for _, name := range selected {
			out.Placement.Decisions = append(out.Placement.Decisions, &aigridv1.ClusterDecision{ClusterName: name})
		}
	}
	if rs := st.GetRollout(); rs != nil {
		out.Rollout = &aigridv1.RolloutStatus{Conditions: fromV1Conditions(rs.GetConditions())}
	}
	return out
}
