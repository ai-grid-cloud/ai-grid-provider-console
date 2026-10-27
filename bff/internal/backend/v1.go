package backend

// Stopgap: clients for the backend's real ai_grid.v1
// Clusters, Tenants, Subscriptions and Models RPCs (Models in v1_models.go), behind
// the draft's ManagedClustersClient, TenantsClient, SubscriptionsClient and
// ModelsClient interfaces so the
// API handlers are unchanged. The fake backend
// serves the draft, so Dial uses these only for a real backend.

import (
	"context"
	"maps"
	"strconv"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const (
	methodClustersList   = "/ai_grid.v1.Clusters/List"
	methodClustersGet    = "/ai_grid.v1.Clusters/Get"
	methodClustersUpdate = "/ai_grid.v1.Clusters/Update"
	methodTenantsList    = "/ai_grid.v1.Tenants/List"
	methodTenantsGet     = "/ai_grid.v1.Tenants/Get"
	methodTenantsCreate  = "/ai_grid.v1.Tenants/Create"
	methodTenantsUpdate  = "/ai_grid.v1.Tenants/Update"
	methodTenantsDelete  = "/ai_grid.v1.Tenants/Delete"

	methodSubscriptionsList   = "/ai_grid.v1.Subscriptions/List"
	methodSubscriptionsGet    = "/ai_grid.v1.Subscriptions/Get"
	methodSubscriptionsCreate = "/ai_grid.v1.Subscriptions/Create"
	methodSubscriptionsUpdate = "/ai_grid.v1.Subscriptions/Update"
	methodSubscriptionsDelete = "/ai_grid.v1.Subscriptions/Delete"

	methodModelsList   = "/ai_grid.v1.Models/List"
	methodModelsGet    = "/ai_grid.v1.Models/Get"
	methodModelsCreate = "/ai_grid.v1.Models/Create"
	methodModelsUpdate = "/ai_grid.v1.Models/Update"
	methodModelsDelete = "/ai_grid.v1.Models/Delete"

	methodModelsListLocations = "/ai_grid.v1.Models/ListLocations"
)

// The annotations the backend keeps a subscription's and an auth policy's
// display name and description in.
const (
	annotationDisplayName = "openshift.io/display-name"
	annotationDescription = "openshift.io/description"
)

type v1Clusters struct{ conn grpc.ClientConnInterface }

var _ aigridv1.ManagedClustersClient = v1Clusters{}

// ListManagedClusters forwards offset and limit, which the backend pages by
// (applyListWindow). Its ClustersListRequest has a filter it doesn't evaluate
// yet ("Not evaluated yet"), and its total always counts every cluster, so a
// forwarded filter would come back as the whole list presented as the
// filtered one; a filter is Unimplemented (501) instead.
func (c v1Clusters) ListManagedClusters(ctx context.Context, in *aigridv1.ListManagedClustersRequest, opts ...grpc.CallOption) (*aigridv1.ListManagedClustersResponse, error) {
	if in.Filter != nil {
		return nil, status.Error(codes.Unimplemented, "the backend's Clusters API does not evaluate filter yet")
	}
	req := &backendv1.ClustersListRequest{Offset: in.Offset, Limit: in.Limit}
	resp := &backendv1.ClustersListResponse{}
	if err := c.conn.Invoke(ctx, methodClustersList, req, resp, opts...); err != nil {
		return nil, err
	}
	out := &aigridv1.ListManagedClustersResponse{Size: resp.GetSize(), Total: resp.GetTotal()}
	for _, mc := range resp.GetItems() {
		out.Clusters = append(out.Clusters, FromV1Cluster(mc))
	}
	return out, nil
}

func (c v1Clusters) GetManagedCluster(ctx context.Context, in *aigridv1.GetManagedClusterRequest, opts ...grpc.CallOption) (*aigridv1.GetManagedClusterResponse, error) {
	resp := &backendv1.ClustersGetResponse{}
	if err := c.conn.Invoke(ctx, methodClustersGet, &backendv1.ClustersGetRequest{Id: in.GetName()}, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.GetManagedClusterResponse{Object: FromV1Cluster(resp.GetObject())}, nil
}

// UpdateManagedCluster sends the draft's labels/annotations mask as the real
// metadata paths and its resource_version as metadata.version.
func (c v1Clusters) UpdateManagedCluster(ctx context.Context, in *aigridv1.UpdateManagedClusterRequest, opts ...grpc.CallOption) (*aigridv1.UpdateManagedClusterResponse, error) {
	obj := in.GetObject()
	version, err := strconv.ParseInt(obj.GetResourceVersion(), 10, 32)
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "version %q is not one this backend answered", obj.GetResourceVersion())
	}
	var paths []string
	for _, p := range in.GetUpdateMask().GetPaths() {
		paths = append(paths, "metadata."+p)
	}
	req := &backendv1.ClustersUpdateRequest{
		Object: &backendv1.ManagedCluster{
			Id:       obj.GetName(),
			Metadata: &backendv1.Metadata{Labels: obj.GetLabels(), Annotations: obj.GetAnnotations(), Version: int32(version)},
		},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: paths},
		Lock:       in.GetLock(),
	}
	resp := &backendv1.ClustersUpdateResponse{}
	if err := c.conn.Invoke(ctx, methodClustersUpdate, req, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.UpdateManagedClusterResponse{Object: FromV1Cluster(resp.GetObject())}, nil
}

// FromV1Cluster maps a real ManagedCluster onto the draft. The real status has
// only the Joined and Available conditions, so the state is derived from them
// in the fake's order (fakebackend/state.go); import progress, claims and
// capacity are not available. Provisioning is always set, so the console
// reads it instead of the ai-grid/provisioned label.
func FromV1Cluster(mc *backendv1.ManagedCluster) *aigridv1.ManagedCluster {
	meta := mc.GetMetadata()
	st := mc.GetStatus()
	state := aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN
	switch {
	case meta.GetDeletionTimestamp() != nil:
		state = aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING
	case !mc.GetSpec().GetHubAcceptsClient():
		state = aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED
	case !st.GetJoined():
		state = aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT
	case st.GetAvailableCondition() == "True":
		state = aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE
	case st.GetAvailableCondition() == "False":
		state = aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE
	}
	return &aigridv1.ManagedCluster{
		Name:              mc.GetId(),
		Labels:            meta.GetLabels(),
		Annotations:       meta.GetAnnotations(),
		HubAcceptsClient:  mc.GetSpec().GetHubAcceptsClient(),
		ResourceVersion:   strconv.Itoa(int(meta.GetVersion())),
		CreationTimestamp: meta.GetCreationTimestamp(),
		DeletionTimestamp: meta.GetDeletionTimestamp(),
		Status:            &aigridv1.ManagedClusterStatus{State: state, Provisioning: proto.String(st.GetProvisioning())},
	}
}

type v1Tenants struct{ conn grpc.ClientConnInterface }

var _ aigridv1.TenantsClient = v1Tenants{}

// ListTenants forwards offset, limit and filter. The backend pages but
// doesn't evaluate filter yet, so a filtered answer carries no total and the
// handler refuses it (requireTotal).
func (c v1Tenants) ListTenants(ctx context.Context, in *aigridv1.ListTenantsRequest, opts ...grpc.CallOption) (*aigridv1.ListTenantsResponse, error) {
	req := &backendv1.TenantsListRequest{Offset: in.Offset, Limit: in.Limit, Filter: in.Filter}
	resp := &backendv1.TenantsListResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsList, req, resp, opts...); err != nil {
		return nil, err
	}
	out := &aigridv1.ListTenantsResponse{Size: resp.GetSize()}
	if in.Filter == nil {
		total := resp.GetTotal()
		out.Total = &total
	}
	for _, t := range resp.GetItems() {
		out.Tenants = append(out.Tenants, FromV1Tenant(t))
	}
	return out, nil
}

// GetTenant reads one tenant.
func (c v1Tenants) GetTenant(ctx context.Context, in *aigridv1.GetTenantRequest, opts ...grpc.CallOption) (*aigridv1.GetTenantResponse, error) {
	resp := &backendv1.TenantsGetResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsGet, &backendv1.TenantsGetRequest{Id: in.GetId()}, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.GetTenantResponse{Object: FromV1Tenant(resp.GetObject())}, nil
}

// CreateTenant sends the name and domains, the only fields the backend's
// Tenant has. A request that sets a field it lacks is Unimplemented, not
// dropped. The backend sets the Keycloak alias to the name.
func (c v1Tenants) CreateTenant(ctx context.Context, in *aigridv1.CreateTenantRequest, opts ...grpc.CallOption) (*aigridv1.CreateTenantResponse, error) {
	obj := in.GetObject()
	var unsupported []string
	if obj.GetAlias() != "" && obj.GetAlias() != obj.GetName() {
		unsupported = append(unsupported, "alias")
	}
	if obj.GetDescription() != "" {
		unsupported = append(unsupported, "description")
	}
	if obj.Enabled != nil && !obj.GetEnabled() {
		unsupported = append(unsupported, "enabled")
	}
	if len(obj.GetAttributes()) > 0 {
		unsupported = append(unsupported, "attributes")
	}
	if obj.GetIdentityProvider() != nil {
		unsupported = append(unsupported, "identityProvider")
	}
	if err := notInBackend(unsupported); err != nil {
		return nil, err
	}
	req := &backendv1.TenantsCreateRequest{Object: &backendv1.Tenant{
		Metadata: &backendv1.Metadata{Name: obj.GetName()},
		Spec:     &backendv1.TenantSpec{Domains: obj.GetDomains()},
	}}
	resp := &backendv1.TenantsCreateResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsCreate, req, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.CreateTenantResponse{Object: FromV1Tenant(resp.GetObject())}, nil
}

// tenantPaths maps the draft's mask paths onto the backend's; the others
// name fields the backend's Tenant doesn't have.
var tenantPaths = map[string]string{"name": "metadata.name", "domains": "spec.domains"}

// UpdateTenant sends the draft's name and domains paths as the backend's, and
// the If-Match version as metadata.version with lock. The backend (PR 16)
// requires a version: every tenant reads as 1 or more, and 0 is
// InvalidArgument (422). Description, enabled and attributes pass when they
// hold what a read gives back (empty, true, none), as on create; other values,
// and any alias (the backend can't say which one Keycloak keeps after a
// rename), are Unimplemented. When only those no-op fields are left (an empty
// mask would make the backend update the name and domains), the mask names
// only id, which the backend answers with the stored tenant after checking
// the version, writing nothing.
func (c v1Tenants) UpdateTenant(ctx context.Context, in *aigridv1.UpdateTenantRequest, opts ...grpc.CallOption) (*aigridv1.UpdateTenantResponse, error) {
	obj := in.GetObject()
	version, err := v1Version(obj.GetResourceVersion())
	if err != nil {
		return nil, err
	}
	var paths, unsupported []string
	for _, p := range in.GetUpdateMask().GetPaths() {
		if real, ok := tenantPaths[p]; ok {
			paths = append(paths, real)
		} else if !readBackValue(p, obj) {
			unsupported = append(unsupported, p)
		}
	}
	if err := notInBackend(unsupported); err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		paths = []string{"id"}
	}
	req := &backendv1.TenantsUpdateRequest{
		Object: &backendv1.Tenant{
			Id:       obj.GetId(),
			Metadata: &backendv1.Metadata{Name: obj.GetName(), Version: version},
			Spec:     &backendv1.TenantSpec{Domains: obj.GetDomains()},
		},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: paths},
		Lock:       true,
	}
	resp := &backendv1.TenantsUpdateResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsUpdate, req, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.UpdateTenantResponse{Object: FromV1Tenant(resp.GetObject())}, nil
}

// DeleteTenant sends the If-Match version, which the backend (PR 16) checks;
// it answers 0 with InvalidArgument (422).
func (c v1Tenants) DeleteTenant(ctx context.Context, in *aigridv1.DeleteTenantRequest, opts ...grpc.CallOption) (*aigridv1.DeleteTenantResponse, error) {
	version, err := v1Version(in.GetResourceVersion())
	if err != nil {
		return nil, err
	}
	if err := c.conn.Invoke(ctx, methodTenantsDelete, &backendv1.TenantsDeleteRequest{Id: in.GetId(), Version: version}, &backendv1.TenantsDeleteResponse{}, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.DeleteTenantResponse{}, nil
}

// v1Version parses an If-Match version into the backend's metadata.version.
// A negative one is InvalidArgument: the backend never answers one.
func v1Version(rv string) (int32, error) {
	v, err := strconv.ParseInt(rv, 10, 32)
	if err != nil {
		return 0, status.Errorf(codes.FailedPrecondition, "version %q is not one this backend answered", rv)
	}
	if v < 0 {
		return 0, status.Errorf(codes.InvalidArgument, "version %q is negative", rv)
	}
	return int32(v), nil
}

// v1DeleteVersion is v1Version for a delete's If-Match. The backend treats
// version 0 as "no check" and git mode's versions start at 1, so 0 is refused
// rather than turning the delete unconditional.
func v1DeleteVersion(rv string) (int32, error) {
	v, err := v1Version(rv)
	if err == nil && v == 0 {
		return 0, status.Errorf(codes.FailedPrecondition, "version %q is not one this backend answered", rv)
	}
	return v, err
}

// readBackValue reports whether path p, which the backend's Tenant lacks,
// holds what a read gives back: no description, enabled, no attributes.
func readBackValue(p string, obj *aigridv1.Tenant) bool {
	switch p {
	case "description":
		return obj.GetDescription() == ""
	case "enabled":
		return obj.GetEnabled()
	case "attributes":
		return len(obj.GetAttributes()) == 0
	}
	return false
}

// notInBackend refuses a request that sets fields the backend's Tenant lacks.
func notInBackend(fields []string) error {
	if len(fields) == 0 {
		return nil
	}
	return status.Errorf(codes.Unimplemented, "the backend's Tenants API has no %s", strings.Join(fields, ", "))
}

// FromV1Tenant maps a real Tenant (id, name, domains, version, creation time)
// onto the draft.
func FromV1Tenant(t *backendv1.Tenant) *aigridv1.Tenant {
	return &aigridv1.Tenant{
		Id:              t.GetId(),
		Name:            t.GetMetadata().GetName(),
		Domains:         t.GetSpec().GetDomains(),
		ResourceVersion: strconv.Itoa(int(t.GetMetadata().GetVersion())),
		CreateTime:      t.GetMetadata().GetCreationTimestamp(),
	}
}

type v1Subscriptions struct{ conn grpc.ClientConnInterface }

var _ aigridv1.SubscriptionsClient = v1Subscriptions{}

// ListSubscriptions lists every subscription.
func (c v1Subscriptions) ListSubscriptions(ctx context.Context, _ *aigridv1.ListSubscriptionsRequest, opts ...grpc.CallOption) (*aigridv1.ListSubscriptionsResponse, error) {
	resp := &backendv1.SubscriptionsListResponse{}
	if err := c.conn.Invoke(ctx, methodSubscriptionsList, &backendv1.SubscriptionsListRequest{}, resp, opts...); err != nil {
		return nil, err
	}
	out := &aigridv1.ListSubscriptionsResponse{}
	for _, s := range resp.GetItems() {
		out.Subscriptions = append(out.Subscriptions, FromV1Subscription(s))
	}
	return out, nil
}

// GetSubscription reads one subscription with its auth policies and model
// registrations. The backend doesn't join the hub's Models, so model_refs
// carries each registered model's name, namespace and MaaS phase: the view
// page shows that state, and "not found" for a model MaaS doesn't have.
func (c v1Subscriptions) GetSubscription(ctx context.Context, in *aigridv1.GetSubscriptionRequest, opts ...grpc.CallOption) (*aigridv1.GetSubscriptionResponse, error) {
	resp := &backendv1.SubscriptionsGetResponse{}
	if err := c.conn.Invoke(ctx, methodSubscriptionsGet, &backendv1.SubscriptionsGetRequest{Id: in.GetName()}, resp, opts...); err != nil {
		return nil, err
	}
	out := &aigridv1.GetSubscriptionResponse{Subscription: FromV1Subscription(resp.GetObject())}
	for _, p := range resp.GetAuthPolicies() {
		out.AuthPolicies = append(out.AuthPolicies, fromV1AuthPolicy(p))
	}
	for _, r := range resp.GetModelRegistrations() {
		out.ModelRegistrations = append(out.ModelRegistrations, &aigridv1.ModelRegistration{
			Name: r.GetName(), Namespace: r.GetNamespace(), Phase: r.GetPhase(), Endpoint: r.GetEndpoint(), Conditions: fromV1Conditions(r.GetConditions()),
		})
		out.ModelRefs = append(out.ModelRefs, registeredModel(r))
	}
	return out, nil
}

// CreateSubscription creates the subscription. The backend always creates
// <name>-policy with it, so a request without create_auth_policy is
// Unimplemented.
func (c v1Subscriptions) CreateSubscription(ctx context.Context, in *aigridv1.CreateSubscriptionRequest, opts ...grpc.CallOption) (*aigridv1.CreateSubscriptionResponse, error) {
	if !in.GetCreateAuthPolicy() {
		return nil, status.Error(codes.Unimplemented, "the backend's Subscriptions API always creates the auth policy")
	}
	obj := toV1Subscription(in.GetObject())
	obj.Metadata.Annotations = nonEmpty(obj.GetMetadata().GetAnnotations())
	resp := &backendv1.SubscriptionsCreateResponse{}
	if err := c.conn.Invoke(ctx, methodSubscriptionsCreate, &backendv1.SubscriptionsCreateRequest{Object: obj}, resp, opts...); err != nil {
		return nil, err
	}
	out := &aigridv1.CreateSubscriptionResponse{Subscription: FromV1Subscription(resp.GetObject())}
	if p := resp.GetAuthPolicy(); p != nil {
		out.AuthPolicy = fromV1AuthPolicy(p)
	}
	return out, nil
}

// UpdateSubscription replaces the spec and the display name and description,
// with the If-Match version as metadata.version. The annotations mask
// replaces the whole map, so the subscription is read first and its other
// annotations are sent back unchanged; a cleared display name or description
// is left out. If the subscription changes between the read and the update,
// the backend refuses the stale version.
func (c v1Subscriptions) UpdateSubscription(ctx context.Context, in *aigridv1.UpdateSubscriptionRequest, opts ...grpc.CallOption) (*aigridv1.UpdateSubscriptionResponse, error) {
	version, err := v1Version(in.GetObject().GetResourceVersion())
	if err != nil {
		return nil, err
	}
	current := &backendv1.SubscriptionsGetResponse{}
	if err := c.conn.Invoke(ctx, methodSubscriptionsGet, &backendv1.SubscriptionsGetRequest{Id: in.GetObject().GetName()}, current, opts...); err != nil {
		return nil, err
	}
	obj := toV1Subscription(in.GetObject())
	annotations := maps.Clone(current.GetObject().GetMetadata().GetAnnotations())
	if annotations == nil {
		annotations = map[string]string{}
	}
	maps.Copy(annotations, obj.GetMetadata().GetAnnotations())
	obj.Metadata.Annotations = nonEmpty(annotations)
	obj.Metadata.Version = version
	req := &backendv1.SubscriptionsUpdateRequest{
		Object:     obj,
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"spec", "metadata.annotations"}},
		Lock:       in.GetLock(),
	}
	resp := &backendv1.SubscriptionsUpdateResponse{}
	if err := c.conn.Invoke(ctx, methodSubscriptionsUpdate, req, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.UpdateSubscriptionResponse{Subscription: FromV1Subscription(resp.GetObject())}, nil
}

// DeleteSubscription deletes the subscription and its <name>-policy, sending
// the If-Match version; empty skips the check in both APIs (zero in the
// backend's).
func (c v1Subscriptions) DeleteSubscription(ctx context.Context, in *aigridv1.DeleteSubscriptionRequest, opts ...grpc.CallOption) (*aigridv1.DeleteSubscriptionResponse, error) {
	req := &backendv1.SubscriptionsDeleteRequest{Id: in.GetName()}
	if rv := in.GetResourceVersion(); rv != "" {
		v, err := v1DeleteVersion(rv)
		if err != nil {
			return nil, err
		}
		req.ResourceVersion = v
	}
	if err := c.conn.Invoke(ctx, methodSubscriptionsDelete, req, &backendv1.SubscriptionsDeleteResponse{}, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.DeleteSubscriptionResponse{}, nil
}

// toV1Subscription maps the draft's writable fields onto the backend's: the
// organization to spec.organization.id, the display name and description to
// annotations (both always present), and the billing rate to an object.
func toV1Subscription(s *aigridv1.Subscription) *backendv1.Subscription {
	tm := s.GetTokenMetadata()
	spec := &backendv1.SubscriptionSpec{
		Owner:             &backendv1.SubscriptionOwner{Groups: s.GetOwner().GetGroups(), Users: s.GetOwner().GetUsers()},
		Priority:          s.GetPriority(),
		InferencePriority: s.InferencePriority,
		Guardrails:        toV1Guardrails(s.GetGuardrails()),
	}
	if tm.GetOrganizationId() != "" {
		spec.Organization = &backendv1.SubscriptionOrganization{Id: tm.GetOrganizationId()}
	}
	if tm.GetCostCenter() != "" || len(tm.GetLabels()) > 0 {
		spec.TokenMetadata = &backendv1.TokenMetadata{CostCenter: tm.GetCostCenter(), Labels: tm.GetLabels()}
	}
	for _, r := range s.GetModelRefs() {
		ref := &backendv1.SubscriptionModelRef{Name: r.GetName(), Namespace: r.GetNamespace(), Unlimited: r.GetUnlimited(), Guardrails: toV1Guardrails(r.GetGuardrails())}
		for _, l := range r.GetTokenRateLimits() {
			ref.TokenRateLimits = append(ref.TokenRateLimits, &backendv1.TokenRateLimit{Limit: l.GetLimit(), Window: l.GetWindow()})
		}
		if r.BillingRatePerToken != nil {
			ref.BillingRate = &backendv1.BillingRate{PerToken: r.GetBillingRatePerToken()}
		}
		spec.ModelRefs = append(spec.ModelRefs, ref)
	}
	return &backendv1.Subscription{
		Id:       s.GetName(),
		Metadata: &backendv1.Metadata{Annotations: map[string]string{annotationDisplayName: s.GetDisplayName(), annotationDescription: s.GetDescription()}},
		Spec:     spec,
	}
}

// FromV1Subscription maps a real Subscription onto the draft.
func FromV1Subscription(s *backendv1.Subscription) *aigridv1.Subscription {
	meta, spec, st := s.GetMetadata(), s.GetSpec(), s.GetStatus()
	out := &aigridv1.Subscription{
		Name:              s.GetId(),
		DisplayName:       meta.GetAnnotations()[annotationDisplayName],
		Description:       meta.GetAnnotations()[annotationDescription],
		Priority:          spec.GetPriority(),
		InferencePriority: spec.InferencePriority,
		Guardrails:        fromV1Guardrails(spec.GetGuardrails()),
		Phase:             st.GetPhase(),
		ResourceVersion:   strconv.Itoa(int(meta.GetVersion())),
		CreateTime:        meta.GetCreationTimestamp(),
		DeletionTime:      meta.GetDeletionTimestamp(),
		Conditions:        fromV1Conditions(st.GetConditions()),
	}
	if o := spec.GetOwner(); o != nil {
		out.Owner = &aigridv1.Owner{Groups: o.GetGroups(), Users: o.GetUsers()}
	}
	org, tm := spec.GetOrganization().GetId(), spec.GetTokenMetadata()
	if org != "" || tm != nil {
		out.TokenMetadata = &aigridv1.TokenMetadata{OrganizationId: org, CostCenter: tm.GetCostCenter(), Labels: tm.GetLabels()}
	}
	for _, r := range spec.GetModelRefs() {
		ref := &aigridv1.ModelSubscriptionRef{
			Name: r.GetName(), Namespace: r.GetNamespace(), DisplayName: r.GetDisplayName(), Description: r.GetDescription(),
			Unlimited: r.GetUnlimited(), Guardrails: fromV1Guardrails(r.GetGuardrails()),
		}
		for _, l := range r.GetTokenRateLimits() {
			ref.TokenRateLimits = append(ref.TokenRateLimits, &aigridv1.TokenRateLimit{Limit: l.GetLimit(), Window: l.GetWindow()})
		}
		if b := r.GetBillingRate(); b != nil {
			ref.BillingRatePerToken = proto.String(b.GetPerToken())
		}
		out.ModelRefs = append(out.ModelRefs, ref)
	}
	for _, r := range st.GetModelRefStatuses() {
		out.ModelRefStatuses = append(out.ModelRefStatuses, fromV1RefStatus(r))
	}
	for _, t := range st.GetTokenRateLimitStatuses() {
		out.TokenRateLimitStatuses = append(out.TokenRateLimitStatuses, &aigridv1.TokenRateLimitStatus{Ref: fromV1RefStatus(t.GetRef()), Model: t.GetModel()})
	}
	return out
}

func fromV1AuthPolicy(p *backendv1.AuthPolicy) *aigridv1.AuthPolicy {
	out := &aigridv1.AuthPolicy{
		Name:          p.GetId(),
		DisplayName:   p.GetMetadata().GetAnnotations()[annotationDisplayName],
		Description:   p.GetMetadata().GetAnnotations()[annotationDescription],
		Phase:         p.GetPhase(),
		SubjectGroups: p.GetSubjectGroups(),
		Conditions:    fromV1Conditions(p.GetConditions()),
	}
	for _, r := range p.GetModelRefs() {
		out.ModelRefs = append(out.ModelRefs, &aigridv1.AuthPolicyModelRef{Name: r.GetName(), Namespace: r.GetNamespace()})
	}
	return out
}

// reasonSavedToGit is the backend's reason for a status it doesn't read in git
// mode: the change was saved to Git, and the clusters aren't asked.
const reasonSavedToGit = "SavedToGit"

// registeredModel is a model as its MaaS registration shows it: Ready, Failed
// (Failed, Invalid or Unhealthy, with the phase as reason and the Ready
// condition's message) or Pending. A registration the backend saved to Git
// (no phase, and a Ready condition with reason SavedToGit) has no phase, with
// that reason and message, so the console doesn't show it as Pending.
func registeredModel(r *backendv1.ModelRegistration) *aigridv1.Model {
	st := &aigridv1.ModelStatus{Phase: aigridv1.ModelPhase_MODEL_PHASE_PENDING}
	switch r.GetPhase() {
	case "":
		for _, c := range r.GetConditions() {
			if c.GetType() == "Ready" && c.GetReason() == reasonSavedToGit {
				st = &aigridv1.ModelStatus{Reason: reasonSavedToGit, Message: c.GetMessage()}
			}
		}
	case "Ready":
		st.Phase = aigridv1.ModelPhase_MODEL_PHASE_READY
	case "Failed", "Invalid", "Unhealthy":
		st.Phase, st.Reason = aigridv1.ModelPhase_MODEL_PHASE_FAILED, r.GetPhase()
		for _, c := range r.GetConditions() {
			if c.GetType() == "Ready" {
				st.Message = c.GetMessage()
			}
		}
	}
	return &aigridv1.Model{Name: r.GetName(), Metadata: &aigridv1.ObjectMeta{Namespace: r.GetNamespace()}, Status: st}
}

func fromV1Conditions(cs []*backendv1.Condition) []*aigridv1.Condition {
	var out []*aigridv1.Condition
	for _, c := range cs {
		out = append(out, &aigridv1.Condition{
			Type: c.GetType(), Status: aigridv1.ConditionStatus(c.GetStatus()), LastTransitionTime: c.GetLastTransitionTime(),
			Reason: c.Reason, Message: c.Message,
		})
	}
	return out
}

func fromV1RefStatus(r *backendv1.ResourceRefStatus) *aigridv1.ResourceRefStatus {
	return &aigridv1.ResourceRefStatus{Name: r.GetName(), Namespace: r.GetNamespace(), Ready: r.GetReady(), Reason: r.GetReason(), Message: r.GetMessage()}
}

func toV1Guardrails(gs []*aigridv1.GuardrailAttachment) []*backendv1.GuardrailAttachment {
	var out []*backendv1.GuardrailAttachment
	for _, g := range gs {
		out = append(out, &backendv1.GuardrailAttachment{RefName: g.GetRefName(), Checks: g.GetChecks()})
	}
	return out
}

func fromV1Guardrails(gs []*backendv1.GuardrailAttachment) []*aigridv1.GuardrailAttachment {
	var out []*aigridv1.GuardrailAttachment
	for _, g := range gs {
		out = append(out, &aigridv1.GuardrailAttachment{RefName: g.GetRefName(), Checks: g.GetChecks()})
	}
	return out
}

// nonEmpty drops empty values: a new subscription has no annotation to clear.
func nonEmpty(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		if v != "" {
			out[k] = v
		}
	}
	return out
}
