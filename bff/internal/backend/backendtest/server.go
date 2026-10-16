// Package backendtest runs an in-memory ai-grid-backend for handler tests.
package backendtest

import (
	"context"
	"maps"
	"net"
	"strconv"
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
}

// begin records the call and returns the injected error for it, if any.
func (f *Fake) begin(ctx context.Context, method string) error {
	md, _ := metadata.FromIncomingContext(ctx)
	f.Metadata = md
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

// ListTenants implements Tenants.
func (f *Fake) ListTenants(ctx context.Context, _ *aigridv1.ListTenantsRequest) (*aigridv1.ListTenantsResponse, error) {
	if err := f.begin(ctx, "ListTenants"); err != nil {
		return nil, err
	}
	return &aigridv1.ListTenantsResponse{Tenants: f.Tenants}, nil
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
