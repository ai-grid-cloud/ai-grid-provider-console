package fakebackend

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	healthv1 "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// repoFixtures is the directory the console ships; the test proves it loads
// and that every cluster carries the labels ACM sets on a real hub.
const repoFixtures = "../../../mock/fixtures"

func TestRepoFixturesLoad(t *testing.T) {
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.Clusters) < 2 {
		t.Fatalf("expected several clusters, got %d", len(fx.Clusters))
	}
	for _, c := range fx.Clusters {
		for _, want := range []string{"name", "cloud", "vendor", "openshiftVersion", "openshiftVersion-major-minor", "clusterID", "cluster.open-cluster-management.io/clusterset"} {
			if _, ok := c.GetLabels()[want]; !ok {
				t.Errorf("cluster %s lacks the ACM label %q", c.GetName(), want)
			}
		}
		if c.GetLabels()["name"] != c.GetName() {
			t.Errorf("cluster %s: ACM sets label name=<cluster name>", c.GetName())
		}
	}
	if _, err := New(fx, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
}

func TestLoadRejectsBadFixtures(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("managedclusters.json", `{"clusters": [{"name": "a", "nope": 1}]}`)
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "cluster 0") {
		t.Errorf("unknown proto field should fail with position, got %v", err)
	}
	write("managedclusters.json", `{"clusters": [{"name": "a"}, {"name": "a"}]}`)
	fx, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(fx, nil); err == nil {
		t.Error("duplicate cluster names should fail")
	}
	write("managedclusters.json", `{"clusters": []}`)
	write("tenants.json", `{"tenants": [], "unavailable": "x"}`)
	if _, err := Load(dir); err == nil {
		t.Error("tenants and unavailable together should fail")
	}
	write("tenants.json", `{"unavailable": "request Keycloak token: dial tcp: lookup keycloak.ai-grid.svc: no such host"}`)
	write("settings.json", `{"latency": "15ms"}`)
	fx, err = Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fx.Latency.Duration() != 15*time.Millisecond || fx.TenantsUnavailable == "" {
		t.Errorf("fixtures = %+v", fx)
	}
}

// TestLoadRequiresTheDirectory: a mistyped --fixtures path must not start an
// empty backend that allows everyone; an empty directory, by contrast, is a
// valid, deliberately empty backend.
func TestLoadRequiresTheDirectory(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "fixturez")
	if _, err := Load(missing); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("nonexistent directory should fail with ErrNotExist, got %v", err)
	}
	file := filepath.Join(t.TempDir(), "fixtures.json")
	if err := os.WriteFile(file, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(file); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Errorf("a file is not a fixtures directory, got %v", err)
	}
	fx, err := Load(t.TempDir())
	if err != nil {
		t.Fatalf("an empty directory is a valid empty backend, got %v", err)
	}
	if len(fx.Clusters) != 0 || fx.Tenants != nil || fx.TenantsUnavailable != "" || !fx.Access.DefaultAllowed || fx.Latency.Duration() != 0 {
		t.Errorf("empty directory should load defaults, got %+v", fx)
	}
}

// authed is the metadata the BFF forwards with every RPC, so direct calls
// into the Server look like calls that came through the BFF.
func authed(ctx context.Context) context.Context {
	return metadata.NewIncomingContext(ctx, metadata.Pairs("authorization", "Bearer dev-token", "x-forwarded-user", "dev-user"))
}

// TestNewCopiesTheFixtures: New must not keep the caller's pointers, or a
// later change to fx would alter the served state without the server's lock.
func TestNewCopiesTheFixtures(t *testing.T) {
	fx := &Fixtures{
		Clusters: []*aigridv1.ManagedCluster{{Name: "a", Labels: map[string]string{"name": "a"}}},
		Tenants:  []*aigridv1.Tenant{{Id: "1", Name: "t-corp", Domains: []string{"t.example.com"}}},
	}
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	fx.Clusters[0].Labels["name"] = "changed"
	fx.Clusters[0].HubAcceptsClient = true
	fx.Tenants[0].Name = "changed"
	fx.Tenants[0].Domains[0] = "changed.example.com"

	ctx := authed(context.Background())
	clusters, err := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if c := clusters.GetClusters()[0]; c.GetLabels()["name"] != "a" || c.GetHubAcceptsClient() {
		t.Errorf("cluster state followed a fixture change made after New: %v", c)
	}
	tenants, err := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if tn := tenants.GetTenants()[0]; tn.GetName() != "t-corp" || tn.GetDomains()[0] != "t.example.com" {
		t.Errorf("tenant state followed a fixture change made after New: %v", tn)
	}
}

func dial(t *testing.T, s *Server) *grpc.ClientConn {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	s.Register(srv)
	go func() { _ = srv.Serve(lis) }()
	conn, err := grpc.NewClient("passthrough:///bufconn", grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(); srv.Stop() })
	return conn
}

func TestServerBehavesLikeTheBackend(t *testing.T) {
	fx := &Fixtures{
		Clusters: []*aigridv1.ManagedCluster{
			{Name: "zeta", Labels: map[string]string{"name": "zeta"}, HubAcceptsClient: true},
			{Name: "alpha", Labels: map[string]string{"name": "alpha"}, HubAcceptsClient: true},
		},
		Tenants: []*aigridv1.Tenant{{Id: "1", Name: "b-corp"}, {Id: "2", Name: "a-corp", Domains: []string{"a.example.com"}}},
	}
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	conn := dial(t, s)
	ctx := metadata.AppendToOutgoingContext(context.Background(), "x-forwarded-user", "alice", "authorization", "Bearer t")

	pong, err := aigridv1.NewAiGridClient(conn).Ping(ctx, &aigridv1.PingRequest{Name: "bff"})
	if err != nil || pong.GetMessage() != "Hello, bff!" {
		t.Fatalf("Ping = %v, %v", pong, err)
	}
	clusters, err := aigridv1.NewManagedClustersClient(conn).ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{})
	if err != nil || len(clusters.GetClusters()) != 2 || clusters.GetClusters()[0].GetName() != "alpha" {
		t.Fatalf("clusters should be sorted by name: %v, %v", clusters, err)
	}
	// Over gRPC the client always gets its own decoded objects, so the copy
	// guarantee is checked on the Server directly: mutate a response, list again.
	direct, err := s.ListManagedClusters(authed(context.Background()), &aigridv1.ListManagedClustersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	direct.GetClusters()[0].Labels["mutated"] = "yes"
	direct.GetClusters()[0].Name = "mutated"
	again, err := s.ListManagedClusters(authed(context.Background()), &aigridv1.ListManagedClustersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if c := again.GetClusters()[0]; c.GetName() != "alpha" || c.GetLabels()["mutated"] != "" {
		t.Errorf("responses must be copies of the server state, got %v", c)
	}
	tenants, err := aigridv1.NewTenantsClient(conn).ListTenants(ctx, &aigridv1.ListTenantsRequest{})
	if err != nil || len(tenants.GetTenants()) != 2 || tenants.GetTenants()[0].GetName() != "a-corp" {
		t.Fatalf("tenants should be sorted by name: %v, %v", tenants, err)
	}

	s.TenantsErr = status.Error(codes.Unknown, "request Keycloak token: connection refused")
	if _, err := aigridv1.NewTenantsClient(conn).ListTenants(ctx, &aigridv1.ListTenantsRequest{}); status.Code(err) != codes.Unknown {
		t.Errorf("tenants error should pass through with its code, got %v", err)
	}
}

// TestShutdownClosesOpenStreams: a health Watch never ends on its own, so an
// unbounded GracefulStop would keep Serve (and the process) alive forever.
func TestShutdownClosesOpenStreams(t *testing.T) {
	s, err := New(&Fixtures{}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	s.stopTimeout = 100 * time.Millisecond
	lis := bufconn.Listen(1 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	served := make(chan error, 1)
	go func() { served <- s.serve(ctx, lis) }()
	conn, err := grpc.NewClient("passthrough:///bufconn", grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	watch, err := healthv1.NewHealthClient(conn).Watch(context.Background(), &healthv1.HealthCheckRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if first, err := watch.Recv(); err != nil || first.GetStatus() != healthv1.HealthCheckResponse_SERVING {
		t.Fatalf("health Watch = %v, %v", first, err)
	}

	cancel()
	select {
	case err := <-served:
		if err != nil {
			t.Errorf("Serve returned %v after cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return while a health Watch stream was open: shutdown must be bounded")
	}
	if _, err := watch.Recv(); err == nil {
		t.Error("the Watch stream should be closed by the forced stop")
	}
}

func TestLatencyHonoursCancellation(t *testing.T) {
	s, _ := New(&Fixtures{Latency: Duration{d: time.Second}}, slog.New(slog.DiscardHandler))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := s.Ping(ctx, &aigridv1.PingRequest{})
	if status.Code(err) != codes.DeadlineExceeded {
		t.Errorf("expected DeadlineExceeded, got %v", err)
	}
}

func TestHubAccessReview(t *testing.T) {
	h := NewHub(Access{DefaultAllowed: true, DeniedTokens: []string{"viewer"}, RejectedTokens: []string{"expired"}}, slog.New(slog.DiscardHandler))
	srv := httptest.NewServer(h.Handler())
	defer srv.Close()
	review := func(token string) (int, bool) {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
			strings.NewReader(`{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"group":"cluster.open-cluster-management.io","resource":"managedclusters","verb":"patch"}}}`))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var out struct {
			Status struct{ Allowed bool } `json:"status"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out.Status.Allowed
	}
	if code, allowed := review("admin-token"); code != http.StatusCreated || !allowed {
		t.Errorf("admin: %d %v", code, allowed)
	}
	if code, allowed := review("viewer"); code != http.StatusCreated || allowed {
		t.Errorf("viewer: %d %v", code, allowed)
	}
	if code, _ := review("expired"); code != http.StatusUnauthorized {
		t.Errorf("expired: %d", code)
	}
	if code, _ := review(""); code != http.StatusUnauthorized {
		t.Errorf("no token: %d", code)
	}
	resp, err := http.Get(srv.URL + "/api/v1/namespaces")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("other paths: %d", resp.StatusCode)
	}
}

// TestFakeImplementsEveryProtoService fails when the draft proto gains a
// service the fake does not register: the signal to extend the fake (or add
// an explicit Unimplemented registration) the same day the proto changes. It
// walks every file of package ai_grid.v1 that is linked into the binary.
func TestFakeImplementsEveryProtoService(t *testing.T) {
	s, _ := New(&Fixtures{}, slog.New(slog.DiscardHandler))
	srv := grpc.NewServer()
	s.Register(srv)
	registered := srv.GetServiceInfo()
	var services []protoreflect.ServiceDescriptor
	protoregistry.GlobalFiles.RangeFilesByPackage("ai_grid.v1", func(file protoreflect.FileDescriptor) bool {
		for i := 0; i < file.Services().Len(); i++ {
			services = append(services, file.Services().Get(i))
		}
		return true
	})
	if len(services) < 7 {
		t.Fatalf("expected the draft proto's seven services to be linked in, found %d", len(services))
	}
	for _, svc := range services {
		info, ok := registered[string(svc.FullName())]
		if !ok {
			t.Errorf("proto service %s is not registered by the fake", svc.FullName())
			continue
		}
		methods := map[string]bool{}
		for _, m := range info.Methods {
			methods[m.Name] = true
		}
		for j := 0; j < svc.Methods().Len(); j++ {
			if name := string(svc.Methods().Get(j).Name()); !methods[name] {
				t.Errorf("fake registers %s without method %s", svc.FullName(), name)
			}
		}
	}
}
