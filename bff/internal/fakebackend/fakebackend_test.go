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

// repoFixtures is the directory the console ships; the tests prove it loads
// and that every cluster looks like one on a real hub.
const repoFixtures = "../../../mock/fixtures"

func TestRepoFixturesLoad(t *testing.T) {
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.Clusters) < 6 {
		t.Fatalf("expected a cluster per state, got %d", len(fx.Clusters))
	}
	for _, c := range fx.Clusters {
		for _, want := range []string{LabelName, LabelCloud, LabelVendor, LabelClusterSet} {
			if _, ok := c.GetLabels()[want]; !ok {
				t.Errorf("cluster %s lacks the ACM label %q", c.GetName(), want)
			}
		}
		if c.GetLabels()[LabelName] != c.GetName() {
			t.Errorf("cluster %s: ACM sets label name=<cluster name>", c.GetName())
		}
		if isTrue(c, CondJoined) {
			for _, want := range []string{LabelClusterID, LabelOpenShiftVersion, LabelOpenShiftMajor, LabelOpenShiftMajorMin} {
				if _, ok := c.GetLabels()[want]; !ok {
					t.Errorf("joined cluster %s lacks the autodetect label %q", c.GetName(), want)
				}
			}
		} else if c.GetLabels()[LabelCloud] != LabelAutoDetect || len(c.GetStatus().GetClusterClaims()) != 0 {
			t.Errorf("cluster %s has not joined: cloud must still be auto-detect and claims empty", c.GetName())
		}
		if c.GetUid() == "" || c.GetResourceVersion() == "" || c.GetCreationTimestamp() == nil {
			t.Errorf("cluster %s lacks uid, resourceVersion or creationTimestamp", c.GetName())
		}
		if c.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNSPECIFIED || c.GetStatus().GetStateMessage() != "" {
			t.Errorf("cluster %s: state is derived by the server and must not be in the fixture", c.GetName())
		}
	}
	if _, err := New(fx, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
}

// knownConditions is the table of condition strings mock/research/acm.md
// section 1 verified against the controllers' source: type -> reason ->
// message prefixes. A fixture may only use these.
var knownConditions = map[string]map[string][]string{
	CondHubAccepted: {ReasonHubAccepted: {MessageHubAccepted}, ReasonHubDenied: {MessageHubDenied}, "Error": {""}},
	CondJoined:      {ReasonJoined: {MessageJoined}},
	CondAvailable: {
		ReasonAvailable:        {MessageAvailable},
		ReasonAPIServerUnavail: {"The kube-apiserver is not ok, status code: "},
		ReasonLeaseStopped:     {MessageLeaseStopped},
	},
	CondClockSynced: {ReasonClockSynced: {MessageClockSynced}, ReasonClockOutOfSync: {MessageClockOutOfSync}},
	CondImportSucceeded: {
		ReasonWaitForImporting: {MessageWaitForImporting},
		ReasonImporting:        {MessageImportStart, MessageImportWaitSecret, MessageImportApplied, MessageImportNoWorks, MessageImportWaitSecretH},
		ReasonImportFailed:     {"Try to import managed cluster, error: ", "Try to import managed cluster, apply resources error: ", "AutoImportSecretInvalid "},
		ReasonImported:         {MessageImported},
		ReasonDetaching:        {MessageDetaching},
		ReasonForceDetaching:   {MessageForceDetaching},
	},
	// Deleting messages are not verified by the research; the fake keeps them empty.
	CondDeleting: {ReasonResourceRemaining: {""}, ReasonNoResource: {""}, ReasonDeletingError: {""}},
}

// knownAddonValues are the values the addon discovery controller writes.
var knownAddonValues = map[string]bool{AddonAvailable: true, AddonUnhealthy: true, AddonUnreachable: true}

func TestRepoFixturesUseOnlyHubStrings(t *testing.T) {
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.Clusters {
		for _, cond := range c.GetStatus().GetConditions() {
			reasons, ok := knownConditions[cond.GetType()]
			if !ok {
				t.Errorf("%s: unknown condition type %q", c.GetName(), cond.GetType())
				continue
			}
			prefixes, ok := reasons[cond.GetReason()]
			if !ok {
				t.Errorf("%s/%s: unknown reason %q", c.GetName(), cond.GetType(), cond.GetReason())
				continue
			}
			matched := false
			for _, p := range prefixes {
				if strings.HasPrefix(cond.GetMessage(), p) {
					matched = true
				}
			}
			if !matched {
				t.Errorf("%s/%s/%s: message %q is not one the controller writes", c.GetName(), cond.GetType(), cond.GetReason(), cond.GetMessage())
			}
			if cond.GetLastTransitionTime() == nil {
				t.Errorf("%s/%s: lastTransitionTime missing", c.GetName(), cond.GetType())
			}
		}
		claims := c.GetStatus().GetClusterClaims()
		for i := 1; i < len(claims); i++ {
			if claims[i-1].GetName() >= claims[i].GetName() {
				t.Errorf("%s: claims must be one name-sorted list, %q before %q", c.GetName(), claims[i-1].GetName(), claims[i].GetName())
			}
		}
		for _, taint := range c.GetTaints() {
			if (taint.GetKey() == TaintUnreachable || taint.GetKey() == TaintUnavailable) && (taint.GetEffect() != TaintNoSelect || taint.GetTimeAdded() == nil) {
				t.Errorf("%s: hub taint %s must be NoSelect with timeAdded", c.GetName(), taint.GetKey())
			}
		}
		for k, v := range c.GetLabels() {
			if strings.HasPrefix(k, LabelAddonPrefix) && !knownAddonValues[v] {
				t.Errorf("%s: addon label %s=%q is not available|unhealthy|unreachable", c.GetName(), k, v)
			}
		}
		// The taint and the addon labels follow the Available condition.
		avail := findCondition(c, CondAvailable)
		switch {
		case avail.GetStatus() == aigridv1.ConditionStatus_CONDITION_STATUS_FALSE && !hasTaint(c, TaintUnavailable):
			t.Errorf("%s: Available=False needs the unavailable taint", c.GetName())
		case isTrue(c, CondJoined) && avail.GetStatus() == aigridv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED && !hasTaint(c, TaintUnreachable):
			t.Errorf("%s: Available=Unknown needs the unreachable taint", c.GetName())
		case isTrue(c, CondAvailable) && (hasTaint(c, TaintUnreachable) || hasTaint(c, TaintUnavailable)):
			t.Errorf("%s: Available=True removes the hub taints", c.GetName())
		}
	}
}

// TestRepoFixturesCoverEveryState pins the state each shipped cluster is
// seeded in, recomputed from its conditions, so a fixture edit that changes a
// state is noticed.
func TestRepoFixturesCoverEveryState(t *testing.T) {
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]aigridv1.ManagedClusterState{
		"local-cluster":    aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE,
		"site-paris-1":     aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE,
		"site-frankfurt-1": aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE,
		"site-madrid-1":    aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN,
		"site-ashburn-1":   aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE,
		"site-berlin-1":    aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING,
		"site-oslo-1":      aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT,
		"site-dublin-1":    aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORT_FAILED,
		"site-lisbon-1":    aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED,
		"edge-lyon-2":      aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING,
	}
	// Every value of the enum except UNSPECIFIED and the superseded PENDING is seeded.
	seededStates := map[aigridv1.ManagedClusterState]bool{}
	for _, st := range want {
		seededStates[st] = true
	}
	for v := range aigridv1.ManagedClusterState_name {
		st := aigridv1.ManagedClusterState(v)
		if st == aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNSPECIFIED || st == aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING {
			continue
		}
		if !seededStates[st] {
			t.Errorf("no fixture cluster derives %s", st)
		}
	}
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	s.SetClock(func() time.Time { return time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC) }) // before any scenario fires
	resp, err := s.ListManagedClusters(authed(context.Background()), &aigridv1.ListManagedClustersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, c := range resp.GetClusters() {
		seen[c.GetName()] = true
		if c.GetName() == "site-paris-1" && c.GetStatus().GetCapacity()["nvidia.com/gpu"] == "" {
			t.Error("the ready GPU cluster must advertise nvidia.com/gpu")
		}
		if got := c.GetStatus().GetState(); got != want[c.GetName()] {
			t.Errorf("%s: state %s, want %s", c.GetName(), got, want[c.GetName()])
		}
		if c.GetStatus().GetStateMessage() == "" {
			t.Errorf("%s: a decided state carries the deciding condition's message", c.GetName())
		}
		if c.GetName() == "edge-lyon-2" && findCondition(c, CondDeleting).GetReason() != ReasonResourceRemaining {
			t.Error("the detaching cluster carries Deleting/ResourceRemaining while its finalizers drain")
		}
	}
	for name := range want {
		if !seen[name] {
			t.Errorf("fixture cluster %s missing from the list", name)
		}
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
	write("tenants.json", `{"realmMissing": true, "unavailable": "x"}`)
	if _, err := Load(dir); err == nil {
		t.Error("realmMissing and unavailable together should fail")
	}
	write("tenants.json", `{"realmMissing": true}`)
	if fx, err := Load(dir); err != nil || !fx.TenantsRealmMissing || fx.Tenants != nil {
		t.Errorf("realmMissing fixture = %+v, %v", fx, err)
	}
	write("tenants.json", `{"organizationsDisabled": true, "realmMissing": true}`)
	if _, err := Load(dir); err == nil {
		t.Error("two realm modes together should fail")
	}
	write("tenants.json", `{"organizationsDisabled": true}`)
	if fx, err := Load(dir); err != nil || !fx.TenantsOrgsDisabled {
		t.Errorf("organizationsDisabled fixture = %+v, %v", fx, err)
	}
	write("tenants.json", `{"unavailable": "request Keycloak token: dial tcp: lookup keycloak.ai-grid.svc: no such host"}`)
	write("settings.json", `{"latency": "15ms"}`)
	fx, err = Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fx.Latency.Duration() != 15*time.Millisecond || fx.TenantsUnavailable == "" || fx.Speed != 0 {
		t.Errorf("fixtures = %+v", fx)
	}
	write("settings.json", `{"speed": 0}`)
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "speed") {
		t.Errorf("speed 0 must be rejected, got %v", err)
	}
	write("settings.json", `{"speed": 2.5}`)
	if fx, err := Load(dir); err != nil || fx.Speed != 2.5 {
		t.Errorf("speed = %v, %v", fx, err)
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
		Tenants:  []*aigridv1.Tenant{{Id: "4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", Name: "t-corp", Domains: []string{"t.example.com"}}},
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
		Tenants: []*aigridv1.Tenant{{Id: "6b1f0b4e-2f6a-4a2a-8c1e-0f3a2b4c5d6e", Name: "b-corp"}, {Id: "9d0c7e21-4b3a-4f1e-a2b3-c4d5e6f7a8b9", Name: "a-corp", Domains: []string{"a.example.com"}}},
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

	s.TenantsErr = status.Error(codes.Unavailable, "Keycloak is unavailable: request Keycloak token: connection refused")
	if _, err := aigridv1.NewTenantsClient(conn).ListTenants(ctx, &aigridv1.ListTenantsRequest{}); status.Code(err) != codes.Unavailable {
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
