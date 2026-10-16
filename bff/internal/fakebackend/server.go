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
	"slices"
	"sort"
	"strconv"
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
	// resourceVersion is the last value handed out, like etcd's revision:
	// one counter for the whole store, bumped on every write.
	resourceVersion int64
	// Scenario state: timed transitions evaluated lazily against Clock.
	scenarios []*scenario
	start     time.Time
	speed     float64
	// clock is the time source for scenarios, condition transition times
	// and taint stamps; time.Now unless SetClock replaced it.
	clock func() time.Time
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
		speed:    fx.Speed,
		clock:    time.Now,
		Latency:  fx.Latency.Duration(),
		logger:   logger,
	}
	if s.speed <= 0 {
		s.speed = 1
	}
	for _, c := range fx.Clusters {
		if c.GetName() == "" {
			return nil, fmt.Errorf("fixture cluster without a name")
		}
		if _, dup := s.clusters[c.GetName()]; dup {
			return nil, fmt.Errorf("fixture cluster %q listed twice", c.GetName())
		}
		c = cloneCluster(c)
		sortClaims(c)
		if rv, err := strconv.ParseInt(c.GetResourceVersion(), 10, 64); err == nil && rv > s.resourceVersion {
			s.resourceVersion = rv
		}
		s.clusters[c.GetName()] = c
	}
	names := make([]string, 0, len(s.clusters))
	for name := range s.clusters {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if c := s.clusters[name]; c.GetResourceVersion() == "" {
			s.bumpResourceVersion(c)
		}
	}
	scenarios, err := parseScenarios(fx.Scenarios, s.clusters)
	if err != nil {
		return nil, err
	}
	s.scenarios = scenarios
	s.start = s.clock()
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

// SetClock replaces the time source and restarts the scenario clock from it,
// so tests drive transitions deterministically.
func (s *Server) SetClock(clock func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clock = clock
	s.start = clock()
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

// bumpResourceVersion stamps a written object with the next store revision.
// Must be called under s.mu.
func (s *Server) bumpResourceVersion(c *aigridv1.ManagedCluster) {
	s.resourceVersion++
	c.ResourceVersion = strconv.FormatInt(s.resourceVersion, 10)
}

// authenticate enforces the identity contract of
// mock/research/backend-conventions.md section 5.6: every RPC except Ping,
// health and reflection needs an `authorization` metadata value of the form
// `Bearer <token>`; the x-forwarded-* headers are advisory and only logged.
// It returns the bearer token.
func authenticate(ctx context.Context) (string, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) != 1 {
		return "", status.Error(codes.Unauthenticated, "missing authorization metadata")
	}
	token, ok := strings.CutPrefix(values[0], "Bearer ")
	if !ok || strings.TrimSpace(token) == "" {
		return "", status.Error(codes.Unauthenticated, "authorization metadata must be 'Bearer <token>'")
	}
	return token, nil
}

// authorizePatch is the hub's RBAC answer for a mutating RPC, taken from the
// same access fixture the fake hub uses for the BFF's SelfSubjectAccessReview,
// so a token that is not a provider admin there cannot write here either
// (backend-conventions.md section 5.6: hub 401 -> Unauthenticated, hub 403 ->
// PermissionDenied). The message is shaped like the API server's Forbidden
// status; the user name comes from the advisory x-forwarded-user header.
func (s *Server) authorizePatch(ctx context.Context, token, name string) error {
	if err := s.rejected(token); err != nil {
		return err
	}
	if !s.access.DefaultAllowed || slices.Contains(s.access.DeniedTokens, token) {
		md, _ := metadata.FromIncomingContext(ctx)
		user := strings.Join(md.Get("x-forwarded-user"), ",")
		return status.Errorf(codes.PermissionDenied,
			"managedclusters.cluster.open-cluster-management.io %q is forbidden: User %q cannot patch resource \"managedclusters\" in API group \"cluster.open-cluster-management.io\" at the cluster scope", name, user)
	}
	return nil
}

// rejected is the hub's 401 for a token in access.json's rejectedTokens (an
// expired or revoked OpenShift token), which the backend reports as
// Unauthenticated on any call, reads included; a merely denied token still
// reads and fails only on writes (authorizePatch).
func (s *Server) rejected(token string) error {
	if slices.Contains(s.access.RejectedTokens, token) {
		return status.Error(codes.Unauthenticated, "the hub rejected the token: Unauthorized")
	}
	return nil
}

// begin is what every authenticated RPC does first: check the caller's
// bearer token is present and not rejected, then take the hub round trip.
// It returns the token for the RBAC check a mutating RPC adds.
func (s *Server) begin(ctx context.Context) (string, error) {
	token, err := authenticate(ctx)
	if err != nil {
		return "", err
	}
	if err := s.rejected(token); err != nil {
		return "", err
	}
	return token, s.wait(ctx)
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

// ListTenants implements Tenants. Keycloak returns organizations ordered by
// name; the real backend passes that order through.
func (s *Server) ListTenants(ctx context.Context, _ *aigridv1.ListTenantsRequest) (*aigridv1.ListTenantsResponse, error) {
	if _, err := s.begin(ctx); err != nil {
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
