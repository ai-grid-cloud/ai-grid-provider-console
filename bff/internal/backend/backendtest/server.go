// Package backendtest runs an in-memory ai-grid-backend for handler tests.
package backendtest

import (
	"context"
	"maps"
	"net"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
)

// Fake answers the ManagedClusters, Tenants and AiGrid services from fixed
// data and the draft-only services with Unimplemented. Set Err to make every
// RPC fail with that status, or Errs to fail one RPC by method name
// ("UpdateManagedCluster"), so a read can succeed and the write that follows
// it fail. Calls lists the methods reached, in order, and Metadata records the
// incoming metadata of the last call so tests can assert on identity
// forwarding. Clusters are served as given: the derived `status.state` is
// whatever the test put there, so handler tests control it directly.
// GetManagedCluster hands out a copy and then runs AfterGet on the stored
// object, so a test can simulate a write that lands between the BFF's read
// and its update. Updates mutate the slice in place and bump
// `resource_version`; LastUpdate keeps the last request, reached or refused.
// Tenants follow the same idea with the few Keycloak rules a handler test
// needs (ids `t-<n>`, duplicate name 409, NotFound); the Last*Tenant fields
// keep the last request of each tenant RPC, reached or refused.
type Fake struct {
	aigridv1.UnimplementedAiGridServer
	aigridv1.UnimplementedManagedClustersServer
	aigridv1.UnimplementedTenantsServer
	aigridv1.UnimplementedGridServer
	aigridv1.UnimplementedModelsServer
	aigridv1.UnimplementedCatalogItemsServer
	aigridv1.UnimplementedSubscriptionsServer

	Clusters   []*aigridv1.ManagedCluster
	Tenants    []*aigridv1.Tenant
	Err        error
	Errs       map[string]error
	Calls      []string
	Metadata   metadata.MD
	LastUpdate *aigridv1.UpdateManagedClusterRequest
	AfterGet   func(stored *aigridv1.ManagedCluster)

	LastListTenants  *aigridv1.ListTenantsRequest
	LastCreateTenant *aigridv1.CreateTenantRequest
	LastUpdateTenant *aigridv1.UpdateTenantRequest
	LastDeleteTenant *aigridv1.DeleteTenantRequest
	// lastTenantID is the highest `t-<n>` handed out or seeded, so an id is
	// never reused after a delete.
	lastTenantID int
}

// begin records the call and returns the injected error for it, if any. It
// also notes the tenant ids present so far, before a delete can remove one.
func (f *Fake) begin(ctx context.Context, method string) error {
	md, _ := metadata.FromIncomingContext(ctx)
	f.Metadata = md
	f.noteTenantIDs()
	f.Calls = append(f.Calls, method)
	if f.Err != nil {
		return f.Err
	}
	return f.Errs[method]
}

// Reached reports whether the named RPC was called.
func (f *Fake) Reached(method string) bool {
	for _, m := range f.Calls {
		if m == method {
			return true
		}
	}
	return false
}

// Ping implements AiGrid.
func (f *Fake) Ping(ctx context.Context, req *aigridv1.PingRequest) (*aigridv1.PingResponse, error) {
	if err := f.begin(ctx, "Ping"); err != nil {
		return nil, err
	}
	return &aigridv1.PingResponse{Message: "pong " + req.GetName()}, nil
}

// ListManagedClusters implements ManagedClusters.
func (f *Fake) ListManagedClusters(ctx context.Context, _ *aigridv1.ListManagedClustersRequest) (*aigridv1.ListManagedClustersResponse, error) {
	if err := f.begin(ctx, "ListManagedClusters"); err != nil {
		return nil, err
	}
	return &aigridv1.ListManagedClustersResponse{Clusters: f.Clusters}, nil
}

// GetManagedCluster implements ManagedClusters with the backend's NotFound message.
func (f *Fake) GetManagedCluster(ctx context.Context, req *aigridv1.GetManagedClusterRequest) (*aigridv1.GetManagedClusterResponse, error) {
	if err := f.begin(ctx, "GetManagedCluster"); err != nil {
		return nil, err
	}
	c := f.find(req.GetName())
	if c == nil {
		return nil, status.Errorf(codes.NotFound, "object with identifier '%s' not found", req.GetName())
	}
	out := proto.Clone(c).(*aigridv1.ManagedCluster)
	if f.AfterGet != nil {
		f.AfterGet(c)
	}
	return &aigridv1.GetManagedClusterResponse{Object: out}, nil
}

// UpdateManagedCluster implements ManagedClusters: mask paths `labels`,
// `annotations`, `hub_accepts_client`; `lock` compares `resource_version`
// and answers Aborted on a mismatch.
func (f *Fake) UpdateManagedCluster(ctx context.Context, req *aigridv1.UpdateManagedClusterRequest) (*aigridv1.UpdateManagedClusterResponse, error) {
	f.LastUpdate = req
	if err := f.begin(ctx, "UpdateManagedCluster"); err != nil {
		return nil, err
	}
	c := f.find(req.GetObject().GetName())
	if c == nil {
		return nil, status.Errorf(codes.NotFound, "object with identifier '%s' not found", req.GetObject().GetName())
	}
	if req.GetLock() && req.GetObject().GetResourceVersion() != c.GetResourceVersion() {
		return nil, status.Errorf(codes.Aborted, "object with identifier '%s' has resource version %s, the request carries %q", c.GetName(), c.GetResourceVersion(), req.GetObject().GetResourceVersion())
	}
	for _, p := range req.GetUpdateMask().GetPaths() {
		switch p {
		case "labels":
			c.Labels = maps.Clone(req.GetObject().GetLabels())
		case "annotations":
			c.Annotations = maps.Clone(req.GetObject().GetAnnotations())
		case "hub_accepts_client":
			c.HubAcceptsClient = req.GetObject().GetHubAcceptsClient()
		default:
			return nil, status.Errorf(codes.InvalidArgument, "update_mask path %q is not supported", p)
		}
	}
	rv, err := strconv.Atoi(c.GetResourceVersion())
	if err != nil {
		rv = 0 // a fixture without a numeric version starts counting here
	}
	c.ResourceVersion = strconv.Itoa(rv + 1)
	return &aigridv1.UpdateManagedClusterResponse{Object: c}, nil
}

func (f *Fake) find(name string) *aigridv1.ManagedCluster {
	for _, c := range f.Clusters {
		if c.GetName() == name {
			return c
		}
	}
	return nil
}

// tenantFilter is the one filter form the draft supports (see
// ListTenantsRequest.filter): the same term in both halves.
var tenantFilter = regexp.MustCompile(`^this\.name\.contains\("((?:[^"\\]|\\.)*)"\) \|\| this\.domains\.exists\(d, d\.contains\("((?:[^"\\]|\\.)*)"\)\)$`)

// ListTenants implements Tenants: name order, `offset`/`limit` paging and
// the name-or-domain contains filter (case-insensitive), with `total`
// counted over the filtered set.
func (f *Fake) ListTenants(ctx context.Context, req *aigridv1.ListTenantsRequest) (*aigridv1.ListTenantsResponse, error) {
	if err := f.begin(ctx, "ListTenants"); err != nil {
		return nil, err
	}
	f.LastListTenants = req
	term := ""
	if filter := req.GetFilter(); filter != "" {
		m := tenantFilter.FindStringSubmatch(filter)
		if m == nil || m[1] != m[2] {
			return nil, status.Errorf(codes.InvalidArgument, "filter %s is not supported", filter)
		}
		term = strings.ToLower(strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(m[1]))
	}
	all := make([]*aigridv1.Tenant, 0, len(f.Tenants))
	for _, t := range f.Tenants {
		match := strings.Contains(strings.ToLower(t.GetName()), term)
		for _, d := range t.GetDomains() {
			match = match || strings.Contains(strings.ToLower(d), term)
		}
		if match {
			all = append(all, t)
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].GetName() < all[j].GetName() })
	total := len(all)
	page := all[min(int(req.GetOffset()), total):]
	if req.Limit != nil && int(req.GetLimit()) < len(page) {
		page = page[:req.GetLimit()]
	}
	return &aigridv1.ListTenantsResponse{Tenants: page, Size: int32(len(page)), Total: int32(total)}, nil
}

// GetTenant implements Tenants with the backend's NotFound message.
func (f *Fake) GetTenant(ctx context.Context, req *aigridv1.GetTenantRequest) (*aigridv1.GetTenantResponse, error) {
	if err := f.begin(ctx, "GetTenant"); err != nil {
		return nil, err
	}
	t := f.findTenant(req.GetId())
	if t == nil {
		return nil, status.Errorf(codes.NotFound, "object with identifier '%s' not found", req.GetId())
	}
	return &aigridv1.GetTenantResponse{Object: t}, nil
}

// CreateTenant implements Tenants: assigns the next `t-<n>` (monotonic, past
// every seeded or deleted id), defaults the alias to the name and `enabled`
// to true, mirrors `domains` into `domain_details`, 409 on a taken name with
// Keycloak's message.
func (f *Fake) CreateTenant(ctx context.Context, req *aigridv1.CreateTenantRequest) (*aigridv1.CreateTenantResponse, error) {
	f.LastCreateTenant = req
	if err := f.begin(ctx, "CreateTenant"); err != nil {
		return nil, err
	}
	t := proto.Clone(req.GetObject()).(*aigridv1.Tenant)
	if t.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "Name can not be null")
	}
	for _, other := range f.Tenants {
		if other.GetName() == t.GetName() {
			return nil, status.Error(codes.AlreadyExists, "A organization with the same name already exists.")
		}
	}
	if t.GetAlias() == "" {
		t.Alias = t.GetName()
	}
	if t.Enabled == nil {
		t.Enabled = proto.Bool(true)
	}
	if len(t.GetDomainDetails()) == 0 {
		for _, d := range t.GetDomains() {
			t.DomainDetails = append(t.DomainDetails, &aigridv1.TenantDomain{Name: d})
		}
	}
	t.Id = f.nextTenantID()
	f.Tenants = append(f.Tenants, t)
	return &aigridv1.CreateTenantResponse{Object: t}, nil
}

// UpdateTenant implements Tenants: applies the mask paths in place.
func (f *Fake) UpdateTenant(ctx context.Context, req *aigridv1.UpdateTenantRequest) (*aigridv1.UpdateTenantResponse, error) {
	f.LastUpdateTenant = req
	if err := f.begin(ctx, "UpdateTenant"); err != nil {
		return nil, err
	}
	t := f.findTenant(req.GetObject().GetId())
	if t == nil {
		return nil, status.Errorf(codes.NotFound, "object with identifier '%s' not found", req.GetObject().GetId())
	}
	if alias := req.GetObject().GetAlias(); alias != "" && alias != t.GetAlias() {
		return nil, status.Error(codes.InvalidArgument, "Cannot change the alias")
	}
	obj := req.GetObject()
	for _, p := range req.GetUpdateMask().GetPaths() {
		switch p {
		case "name":
			t.Name = obj.GetName()
		case "enabled":
			t.Enabled = proto.Bool(obj.GetEnabled())
		case "description":
			t.Description = obj.GetDescription()
		case "attributes":
			t.Attributes = maps.Clone(obj.GetAttributes())
		case "domains":
			// Names only; unlike the real fake this drops the metadata of a
			// domain that stays, which handler tests do not depend on.
			t.Domains = slices.Clone(obj.GetDomains())
			t.DomainDetails = nil
			for _, d := range t.Domains {
				t.DomainDetails = append(t.DomainDetails, &aigridv1.TenantDomain{Name: d})
			}
		case "domain_details":
			t.DomainDetails = obj.GetDomainDetails()
			t.Domains = nil
			for _, d := range t.DomainDetails {
				t.Domains = append(t.Domains, d.GetName())
			}
		default:
			return nil, status.Errorf(codes.InvalidArgument, "update_mask path %q is not supported", p)
		}
	}
	return &aigridv1.UpdateTenantResponse{Object: t}, nil
}

// DeleteTenant implements Tenants.
func (f *Fake) DeleteTenant(ctx context.Context, req *aigridv1.DeleteTenantRequest) (*aigridv1.DeleteTenantResponse, error) {
	f.LastDeleteTenant = req
	if err := f.begin(ctx, "DeleteTenant"); err != nil {
		return nil, err
	}
	for i, t := range f.Tenants {
		if t.GetId() == req.GetId() {
			f.Tenants = slices.Delete(f.Tenants, i, i+1)
			return &aigridv1.DeleteTenantResponse{}, nil
		}
	}
	return nil, status.Errorf(codes.NotFound, "object with identifier '%s' not found", req.GetId())
}

// noteTenantIDs raises lastTenantID to the highest `t-<n>` currently
// present (seeded ids included), so a later delete cannot free a number.
func (f *Fake) noteTenantIDs() {
	for _, t := range f.Tenants {
		if n, err := strconv.Atoi(strings.TrimPrefix(t.GetId(), "t-")); err == nil && n > f.lastTenantID {
			f.lastTenantID = n
		}
	}
}

// nextTenantID returns the next unused `t-<n>`: one past the highest number
// ever seen among the seeded ids and the ids handed out, deleted or not.
func (f *Fake) nextTenantID() string {
	f.noteTenantIDs()
	f.lastTenantID++
	return "t-" + strconv.Itoa(f.lastTenantID)
}

func (f *Fake) findTenant(id string) *aigridv1.Tenant {
	for _, t := range f.Tenants {
		if t.GetId() == id {
			return t
		}
	}
	return nil
}

// Status is a shorthand for a gRPC error.
func Status(code codes.Code, msg string) error { return status.Error(code, msg) }

// Start serves the fake over an in-memory connection and returns a client for
// it. Both are stopped when the test ends.
func Start(t *testing.T, fake *Fake) *backend.Client {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	aigridv1.RegisterAiGridServer(srv, fake)
	aigridv1.RegisterManagedClustersServer(srv, fake)
	aigridv1.RegisterTenantsServer(srv, fake)
	aigridv1.RegisterGridServer(srv, fake)
	aigridv1.RegisterModelsServer(srv, fake)
	aigridv1.RegisterCatalogItemsServer(srv, fake)
	aigridv1.RegisterSubscriptionsServer(srv, fake)
	go func() { _ = srv.Serve(lis) }()

	client, err := backend.Dial(backend.Config{Address: "passthrough:///bufconn", Insecure: true},
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		srv.Stop()
	})
	return client
}
