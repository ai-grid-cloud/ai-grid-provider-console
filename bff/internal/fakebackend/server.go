// Package fakebackend is a stand-in for ai-grid-backend that behaves like the
// real service against a real hub, without a hub. It serves the ai_grid.v1
// gRPC services from fixtures (mock/fixtures) and a minimal Kubernetes API
// that answers the BFF's SelfSubjectAccessReview, so `make dev-fake` runs the
// whole console on a laptop.
//
// The point of the fake is faithfulness, not convenience: every behaviour it
// simulates (field shapes, condition strings, error codes, latency) is taken
// from the real cluster and the backend's conventions, see mock/README.md.
// When the real backend gains an RPC, the fake gains the same RPC with the same
// semantics; RPCs that do not exist yet answer codes.Unimplemented, exactly
// as the real server does, so the BFF and the UI can be built against the gap.
package fakebackend

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthv1 "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Server holds the in-memory state behind the fake RPCs. It is safe for
// concurrent use.
type Server struct {
	aigridv1.UnimplementedAiGridServer
	aigridv1.UnimplementedManagedClustersServer
	aigridv1.UnimplementedTenantsServer
	// Services whose shape is drafted but not agreed answer Unimplemented, as
	// the real server does for a stub; see mock/proto/ai_grid/v1/*_service.proto.
	aigridv1.UnimplementedGridServer
	aigridv1.UnimplementedModelsServer
	aigridv1.UnimplementedCatalogItemsServer
	aigridv1.UnimplementedSubscriptionsServer

	mu       sync.RWMutex
	clusters map[string]*aigridv1.ManagedCluster
	tenants  map[string]*aigridv1.Tenant
	access   Access
	// Latency is added to every RPC to resemble a hub round trip.
	Latency time.Duration
	// TenantsErr, when set, makes every Tenants RPC fail with it. It models a
	// backend whose Keycloak is unreachable or has no realm, the state of the
	// dev hub today, so the UI's error path is exercised with a real code.
	TenantsErr error
	// stopTimeout bounds GracefulStop in Serve; zero means defaultStopTimeout.
	stopTimeout time.Duration
	logger      *slog.Logger
}

// defaultStopTimeout is how long Serve drains in-flight RPCs on shutdown
// before it closes the connections that are still open, typically a health
// Watch or a reflection stream a client never ends.
const defaultStopTimeout = 5 * time.Second

// New builds a server from fixtures. Fixture validation errors are returned so
// a typo in mock/fixtures fails fast instead of serving nonsense. The fixture
// messages are copied: the caller keeps fx and may change it afterwards
// without touching the server's state, which only changes under s.mu.
func New(fx *Fixtures, logger *slog.Logger) (*Server, error) {
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{
		clusters: map[string]*aigridv1.ManagedCluster{},
		tenants:  map[string]*aigridv1.Tenant{},
		access:   fx.Access,
		Latency:  fx.Latency.Duration(),
		logger:   logger,
	}
	for _, c := range fx.Clusters {
		if c.GetName() == "" {
			return nil, fmt.Errorf("fixture cluster without a name")
		}
		if _, dup := s.clusters[c.GetName()]; dup {
			return nil, fmt.Errorf("fixture cluster %q listed twice", c.GetName())
		}
		s.clusters[c.GetName()] = cloneCluster(c)
	}
	for _, t := range fx.Tenants {
		if t.GetId() == "" || t.GetName() == "" {
			return nil, fmt.Errorf("fixture tenant needs id and name: %v", t)
		}
		if _, dup := s.tenants[t.GetId()]; dup {
			return nil, fmt.Errorf("fixture tenant id %q listed twice", t.GetId())
		}
		s.tenants[t.GetId()] = cloneTenant(t)
	}
	if fx.Tenants == nil && fx.TenantsUnavailable != "" {
		s.TenantsErr = status.Error(codes.Unknown, fx.TenantsUnavailable)
	}
	return s, nil
}

// Register attaches every service of the draft proto, the health service and
// reflection, the same set the real backend registers. Methods the fake does
// not implement answer Unimplemented from the embedded Unimplemented*Server.
func (s *Server) Register(srv *grpc.Server) {
	aigridv1.RegisterAiGridServer(srv, s)
	aigridv1.RegisterManagedClustersServer(srv, s)
	aigridv1.RegisterTenantsServer(srv, s)
	aigridv1.RegisterGridServer(srv, s)
	aigridv1.RegisterModelsServer(srv, s)
	aigridv1.RegisterCatalogItemsServer(srv, s)
	aigridv1.RegisterSubscriptionsServer(srv, s)
	h := health.NewServer()
	h.SetServingStatus("", healthv1.HealthCheckResponse_SERVING)
	healthv1.RegisterHealthServer(srv, h)
	reflection.Register(srv)
}

// Serve listens on addr until ctx is done. Shutdown is graceful: in-flight
// RPCs finish, but after stopTimeout the streams still open are closed, so a
// client holding a health Watch cannot keep the process alive after SIGTERM.
func (s *Server) Serve(ctx context.Context, addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	return s.serve(ctx, lis)
}

func (s *Server) serve(ctx context.Context, lis net.Listener) error {
	srv := grpc.NewServer(grpc.ChainUnaryInterceptor(s.logCalls))
	s.Register(srv)
	go func() {
		<-ctx.Done()
		s.stop(srv)
	}()
	s.logger.Info("fake ai-grid-backend listening", "addr", lis.Addr().String())
	if err := srv.Serve(lis); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

// stop drains srv gracefully and forces the stop once stopTimeout has passed,
// the bounded shutdown gRPC recommends: GracefulStop alone waits for every
// stream to end, which a long-lived Watch never does on its own.
func (s *Server) stop(srv *grpc.Server) {
	timeout := s.stopTimeout
	if timeout <= 0 {
		timeout = defaultStopTimeout
	}
	drained := make(chan struct{})
	go func() {
		srv.GracefulStop()
		close(drained)
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-drained:
	case <-timer.C:
		s.logger.Warn("graceful stop timed out, closing the streams still open", "timeout", timeout)
		srv.Stop()
		<-drained
	}
}

// logCalls logs each RPC with the forwarded identity, which is what the real
// backend sees, so developers can check the BFF forwards the right metadata.
func (s *Server) logCalls(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	start := time.Now()
	resp, err := handler(ctx, req)
	md, _ := metadata.FromIncomingContext(ctx)
	user := strings.Join(md.Get("x-forwarded-user"), ",")
	code := codes.OK
	if err != nil {
		code = status.Code(err)
	}
	s.logger.Info("rpc", "method", info.FullMethod, "user", user, "hasToken", len(md.Get("authorization")) > 0, "code", code.String(), "duration", time.Since(start).Round(time.Millisecond))
	return resp, err
}

// wait simulates the hub round trip and honours cancellation like a real call.
func (s *Server) wait(ctx context.Context) error {
	if s.Latency <= 0 {
		return ctx.Err()
	}
	select {
	case <-time.After(s.Latency):
		return nil
	case <-ctx.Done():
		return status.FromContextError(ctx.Err()).Err()
	}
}

// Ping implements AiGrid. The real server answers "Hello, <name>!".
func (s *Server) Ping(ctx context.Context, req *aigridv1.PingRequest) (*aigridv1.PingResponse, error) {
	if err := s.wait(ctx); err != nil {
		return nil, err
	}
	return &aigridv1.PingResponse{Message: fmt.Sprintf("Hello, %s!", req.GetName())}, nil
}

// ListManagedClusters implements ManagedClusters. Like a hub list, the result
// is sorted by name and every cluster carries the labels ACM sets.
func (s *Server) ListManagedClusters(ctx context.Context, _ *aigridv1.ListManagedClustersRequest) (*aigridv1.ListManagedClustersResponse, error) {
	if err := s.wait(ctx); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*aigridv1.ManagedCluster, 0, len(s.clusters))
	for _, c := range s.clusters {
		out = append(out, cloneCluster(c))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetName() < out[j].GetName() })
	return &aigridv1.ListManagedClustersResponse{Clusters: out}, nil
}

// ListTenants implements Tenants. Keycloak returns organizations ordered by
// name; the real backend passes that order through.
func (s *Server) ListTenants(ctx context.Context, _ *aigridv1.ListTenantsRequest) (*aigridv1.ListTenantsResponse, error) {
	if err := s.wait(ctx); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.TenantsErr != nil {
		return nil, s.TenantsErr
	}
	out := make([]*aigridv1.Tenant, 0, len(s.tenants))
	for _, t := range s.tenants {
		out = append(out, cloneTenant(t))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetName() < out[j].GetName() })
	return &aigridv1.ListTenantsResponse{Tenants: out}, nil
}

// Responses are deep copies so a caller cannot mutate the fixture state.
func cloneCluster(c *aigridv1.ManagedCluster) *aigridv1.ManagedCluster {
	return proto.Clone(c).(*aigridv1.ManagedCluster)
}

func cloneTenant(t *aigridv1.Tenant) *aigridv1.Tenant {
	return proto.Clone(t).(*aigridv1.Tenant)
}
