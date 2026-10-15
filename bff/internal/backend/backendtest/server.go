// Package backendtest runs an in-memory ai-grid-backend for handler tests.
package backendtest

import (
	"context"
	"net"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
)

// Fake answers the three shipped backend services from fixed data and the
// draft-only services with Unimplemented. Set Err to make
// every RPC fail with that status. Metadata records the incoming metadata of
// the last call so tests can assert on identity forwarding.
type Fake struct {
	aigridv1.UnimplementedAiGridServer
	aigridv1.UnimplementedManagedClustersServer
	aigridv1.UnimplementedTenantsServer
	aigridv1.UnimplementedGridServer
	aigridv1.UnimplementedModelsServer
	aigridv1.UnimplementedCatalogItemsServer
	aigridv1.UnimplementedSubscriptionsServer

	Clusters []*aigridv1.ManagedCluster
	Tenants  []*aigridv1.Tenant
	Err      error
	Metadata metadata.MD
}

func (f *Fake) record(ctx context.Context) error {
	md, _ := metadata.FromIncomingContext(ctx)
	f.Metadata = md
	return f.Err
}

// Ping implements AiGrid.
func (f *Fake) Ping(ctx context.Context, req *aigridv1.PingRequest) (*aigridv1.PingResponse, error) {
	if err := f.record(ctx); err != nil {
		return nil, err
	}
	return &aigridv1.PingResponse{Message: "pong " + req.GetName()}, nil
}

// ListManagedClusters implements ManagedClusters.
func (f *Fake) ListManagedClusters(ctx context.Context, _ *aigridv1.ListManagedClustersRequest) (*aigridv1.ListManagedClustersResponse, error) {
	if err := f.record(ctx); err != nil {
		return nil, err
	}
	return &aigridv1.ListManagedClustersResponse{Clusters: f.Clusters}, nil
}

// ListTenants implements Tenants.
func (f *Fake) ListTenants(ctx context.Context, _ *aigridv1.ListTenantsRequest) (*aigridv1.ListTenantsResponse, error) {
	if err := f.record(ctx); err != nil {
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
