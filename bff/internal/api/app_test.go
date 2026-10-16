package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/hub"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	cfg, err := config.Parse([]string{"--hub-api-url=https://hub.invalid"}, func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// fakeHub stands in for the hub API server: it answers every
// SelfSubjectAccessReview with allowed, or fails with status when set.
type fakeHub struct {
	allowed bool
	status  int
	auth    string
}

func (f *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.auth = r.Header.Get("Authorization")
	if f.status != 0 {
		http.Error(w, http.StatusText(f.status), f.status)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte(`{"status":{"allowed":` + strconv.FormatBool(f.allowed) + `}}`))
}

func startHub(t *testing.T, f *fakeHub) *hub.Client {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c, err := hub.New(hub.Config{URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func newTestApp(t *testing.T, cfg config.Config, fake *backendtest.Fake) *App {
	t.Helper()
	return newTestAppWithHub(t, cfg, fake, &fakeHub{allowed: true})
}

func newTestAppWithHub(t *testing.T, cfg config.Config, fake *backendtest.Fake, h *fakeHub) *App {
	t.Helper()
	if fake == nil {
		fake = &backendtest.Fake{}
	}
	return NewApp(cfg, slog.New(slog.DiscardHandler), backendtest.Start(t, fake), startHub(t, h))
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return body
}

func decodeData(t *testing.T, rec *httptest.ResponseRecorder, into any) {
	t.Helper()
	var env struct{ Data json.RawMessage }
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope %q: %v", rec.Body.String(), err)
	}
	if err := json.Unmarshal(env.Data, into); err != nil {
		t.Fatalf("decode data %q: %v", env.Data, err)
	}
}

// asUser builds an authenticated request the way kube-auth-proxy would.
func asUser(method, path string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set(config.DefaultAuthTokenHeader, "sha256~token")
	req.Header.Set(config.DefaultAuthUserHeader, "alice")
	req.Header.Set(config.DefaultAuthEmailHeader, "alice@example.com")
	req.Header.Set(config.DefaultAuthGroupsHeader, "system:authenticated,cluster-admins")
	return req
}

func serve(app *App, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}

func TestHealthcheckNeedsNoToken(t *testing.T) {
	app := newTestApp(t, testConfig(t), nil)
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/healthcheck", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body healthStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Status != "ok" {
		t.Fatalf("body = %s, err = %v", rec.Body.String(), err)
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("missing X-Request-Id")
	}
}

func TestReadyzReflectsBackend(t *testing.T) {
	fake := &backendtest.Fake{}
	app := newTestApp(t, testConfig(t), fake)
	if rec := serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("ready status = %d %s", rec.Code, rec.Body.String())
	}
	if fake.Metadata.Get("authorization") != nil {
		t.Fatal("readiness probe must not forward credentials")
	}
	fake.Err = backendtest.Status(codes.Unavailable, "down")
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("not-ready status = %d", rec.Code)
	}
}

func TestAPIRequiresToken(t *testing.T) {
	app := newTestApp(t, testConfig(t), nil)
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/api/v1/clusters", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if body := decodeError(t, rec); body.Error.Code != "401" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	rec := serve(newTestApp(t, testConfig(t), nil), asUser(http.MethodGet, "/api/v1/nope"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type = %q", ct)
	}
}

func TestUserFromProxyHeaders(t *testing.T) {
	cfg := testConfig(t)
	h := &fakeHub{allowed: true}
	var u User
	rec := serve(newTestAppWithHub(t, cfg, nil, h), asUser(http.MethodGet, "/api/v1/user"))
	decodeData(t, rec, &u)
	if u.Username != "alice" || u.Email != "alice@example.com" || len(u.Groups) != 2 || !u.IsProviderAdmin {
		t.Fatalf("user = %+v", u)
	}
	if h.auth != "Bearer sha256~token" {
		t.Fatalf("the access review must carry the caller's own token, got %q", h.auth)
	}

	rec = serve(newTestAppWithHub(t, cfg, nil, &fakeHub{allowed: false}), asUser(http.MethodGet, "/api/v1/user"))
	decodeData(t, rec, &u)
	if u.IsProviderAdmin {
		t.Fatal("the hub denied patch on managedclusters; alice is not a provider admin")
	}

	rec = serve(newTestAppWithHub(t, cfg, nil, &fakeHub{status: http.StatusUnauthorized}), asUser(http.MethodGet, "/api/v1/user"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired token should give 401, got %d %s", rec.Code, rec.Body.String())
	}

	rec = serve(newTestAppWithHub(t, cfg, nil, &fakeHub{status: http.StatusBadGateway}), asUser(http.MethodGet, "/api/v1/user"))
	if rec.Code != http.StatusBadGateway || decodeError(t, rec).Error.Message == "" {
		t.Fatalf("hub failure should give 502 with a message, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestConfigEndpoint(t *testing.T) {
	cfg := testConfig(t)
	cfg.GridEndpoint = "https://grid.example.com"
	var out ConsoleConfig
	decodeData(t, serve(newTestApp(t, cfg, nil), asUser(http.MethodGet, "/api/v1/config")), &out)
	if out.GridEndpoint != cfg.GridEndpoint || out.Version != Version {
		t.Fatalf("config = %+v", out)
	}
}

func TestClustersFromBackend(t *testing.T) {
	fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{
		{Name: "site-1", HubAcceptsClient: true, Labels: map[string]string{LabelEnabled: "true", LabelProvisioned: "true", LabelLocation: "brussels", LabelSite: "brussels-dc1", LabelRegion: "europe-west"}},
		{Name: "local-cluster", HubAcceptsClient: true, Labels: map[string]string{LabelOpenShiftVersion: "4.22.15"}},
	}}
	app := newTestApp(t, testConfig(t), fake)

	var list []GridCluster
	rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &list)
	if len(list) != 2 || list[0].Name != "local-cluster" || list[1].Name != "site-1" {
		t.Fatalf("list = %+v", list)
	}
	if c := list[1]; !c.AIGridEnabled || !c.Provisioned || c.Location != "brussels" || c.Site != "brussels-dc1" || c.Region != "europe-west" {
		t.Fatalf("site-1 = %+v", c)
	}
	if c := list[0]; c.AIGridEnabled || c.OpenShiftVersion != "4.22.15" {
		t.Fatalf("local-cluster = %+v", c)
	}
	if got := fake.Metadata.Get("authorization"); len(got) != 1 || got[0] != "Bearer sha256~token" {
		t.Fatalf("token not forwarded: %v", fake.Metadata)
	}
	if got := fake.Metadata.Get("x-forwarded-user"); len(got) != 1 || got[0] != "alice" {
		t.Fatalf("user not forwarded: %v", fake.Metadata)
	}

	var one GridCluster
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/clusters/site-1")), &one)
	if one.Name != "site-1" {
		t.Fatalf("get = %+v", one)
	}
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters/missing")); rec.Code != http.StatusNotFound {
		t.Fatalf("missing cluster status = %d", rec.Code)
	}
}

func TestTenantsFromBackend(t *testing.T) {
	fake := &backendtest.Fake{Tenants: []*aigridv1.Tenant{
		{Id: "2", Name: "tenant-b", Domains: []string{"b.example.com"}},
		{Id: "1", Name: "tenant-a"},
	}}
	var out []Tenant
	rec := serve(newTestApp(t, testConfig(t), fake), asUser(http.MethodGet, "/api/v1/tenants"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &out)
	if len(out) != 2 || out[0].Name != "tenant-a" || out[0].Domains == nil || out[1].Domains[0] != "b.example.com" {
		t.Fatalf("tenants = %+v", out)
	}
}

func TestBackendErrorsMapToHTTP(t *testing.T) {
	cases := []struct {
		code codes.Code
		want int
	}{
		{codes.PermissionDenied, http.StatusForbidden},
		{codes.Unauthenticated, http.StatusUnauthorized},
		{codes.NotFound, http.StatusNotFound},
		{codes.Unimplemented, http.StatusNotImplemented},
		{codes.Unavailable, http.StatusServiceUnavailable},
		{codes.Internal, http.StatusBadGateway},
	}
	for _, tc := range cases {
		fake := &backendtest.Fake{Err: backendtest.Status(tc.code, "backend said no")}
		rec := serve(newTestApp(t, testConfig(t), fake), asUser(http.MethodGet, "/api/v1/tenants"))
		if rec.Code != tc.want {
			t.Errorf("%s -> %d, want %d (%s)", tc.code, rec.Code, tc.want, rec.Body.String())
		}
	}
	// Client-caused failures keep the backend's message.
	fake := &backendtest.Fake{Err: backendtest.Status(codes.PermissionDenied, "alice may not list tenants")}
	body := decodeError(t, serve(newTestApp(t, testConfig(t), fake), asUser(http.MethodGet, "/api/v1/tenants")))
	if body.Error.Message != "alice may not list tenants" {
		t.Fatalf("message = %q", body.Error.Message)
	}
}

func TestPanicBecomes500(t *testing.T) {
	app := newTestApp(t, testConfig(t), nil)
	h := app.recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		err  error
		want int
	}{
		{Errorf(http.StatusTeapot, "x"), http.StatusTeapot},
		{context.DeadlineExceeded, http.StatusGatewayTimeout},
		{backendtest.Status(codes.InvalidArgument, "x"), http.StatusUnprocessableEntity},
		{backendtest.Status(codes.AlreadyExists, "x"), http.StatusConflict},
		{backendtest.Status(codes.FailedPrecondition, "x"), http.StatusPreconditionFailed},
		{backendtest.Status(codes.ResourceExhausted, "x"), http.StatusTooManyRequests},
		{backendtest.Status(codes.DeadlineExceeded, "x"), http.StatusGatewayTimeout},
		{errors.New("plain"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		if got, _ := classify(tc.err); got != tc.want {
			t.Errorf("classify(%v) = %d, want %d", tc.err, got, tc.want)
		}
	}
}

func TestSPAHandler(t *testing.T) {
	dir := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>index</html>"), 0o644))
	must(os.MkdirAll(filepath.Join(dir, "assets"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "assets", "app-0123abcdef.js"), []byte("js"), 0o644))

	cfg := testConfig(t)
	cfg.StaticAssetsDir = dir
	h := newTestApp(t, cfg, nil).Handler()

	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		return rec
	}
	if rec := get("/"); rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
		t.Fatalf("/ -> %d %q", rec.Code, rec.Body.String())
	}
	if rec := get("/clusters/local-cluster"); rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
		t.Fatalf("client route -> %d %q", rec.Code, rec.Body.String())
	}
	if rec := get("/assets/app-0123abcdef.js"); rec.Code != 200 || rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("hashed asset -> %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := get("/assets/missing.js"); rec.Code != 404 {
		t.Fatalf("missing asset -> %d", rec.Code)
	}
	raw := httptest.NewRequest(http.MethodGet, "/", nil)
	raw.URL.Path = "/../../etc/passwd"
	rec := httptest.NewRecorder()
	newSPAHandler(dir).ServeHTTP(rec, raw)
	if rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
		t.Fatalf("traversal should be cleaned to a client route, got %d %q", rec.Code, rec.Body.String())
	}
}

func richCluster() *aigridv1.ManagedCluster {
	ltt := timestamppb.New(time.Date(2026, 10, 1, 9, 0, 8, 0, time.UTC))
	return &aigridv1.ManagedCluster{
		Name: "site-paris-1", HubAcceptsClient: true, ResourceVersion: "41",
		Labels: map[string]string{
			LabelEnabled: "true", LabelProvisioned: "true", LabelLocation: "paris", LabelSite: "paris-dc1", LabelRegion: "europe-west",
			LabelOpenShiftVersion: "4.22.15", LabelAddonPrefix + "work-manager": "available", LabelAddonPrefix + "cluster-proxy": "unreachable",
		},
		Annotations: map[string]string{AnnotationSiteName: "Paris DC1", AnnotationLatitude: "48.8566", AnnotationLongitude: "2.3522"},
		Status: &aigridv1.ManagedClusterStatus{
			State: aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE, StateMessage: "Managed cluster is available",
			KubernetesVersion: "v1.35.6",
			Capacity:          map[string]string{"cpu": "192", CapacityGPU: "16"},
			ClusterClaims: []*aigridv1.ClusterClaim{
				{Name: ClaimConsoleURL, Value: "https://console-openshift-console.apps.site-paris-1.example.com"},
				{Name: ClaimPlatform, Value: "BareMetal"}, {Name: ClaimProduct, Value: "OpenShift"},
			},
			Conditions: []*aigridv1.Condition{
				{Type: "ManagedClusterConditionAvailable", Status: aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: proto.String("ManagedClusterAvailable"), Message: proto.String("Managed cluster is available"), LastTransitionTime: ltt},
				{Type: "ManagedClusterConditionClockSynced", Status: aigridv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED, LastTransitionTime: ltt},
			},
		},
	}
}

func TestGridClusterCarriesTheDerivedFields(t *testing.T) {
	fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{richCluster()}}
	app := newTestApp(t, testConfig(t), fake)

	var c GridCluster
	rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters/site-paris-1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &c)
	if c.Status != StatusReady || c.StatusMessage != "Managed cluster is available" {
		t.Errorf("status = %q %q", c.Status, c.StatusMessage)
	}
	if c.ConsoleURL != "https://console-openshift-console.apps.site-paris-1.example.com" || c.Platform != "BareMetal" || c.Product != "OpenShift" || c.KubernetesVersion != "v1.35.6" {
		t.Errorf("claims = %+v", c)
	}
	if c.GPUCapacity != 16 {
		t.Errorf("gpuCapacity = %d", c.GPUCapacity)
	}
	if c.SiteName != "Paris DC1" || c.Latitude == nil || *c.Latitude != 48.8566 || c.Longitude == nil || *c.Longitude != 2.3522 {
		t.Errorf("site = %q %v %v", c.SiteName, c.Latitude, c.Longitude)
	}
	if len(c.Addons) != 2 || c.Addons["work-manager"] != "available" || c.Addons["cluster-proxy"] != "unreachable" {
		t.Errorf("addons = %v", c.Addons)
	}
	byType := map[string]ClusterCondition{}
	for _, cond := range c.Conditions {
		byType[cond.Type] = cond
	}
	avail, clock := byType["ManagedClusterConditionAvailable"], byType["ManagedClusterConditionClockSynced"]
	if len(c.Conditions) != 2 || avail.Status != "True" || avail.Reason != "ManagedClusterAvailable" || avail.LastTransitionTime == nil || avail.LastTransitionTime.IsZero() || clock.Status != "Unknown" {
		t.Errorf("conditions = %+v", c.Conditions)
	}
	if c.ResourceVersion != "41" {
		t.Errorf("resourceVersion = %q", c.ResourceVersion)
	}
	// Raw JSON: the state names are the ACM console's and absent coordinates are omitted.
	rec = serve(app, asUser(http.MethodGet, "/api/v1/clusters"))
	if !strings.Contains(rec.Body.String(), `"status":"ready"`) || !strings.Contains(rec.Body.String(), `"gpuCapacity":16`) {
		t.Errorf("body = %s", rec.Body.String())
	}
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters/missing")); rec.Code != http.StatusNotFound || decodeError(t, rec).Error.Message != "object with identifier 'missing' not found" {
		t.Fatalf("missing cluster = %d %s", rec.Code, rec.Body.String())
	}
}

// TestConditionWithoutTransitionTimeIsOmitted: an unset proto timestamp is
// the Unix epoch through AsTime; the JSON must not present 1970 as observed.
func TestConditionWithoutTransitionTimeIsOmitted(t *testing.T) {
	mc := richCluster()
	mc.Status.Conditions = append(mc.Status.Conditions, &aigridv1.Condition{Type: "Deleting", Status: aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: proto.String("ResourceRemaining")})
	app := newTestApp(t, testConfig(t), &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{mc}})
	for _, path := range []string{"/api/v1/clusters", "/api/v1/clusters/site-paris-1"} {
		rec := serve(app, asUser(http.MethodGet, path))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d %s", path, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "1970-01-01") {
			t.Errorf("%s: an absent transition time is rendered as the epoch: %s", path, rec.Body.String())
		}
	}
	var raw struct {
		Data struct {
			Conditions []map[string]json.RawMessage `json:"conditions"`
		} `json:"data"`
	}
	rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters/site-paris-1"))
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if n := len(raw.Data.Conditions); n != 3 {
		t.Fatalf("conditions = %d", n)
	}
	if _, has := raw.Data.Conditions[0]["lastTransitionTime"]; !has {
		t.Error("a recorded transition time must be present")
	}
	if ts, has := raw.Data.Conditions[2]["lastTransitionTime"]; has {
		t.Errorf("an unset transition time must be omitted, got %s", ts)
	}
}

// TestCoordinatesMustBeFinite: ParseFloat accepts NaN and Inf, which JSON
// cannot encode; one such annotation must not break the list or the detail.
func TestCoordinatesMustBeFinite(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want *float64
	}{
		{"NaN", nil}, {"nan", nil}, {"Inf", nil}, {"+Inf", nil}, {"-Infinity", nil}, {"1e400", nil}, {"91", nil}, {"", nil}, {"x", nil},
		{" 48.8566 ", ptr(48.8566)}, {"-90", ptr(-90)},
	} {
		got := parseCoordinate(tc.in, 90)
		switch {
		case got == nil && tc.want == nil:
		case got == nil || tc.want == nil || *got != *tc.want:
			t.Errorf("parseCoordinate(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
	bad := richCluster()
	bad.Name = "site-bad-1"
	bad.Annotations = map[string]string{AnnotationLatitude: "NaN", AnnotationLongitude: "+Inf"}
	app := newTestApp(t, testConfig(t), &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{richCluster(), bad}})

	var list []GridCluster
	rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters"))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &list)
	if len(list) != 2 || list[0].Latitude != nil || list[0].Longitude != nil || list[1].Latitude == nil {
		t.Errorf("list = %+v", list)
	}
	var one GridCluster
	rec = serve(app, asUser(http.MethodGet, "/api/v1/clusters/site-bad-1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("detail status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &one)
	if one.Latitude != nil || one.Longitude != nil || one.Annotations[AnnotationLatitude] != "NaN" {
		t.Errorf("detail = %+v", one)
	}
}

func ptr(f float64) *float64 { return &f }

// TestWriteJSONFailureIs500: encoding happens before the status is committed,
// so a value JSON cannot carry is an error response, not a 200 with no body.
func TestWriteJSONFailureIs500(t *testing.T) {
	rec := httptest.NewRecorder()
	writeData(rec, http.StatusOK, math.NaN())
	if rec.Code != http.StatusInternalServerError || decodeError(t, rec).Error.Code != "500" {
		t.Errorf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	writeData(rec, http.StatusOK, []int{1})
	if rec.Code != http.StatusOK || rec.Body.String() != "{\"data\":[1]}\n" {
		t.Errorf("status = %d body = %q", rec.Code, rec.Body.String())
	}
}

// TestGetClusterFallsBackToListOnTheShippedBackend: today's backend has only
// ListManagedClusters, so GetManagedCluster answers Unimplemented and the
// detail endpoint must still work by filtering the list.
func TestGetClusterFallsBackToListOnTheShippedBackend(t *testing.T) {
	fake := &backendtest.Fake{
		Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", HubAcceptsClient: true, Labels: map[string]string{LabelEnabled: "true"}}},
		Errs:     map[string]error{"GetManagedCluster": backendtest.Status(codes.Unimplemented, "method GetManagedCluster not implemented")},
	}
	app := newTestApp(t, testConfig(t), fake)
	var one GridCluster
	rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters/site-1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &one)
	if one.Name != "site-1" || !one.AIGridEnabled {
		t.Errorf("cluster = %+v", one)
	}
	if !fake.Reached("ListManagedClusters") {
		t.Errorf("the list was not used as the fallback: %v", fake.Calls)
	}
	rec = serve(app, asUser(http.MethodGet, "/api/v1/clusters/missing"))
	if rec.Code != http.StatusNotFound || decodeError(t, rec).Error.Message != "object with identifier 'missing' not found" {
		t.Errorf("missing = %d %s", rec.Code, rec.Body.String())
	}
	// Any other Get failure is reported as is, without a second call.
	fake.Errs["GetManagedCluster"] = backendtest.Status(codes.Unavailable, "hub down")
	fake.Calls = nil
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters/site-1")); rec.Code != http.StatusServiceUnavailable || fake.Reached("ListManagedClusters") {
		t.Errorf("Unavailable = %d, calls %v", rec.Code, fake.Calls)
	}
	// A PATCH against the shipped backend is 501: it has no UpdateManagedCluster either.
	fake.Errs = map[string]error{
		"GetManagedCluster":    backendtest.Status(codes.Unimplemented, "method GetManagedCluster not implemented"),
		"UpdateManagedCluster": backendtest.Status(codes.Unimplemented, "method UpdateManagedCluster not implemented"),
	}
	if rec := serve(app, patchRequest("site-1", `{"aiGridEnabled": false}`)); rec.Code != http.StatusNotImplemented {
		t.Errorf("PATCH on the shipped backend = %d %s", rec.Code, rec.Body.String())
	}
}

func TestStateStrings(t *testing.T) {
	cases := map[aigridv1.ManagedClusterState]string{
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNSPECIFIED:    "",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE:      "ready",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE:    "offline",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN:        "unknown",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT: "pendingimport",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING:      "importing",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORT_FAILED:  "importfailed",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING:      "detaching",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED:   "notaccepted",
	}
	for state, want := range cases {
		mc := &aigridv1.ManagedCluster{Name: "x", Status: &aigridv1.ManagedClusterStatus{State: state}}
		if got := toGridCluster(mc).Status; got != want {
			t.Errorf("%s -> %q, want %q", state, got, want)
		}
	}
	// A cluster from today's backend (fields 1-3 only) has no status and no annotations but valid JSON maps.
	c := toGridCluster(&aigridv1.ManagedCluster{Name: "bare"})
	if c.Status != "" || c.Addons == nil || c.Conditions == nil || c.Labels == nil || c.Annotations == nil || c.Latitude != nil {
		t.Errorf("bare = %+v", c)
	}
	if lat := toGridCluster(&aigridv1.ManagedCluster{Annotations: map[string]string{AnnotationLatitude: "north"}}).Latitude; lat != nil {
		t.Errorf("invalid latitude must be omitted, got %v", *lat)
	}
}

func patchRequest(name, body string) *http.Request {
	req := asUser(http.MethodPatch, "/api/v1/clusters/"+name)
	req.Body = io.NopCloser(strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestPatchCluster(t *testing.T) {
	t.Run("enrol and locate", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7", Labels: map[string]string{"name": "site-1", LabelEnabled: "false"}, Annotations: map[string]string{"open-cluster-management/created-via": "other"}}}}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, patchRequest("site-1", `{"aiGridEnabled": true, "location": "paris", "siteName": "Paris DC1", "latitude": 48.8566, "longitude": 2.3522}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		var c GridCluster
		decodeData(t, rec, &c)
		if !c.AIGridEnabled || c.Location != "paris" || c.SiteName != "Paris DC1" || c.Latitude == nil || *c.Latitude != 48.8566 || c.ResourceVersion != "8" {
			t.Errorf("patched = %+v", c)
		}
		up := fake.LastUpdate
		if up == nil || !up.GetLock() || up.GetObject().GetResourceVersion() != "7" {
			t.Fatalf("update must lock on the fetched resource version, got %v", up)
		}
		if paths := up.GetUpdateMask().GetPaths(); len(paths) != 2 || paths[0] != "labels" || paths[1] != "annotations" {
			t.Errorf("mask = %v", paths)
		}
		if l := up.GetObject().GetLabels(); l["name"] != "site-1" || l[LabelEnabled] != "true" || l[LabelLocation] != "paris" {
			t.Errorf("labels sent as a whole map with the change applied, got %v", l)
		}
		if an := up.GetObject().GetAnnotations(); an["open-cluster-management/created-via"] != "other" || an[AnnotationLatitude] != "48.8566" || an[AnnotationLongitude] != "2.3522" || an[AnnotationSiteName] != "Paris DC1" {
			t.Errorf("annotations = %v", an)
		}
		if got := fake.Metadata.Get("authorization"); len(got) != 1 || got[0] != "Bearer sha256~token" {
			t.Errorf("token not forwarded: %v", fake.Metadata)
		}
	})

	t.Run("empty string removes, null removes a coordinate, only touched maps are in the mask", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7", Labels: map[string]string{LabelEnabled: "true", LabelLocation: "paris"}, Annotations: map[string]string{AnnotationLatitude: "1", AnnotationSiteName: "x"}}}}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, patchRequest("site-1", `{"location": ""}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		if l := fake.LastUpdate.GetObject().GetLabels(); len(l) != 1 || l[LabelEnabled] != "true" {
			t.Errorf("labels = %v", l)
		}
		if paths := fake.LastUpdate.GetUpdateMask().GetPaths(); len(paths) != 1 || paths[0] != "labels" {
			t.Errorf("mask = %v", paths)
		}
		rec = serve(app, patchRequest("site-1", `{"latitude": null}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		if an := fake.LastUpdate.GetObject().GetAnnotations(); len(an) != 1 || an[AnnotationSiteName] != "x" {
			t.Errorf("annotations = %v", an)
		}
		if paths := fake.LastUpdate.GetUpdateMask().GetPaths(); len(paths) != 1 || paths[0] != "annotations" {
			t.Errorf("mask = %v", paths)
		}
		fake.LastUpdate = nil
		if rec = serve(app, patchRequest("site-1", `{}`)); rec.Code != http.StatusOK || fake.LastUpdate != nil {
			t.Errorf("an empty patch answers 200 without a write: %d %v", rec.Code, fake.LastUpdate)
		}
	})

	t.Run("validation", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7"}}}
		app := newTestApp(t, testConfig(t), fake)
		for body, want := range map[string]string{
			`{"latitude": 91}`:         "latitude must be between -90 and 90",
			`{"longitude": -180.5}`:    "longitude must be between -180 and 180",
			`{"aiGridEnabled": "yes"}`: `invalid request body: field "aiGridEnabled" must be a bool`,
			`{"colour": "red"}`:        `invalid request body: json: unknown field "colour"`,
			`{`:                        "invalid request body: malformed JSON",
			// One JSON object and nothing else: a second value or stray bytes are refused.
			`{"aiGridEnabled": true} garbage`: "invalid request body: unexpected content after the JSON object",
			`{"aiGridEnabled": true}{}`:       "invalid request body: unexpected content after the JSON object",
			`{"aiGridEnabled": true} 1`:       "invalid request body: unexpected content after the JSON object",
		} {
			rec := serve(app, patchRequest("site-1", body))
			if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != want {
				t.Errorf("%s -> %d %s, want 422 %q", body, rec.Code, rec.Body.String(), want)
			}
		}
		// Trailing whitespace is fine.
		if rec := serve(app, patchRequest("site-1", "{\"aiGridEnabled\": true}\n  \n")); rec.Code != http.StatusOK {
			t.Errorf("trailing whitespace -> %d %s", rec.Code, rec.Body.String())
		}
		fake.Calls = nil
		huge := `{"location": "` + strings.Repeat("x", maxBodyBytes) + `"}`
		if rec := serve(app, patchRequest("site-1", huge)); rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("oversized body -> %d %s", rec.Code, rec.Body.String())
		}
		if rec := serve(app, patchRequest("site-1", `{"aiGridEnabled": true}`+strings.Repeat(" ", maxBodyBytes))); rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("oversized trailing content -> %d %s", rec.Code, rec.Body.String())
		}
		if len(fake.Calls) != 0 {
			t.Errorf("invalid patches must not reach the backend at all, got %v", fake.Calls)
		}
		if rec := serve(app, patchRequest("missing", `{"aiGridEnabled": true}`)); rec.Code != http.StatusNotFound {
			t.Errorf("unknown cluster = %d", rec.Code)
		}
	})

	// updateFails makes the read succeed and only UpdateManagedCluster fail,
	// and asserts the handler got as far as that write.
	updateFails := func(t *testing.T, fake *backendtest.Fake, err error, body string) *httptest.ResponseRecorder {
		t.Helper()
		fake.Errs = map[string]error{"UpdateManagedCluster": err}
		fake.Calls, fake.LastUpdate = nil, nil
		rec := serve(newTestApp(t, testConfig(t), fake), patchRequest("site-1", body))
		if !fake.Reached("GetManagedCluster") || !fake.Reached("UpdateManagedCluster") || fake.LastUpdate == nil {
			t.Fatalf("the read must succeed and the update be reached, calls = %v", fake.Calls)
		}
		return rec
	}

	t.Run("backend conflict and invalid argument", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7"}}}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, patchRequest("site-1", `{"aiGridEnabled": true}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("a consistent read-then-write succeeds: %d %s", rec.Code, rec.Body.String())
		}
		// The backend answers Aborted when something else wrote between the Get and the Update.
		rec = updateFails(t, fake, backendtest.Status(codes.Aborted, "object with identifier 'site-1' has resource version 9, the request carries \"8\""), `{"aiGridEnabled": true}`)
		if rec.Code != http.StatusConflict || !strings.Contains(decodeError(t, rec).Error.Message, "resource version 9") {
			t.Errorf("Aborted -> %d %s, want 409 with the backend's message", rec.Code, rec.Body.String())
		}
		rec = updateFails(t, fake, backendtest.Status(codes.InvalidArgument, "update_mask path \"labels\" is not supported"), `{"aiGridEnabled": true}`)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("InvalidArgument -> %d, want 422", rec.Code)
		}
	})

	t.Run("optimistic lock: the hub object changes between the read and the write", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7", Labels: map[string]string{LabelLocation: "paris"}}}}
		// Another writer lands after the BFF's Get and before its Update.
		fake.AfterGet = func(stored *aigridv1.ManagedCluster) {
			stored.ResourceVersion = "8"
			stored.Labels[LabelLocation] = "lyon"
		}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, patchRequest("site-1", `{"aiGridEnabled": true}`))
		if rec.Code != http.StatusConflict {
			t.Fatalf("status = %d %s, want 409", rec.Code, rec.Body.String())
		}
		if msg := decodeError(t, rec).Error.Message; !strings.Contains(msg, "resource version 8") || !strings.Contains(msg, `carries "7"`) {
			t.Errorf("message = %q", msg)
		}
		if up := fake.LastUpdate; up == nil || !up.GetLock() || up.GetObject().GetResourceVersion() != "7" {
			t.Errorf("the update must lock on the version it read, got %v", up)
		}
		if got := fake.Clusters[0].GetLabels(); got[LabelLocation] != "lyon" || got[LabelEnabled] != "" {
			t.Errorf("the other writer's change must survive, the lost update must not land: %v", got)
		}
	})

	t.Run("hub RBAC denies the caller", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7"}}}
		forbidden := `managedclusters.cluster.open-cluster-management.io "site-1" is forbidden: User "alice" cannot patch resource "managedclusters" in API group "cluster.open-cluster-management.io" at the cluster scope`
		rec := updateFails(t, fake, backendtest.Status(codes.PermissionDenied, forbidden), `{"aiGridEnabled": true}`)
		if rec.Code != http.StatusForbidden || decodeError(t, rec).Error.Message != forbidden {
			t.Errorf("PermissionDenied -> %d %s, want 403 with the hub's message", rec.Code, rec.Body.String())
		}
	})

	t.Run("detaching cluster still accepts a label patch", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7", DeletionTimestamp: timestamppb.Now(),
			Status: &aigridv1.ManagedClusterStatus{State: aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING}}}}
		app := newTestApp(t, testConfig(t), fake)
		var c GridCluster
		rec := serve(app, patchRequest("site-1", `{"aiGridEnabled": true}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		decodeData(t, rec, &c)
		if !c.AIGridEnabled || c.Status != StatusDetaching {
			t.Errorf("patched = %+v", c)
		}
	})

	t.Run("requires identity", func(t *testing.T) {
		app := newTestApp(t, testConfig(t), &backendtest.Fake{})
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/clusters/site-1", strings.NewReader(`{}`))
		if rec := serve(app, req); rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d", rec.Code)
		}
	})
}
