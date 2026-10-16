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
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
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
	if rec := get("/subscriptions/view/engineering"); rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
		t.Fatalf("deep client route -> %d %q", rec.Code, rec.Body.String())
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
	mc.Status.Conditions = append(mc.Status.Conditions, &aigridv1.Condition{Type: "Deleting", Status: aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, Reason: proto.String("ResourceRemaining")})
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
	// A PATCH against the shipped backend is 501: it has no UpdateManagedCluster
	// either (and the BFF does not read first).
	fake.Calls = nil
	fake.Errs = map[string]error{
		"GetManagedCluster":    backendtest.Status(codes.Unimplemented, "method GetManagedCluster not implemented"),
		"UpdateManagedCluster": backendtest.Status(codes.Unimplemented, "method UpdateManagedCluster not implemented"),
	}
	if rec := serve(app, withIfMatch(patchRequest("site-1", `{"labels": {}}`), `"1"`)); rec.Code != http.StatusNotImplemented || fake.Reached("GetManagedCluster") {
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

// withIfMatch sets the If-Match header every PATCH and DELETE must carry.
func withIfMatch(req *http.Request, v string) *http.Request {
	req.Header.Set("If-Match", v)
	return req
}

func patchRequest(name, body string) *http.Request {
	req := asUser(http.MethodPatch, "/api/v1/clusters/"+name)
	req.Body = io.NopCloser(strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestPatchCluster(t *testing.T) {
	site := func() *backendtest.Fake {
		return &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7",
			Labels:      map[string]string{"name": "site-1", LabelEnabled: "false"},
			Annotations: map[string]string{"open-cluster-management/created-via": "other"}}}}
	}

	t.Run("one update with whole maps, no read", func(t *testing.T) {
		fake := site()
		app := newTestApp(t, testConfig(t), fake)
		body := `{"labels": {"name": "site-1", "ai-grid/enabled": "true", "location": "paris"}, "annotations": {"ai-grid/site-name": "Paris DC1", "ai-grid/latitude": "48.8566"}}`
		rec := serve(app, withIfMatch(patchRequest("site-1", body), `"7"`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		var c GridCluster
		decodeData(t, rec, &c)
		if !c.AIGridEnabled || c.Location != "paris" || c.SiteName != "Paris DC1" || c.Latitude == nil || *c.Latitude != 48.8566 || c.ResourceVersion != "8" || rec.Header().Get("ETag") != `"8"` {
			t.Errorf("patched = %+v", c)
		}
		if strings.Join(fake.Calls, ",") != "UpdateManagedCluster" {
			t.Errorf("the BFF must not read the cluster first: calls %v", fake.Calls)
		}
		up := fake.LastUpdate
		if !up.GetLock() || up.GetObject().GetResourceVersion() != "7" || up.GetObject().GetName() != "site-1" || strings.Join(up.GetUpdateMask().GetPaths(), ",") != "labels,annotations" {
			t.Fatalf("update = %v", up)
		}
		// Sent as the client wrote them: nothing merged in from the stored maps.
		if l := up.GetObject().GetLabels(); len(l) != 3 || l[LabelEnabled] != "true" {
			t.Errorf("labels = %v", l)
		}
		if an := up.GetObject().GetAnnotations(); len(an) != 2 || an["open-cluster-management/created-via"] != "" {
			t.Errorf("annotations = %v", an)
		}
		if got := fake.Metadata.Get("authorization"); len(got) != 1 || got[0] != "Bearer sha256~token" {
			t.Errorf("token not forwarded: %v", fake.Metadata)
		}
	})

	t.Run("an empty map clears, null is absent", func(t *testing.T) {
		fake := site()
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, withIfMatch(patchRequest("site-1", `{"labels": {}, "annotations": null}`), `"7"`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		up := fake.LastUpdate
		if strings.Join(up.GetUpdateMask().GetPaths(), ",") != "labels" || len(up.GetObject().GetLabels()) != 0 {
			t.Errorf("update = %v", up)
		}
	})

	t.Run("an empty body is 422 and calls nothing, even with a stale If-Match", func(t *testing.T) {
		for _, body := range []string{`{}`, `{"labels": null, "annotations": null}`} {
			fake := site()
			rec := serve(newTestApp(t, testConfig(t), fake), withIfMatch(patchRequest("site-1", body), `"3"`))
			if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != "the request body names no field to change" || len(fake.Calls) != 0 {
				t.Errorf("%s = %d %s, calls %v", body, rec.Code, rec.Body.String(), fake.Calls)
			}
		}
	})

	t.Run("the BFF does not compare: the stored maps go to the backend, which keeps the version", func(t *testing.T) {
		fake := site()
		rec := serve(newTestApp(t, testConfig(t), fake), withIfMatch(patchRequest("site-1", `{"labels": {"name": "site-1", "ai-grid/enabled": "false"}}`), `"7"`))
		if rec.Code != http.StatusOK || !fake.Reached("UpdateManagedCluster") || rec.Header().Get("ETag") != `"7"` {
			t.Errorf("repeat = %d, calls %v, ETag %q", rec.Code, fake.Calls, rec.Header().Get("ETag"))
		}
	})

	t.Run("validation is the body's shape only", func(t *testing.T) {
		fake := site()
		app := newTestApp(t, testConfig(t), fake)
		for body, want := range map[string]string{
			// The typed fields are gone; a client sends the maps.
			`{"aiGridEnabled": true}`:     `invalid request body: json: unknown field "aiGridEnabled"`,
			`{"latitude": 91}`:            `invalid request body: json: unknown field "latitude"`,
			`{"labels": "x"}`:             `invalid request body: field "labels" must be an object`,
			`{"hubAcceptsClient": false}`: `invalid request body: json: unknown field "hubAcceptsClient"`,
			`{`:                           "invalid request body: malformed JSON",
			// The body is an object: null would otherwise read as an empty patch.
			`null`:    "invalid request body: must be a JSON object",
			` null `:  "invalid request body: must be a JSON object",
			`[]`:      "invalid request body: must be a JSON object",
			`"enrol"`: "invalid request body: must be a JSON object",
			`true`:    "invalid request body: must be a JSON object",
			// One JSON object and nothing else: a second value or stray bytes are refused.
			`{"labels": {}} garbage`: "invalid request body: unexpected content after the JSON object",
			`{"labels": {}}{}`:       "invalid request body: unexpected content after the JSON object",
			`{"labels": {}} 1`:       "invalid request body: unexpected content after the JSON object",
		} {
			rec := serve(app, withIfMatch(patchRequest("site-1", body), `"7"`))
			if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != want {
				t.Errorf("%s -> %d %s, want 422 %q", body, rec.Code, rec.Body.String(), want)
			}
		}
		huge := `{"labels": {"x": "` + strings.Repeat("x", maxBodyBytes) + `"}}`
		if rec := serve(app, withIfMatch(patchRequest("site-1", huge), `"7"`)); rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("oversized body -> %d %s", rec.Code, rec.Body.String())
		}
		if rec := serve(app, withIfMatch(patchRequest("site-1", `{"labels": {}}`+strings.Repeat(" ", maxBodyBytes)), `"7"`)); rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("oversized trailing content -> %d %s", rec.Code, rec.Body.String())
		}
		if len(fake.Calls) != 0 {
			t.Errorf("invalid patches must not reach the backend at all, got %v", fake.Calls)
		}
		// Trailing whitespace is fine; an out-of-range coordinate is the
		// backend's to refuse, so the BFF forwards it.
		if rec := serve(app, withIfMatch(patchRequest("site-1", "{\"annotations\": {\"ai-grid/latitude\": \"91\"}}\n  \n"), `"7"`)); rec.Code != http.StatusOK || fake.LastUpdate.GetObject().GetAnnotations()[AnnotationLatitude] != "91" {
			t.Errorf("coordinate forwarded -> %d %s", rec.Code, rec.Body.String())
		}
	})

	// updateFails makes UpdateManagedCluster fail and asserts the handler
	// reached it, and nothing else.
	updateFails := func(t *testing.T, err error) *httptest.ResponseRecorder {
		t.Helper()
		fake := site()
		fake.Errs = map[string]error{"UpdateManagedCluster": err}
		rec := serve(newTestApp(t, testConfig(t), fake), withIfMatch(patchRequest("site-1", `{"labels": {"ai-grid/enabled": "true"}}`), `"7"`))
		if strings.Join(fake.Calls, ",") != "UpdateManagedCluster" || fake.LastUpdate == nil {
			t.Fatalf("the update must be the only call, calls = %v", fake.Calls)
		}
		return rec
	}

	t.Run("backend answers keep their message", func(t *testing.T) {
		for _, tc := range []struct {
			err    error
			status int
		}{
			{backendtest.Status(codes.Aborted, `object with identifier 'site-1' has resource version 9, the request carries "7"`), http.StatusConflict},
			{backendtest.Status(codes.InvalidArgument, `annotation "ai-grid/latitude" must be a number between -90 and 90, got "91"`), http.StatusUnprocessableEntity},
			{backendtest.Status(codes.PermissionDenied, `managedclusters.cluster.open-cluster-management.io "site-1" is forbidden: User "alice" cannot patch resource "managedclusters" in API group "cluster.open-cluster-management.io" at the cluster scope`), http.StatusForbidden},
			{backendtest.Status(codes.NotFound, "object with identifier 'site-1' not found"), http.StatusNotFound},
		} {
			rec := updateFails(t, tc.err)
			if rec.Code != tc.status || decodeError(t, rec).Error.Message != status.Convert(tc.err).Message() {
				t.Errorf("%v -> %d %s, want %d with the backend's message", tc.err, rec.Code, rec.Body.String(), tc.status)
			}
		}
	})

	t.Run("detaching cluster still accepts a label patch", func(t *testing.T) {
		fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7", DeletionTimestamp: timestamppb.Now(),
			Status: &aigridv1.ManagedClusterStatus{State: aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING}}}}
		app := newTestApp(t, testConfig(t), fake)
		var c GridCluster
		rec := serve(app, withIfMatch(patchRequest("site-1", `{"labels": {"ai-grid/enabled": "true"}}`), `"7"`))
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

// Every write is refused with 415 unless its body is declared JSON, before
// anything reaches the backend: a cross-site form or a text/plain fetch,
// which a browser sends without a CORS preflight, cannot create or change
// anything.
func TestWritesRequireJSONContentType(t *testing.T) {
	writes := []struct{ method, path, body string }{
		{http.MethodPost, "/api/v1/tenants", `{"name": "evil"}`},
		{http.MethodPatch, "/api/v1/tenants/t-1", `{"enabled": false}`},
		{http.MethodPost, "/api/v1/models", `{"name": "m", "namespace": "ns", "modelUri": "hf://x/y"}`},
		{http.MethodPatch, "/api/v1/models/ai-grid-models/tiny-llm", `{"replicas": 2}`},
		{http.MethodPatch, "/api/v1/clusters/site-1", `{"labels": {"ai-grid/enabled": "true"}}`},
	}
	for _, ct := range []string{"", "text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "application/merge-patch+json", "json", "application/json;;"} {
		for _, wr := range writes {
			fake := &backendtest.Fake{Tenants: seedTenants(), Models: seedModels(), Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7"}}}
			app := newTestApp(t, testConfig(t), fake)
			req := jsonRequest(wr.method, wr.path, wr.body)
			if ct == "" {
				req.Header.Del("Content-Type")
			} else {
				req.Header.Set("Content-Type", ct)
			}
			rec := serve(app, req)
			if rec.Code != http.StatusUnsupportedMediaType {
				t.Errorf("%s %s with Content-Type %q -> %d %s, want 415", wr.method, wr.path, ct, rec.Code, rec.Body.String())
				continue
			}
			if e := decodeError(t, rec); e.Error.Code != "415" || e.Error.Message != "request body must be JSON: send Content-Type: application/json" {
				t.Errorf("415 body = %+v", e)
			}
			if len(fake.Calls) != 0 {
				t.Errorf("%s %s with %q reached the backend: %v", wr.method, wr.path, ct, fake.Calls)
			}
		}
	}
	// application/json in any case, with parameters, is accepted.
	for _, ct := range []string{"application/json", "application/json; charset=utf-8", "Application/JSON"} {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		req := jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "ok"}`)
		req.Header.Set("Content-Type", ct)
		if rec := serve(app, req); rec.Code != http.StatusCreated {
			t.Errorf("Content-Type %q -> %d %s, want 201", ct, rec.Code, rec.Body.String())
		}
	}
	// A DELETE has no body to check.
	fake := &backendtest.Fake{Tenants: seedTenants()}
	if rec := serve(newTestApp(t, testConfig(t), fake), withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-1"), `"1"`)); rec.Code != http.StatusNoContent {
		t.Errorf("DELETE without a Content-Type -> %d", rec.Code)
	}
}

// Every PATCH and DELETE needs If-Match: without it the answer is 428 before
// the body is read and before any backend call. The 415 content-type check
// comes first (TestWritesRequireJSONContentType sends no If-Match and gets
// 415), the 428 next, the body decoding last.
func TestWritesRequireIfMatch(t *testing.T) {
	const want = `this write needs an If-Match header: send the ETag that GET answered (the object's resourceVersion), for example If-Match: "42"`
	writes := []struct{ method, path, body string }{
		{http.MethodPatch, "/api/v1/clusters/site-1", `{"labels": {"ai-grid/enabled": "true"}}`},
		{http.MethodPatch, "/api/v1/tenants/t-1", `{"enabled": false}`},
		{http.MethodDelete, "/api/v1/tenants/t-1", ""},
		{http.MethodPatch, "/api/v1/models/ai-grid-models/tiny-llm", `{"replicas": 2}`},
		{http.MethodDelete, "/api/v1/models/ai-grid-models/tiny-llm", ""},
		// A body that would be 422 is 428 first, an unknown object too.
		{http.MethodPatch, "/api/v1/clusters/site-1", `{"colour": "red"}`},
		{http.MethodPatch, "/api/v1/tenants/missing", `null`},
		{http.MethodDelete, "/api/v1/models/ai-grid-models/missing", ""},
	}
	for _, wr := range writes {
		fake := &backendtest.Fake{Tenants: seedTenants(), Models: seedModels(), Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7"}}}
		req := asUser(wr.method, wr.path)
		if wr.body != "" {
			req = jsonRequest(wr.method, wr.path, wr.body)
		}
		rec := serve(newTestApp(t, testConfig(t), fake), req)
		if e := decodeError(t, rec); rec.Code != http.StatusPreconditionRequired || e.Error.Code != "428" || e.Error.Message != want || len(fake.Calls) != 0 {
			t.Errorf("%s %s %s without If-Match = %d %+v, calls %v; want 428 and no call", wr.method, wr.path, wr.body, rec.Code, e, fake.Calls)
		}
	}
}

func TestClusterETagAndIfMatch(t *testing.T) {
	fresh := func() *backendtest.Fake {
		return &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "9", Labels: map[string]string{LabelLocation: "paris"}}}}
	}

	fake := fresh()
	app := newTestApp(t, testConfig(t), fake)
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/clusters/site-1")); rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"9"` {
		t.Fatalf("GET = %d, ETag %q, want \"9\"", rec.Code, rec.Header().Get("ETag"))
	}

	// The tab loaded version 3; the hub has 9: the lock is on 3 and the write is refused.
	rec := serve(app, withIfMatch(patchRequest("site-1", `{"labels": {"location": "rome"}}`), `"3"`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale If-Match = %d %s, want 409", rec.Code, rec.Body.String())
	}
	if up := fake.LastUpdate; !up.GetLock() || up.GetObject().GetResourceVersion() != "3" {
		t.Errorf("the lock must carry the If-Match version, got %v", up)
	}
	if fake.Clusters[0].GetLabels()[LabelLocation] != "paris" || fake.Clusters[0].GetResourceVersion() != "9" {
		t.Errorf("a stale write must not land: %v", fake.Clusters[0])
	}

	// The current version writes and answers the new ETag.
	rec = serve(app, withIfMatch(patchRequest("site-1", `{"labels": {"location": "rome"}}`), `"9"`))
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"10"` || fake.LastUpdate.GetObject().GetResourceVersion() != "9" {
		t.Fatalf("matching If-Match = %d, ETag %q, update %v", rec.Code, rec.Header().Get("ETag"), fake.LastUpdate)
	}

	// No If-Match, and `*`, which names no version, are 428 before any call:
	// every write carries the version the client read.
	for h, want := range map[string]string{
		"":  `this write needs an If-Match header: send the ETag that GET answered (the object's resourceVersion), for example If-Match: "42"`,
		"*": `If-Match: * names no version: send the ETag that GET answered (the object's resourceVersion), for example If-Match: "42"`,
	} {
		fake := fresh()
		req := patchRequest("site-1", `{"labels": {"location": "rome"}}`)
		if h != "" {
			req.Header.Set("If-Match", h)
		}
		rec := serve(newTestApp(t, testConfig(t), fake), req)
		if e := decodeError(t, rec); rec.Code != http.StatusPreconditionRequired || e.Error.Code != "428" || e.Error.Message != want || len(fake.Calls) != 0 {
			t.Errorf("If-Match %q = %d %+v, calls %v; want 428 %q", h, rec.Code, e, fake.Calls, want)
		}
	}

	// A header the backend cannot compare is 422 before any call.
	for _, h := range []string{`9`, `W/"9"`, `"9", "10"`, `""`, `"a b"`} {
		fake := fresh()
		rec := serve(newTestApp(t, testConfig(t), fake), withIfMatch(patchRequest("site-1", `{"labels": {"location": "rome"}}`), h))
		if rec.Code != http.StatusUnprocessableEntity || len(fake.Calls) != 0 {
			t.Errorf("If-Match %s = %d %s, calls %v; want 422 and no call", h, rec.Code, rec.Body.String(), fake.Calls)
		}
	}
}

func TestListMeta(t *testing.T) {
	n := func(v int) *int { return &v }
	for _, tc := range []struct {
		name          string
		offset, limit *int
		size          int
		total         *int32
		want          string
	}{
		{"backend count wins", n(10), n(10), 10, proto.Int32(25), `{"size":10,"total":25,"offset":10,"limit":10}`},
		{"zero is a count", nil, n(0), 0, proto.Int32(0), `{"size":0,"total":0,"offset":0,"limit":0}`},
		{"no count, everything", nil, nil, 8, nil, `{"size":8,"total":8,"offset":0}`},
		{"no count, a short page ends the list", n(10), n(10), 5, nil, `{"size":5,"total":15,"offset":10,"limit":10}`},
		{"no count, a full page leaves the total unknown", n(10), n(10), 10, nil, `{"size":10,"offset":10,"limit":10}`},
	} {
		b, err := json.Marshal(listMeta(tc.offset, tc.limit, tc.size, tc.total))
		if err != nil || string(b) != tc.want {
			t.Errorf("%s: %s, want %s (%v)", tc.name, b, tc.want, err)
		}
	}
}

func TestFieldErrorsReachTheBody(t *testing.T) {
	st := status.New(codes.InvalidArgument, "The organization is invalid.")
	st, _ = st.WithDetails(&errdetails.BadRequest{FieldViolations: []*errdetails.BadRequest_FieldViolation{
		{Field: "identityProvider.config.issuer", Description: "Enter a valid HTTP or HTTPS URL."},
	}})
	fake := &backendtest.Fake{Err: st.Err()}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d", rec.Code)
	}
	body := decodeError(t, rec)
	if body.Error.FieldErrors["identityProvider.config.issuer"] != "Enter a valid HTTP or HTTPS URL." {
		t.Fatalf("fieldErrors %+v", body.Error.FieldErrors)
	}
}

// Field violations on any status other than InvalidArgument stay in the log;
// the browser gets the mapped message only.
func TestFieldErrorsOnlyForInvalidArgument(t *testing.T) {
	for _, tc := range []struct {
		code codes.Code
		want int
	}{
		{codes.Internal, http.StatusBadGateway},
		{codes.FailedPrecondition, http.StatusPreconditionFailed},
		{codes.NotFound, http.StatusNotFound},
	} {
		t.Run(tc.code.String(), func(t *testing.T) {
			st, err := status.New(tc.code, "backend detail").WithDetails(&errdetails.BadRequest{FieldViolations: []*errdetails.BadRequest_FieldViolation{
				{Field: "internal.secret", Description: "must not leak"},
			}})
			if err != nil {
				t.Fatal(err)
			}
			app := newTestApp(t, testConfig(t), &backendtest.Fake{Err: st.Err()})
			rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants"))
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
			if got := decodeError(t, rec).Error.FieldErrors; got != nil {
				t.Fatalf("fieldErrors %+v, want none", got)
			}
			if strings.Contains(rec.Body.String(), "fieldErrors") || strings.Contains(rec.Body.String(), "must not leak") {
				t.Fatalf("body leaks field violations: %s", rec.Body)
			}
		})
	}
}

func TestConfigReportsFakeBackend(t *testing.T) {
	cfg := testConfig(t)
	cfg.FakeBackend = true
	app := newTestApp(t, cfg, &backendtest.Fake{})
	var got ConsoleConfig
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/config")), &got)
	if !got.FakeBackend {
		t.Fatal("fakeBackend not reported")
	}
}

// TestConfigReportsModelsNamespace: /config names the namespace the console
// creates models in, MODELS_NAMESPACE.
func TestConfigReportsModelsNamespace(t *testing.T) {
	cfg := testConfig(t)
	cfg.ModelsNamespace = "team-models"
	var got ConsoleConfig
	decodeData(t, serve(newTestApp(t, cfg, &backendtest.Fake{}), asUser(http.MethodGet, "/api/v1/config")), &got)
	if got.ModelsNamespace != "team-models" {
		t.Fatalf("modelsNamespace = %q", got.ModelsNamespace)
	}
}

const validSubscription = `{"name":"team-a","displayName":" Team A ","description":"Models for team A.","priority":5,
"owner":{"groups":[{"name":" team-a "}]},
"modelRefs":[{"name":"granite-3-8b","tokenRateLimits":[{"limit":1000,"window":"1h"}],"billingRate":{"perToken":"0.000002"},
"guardrails":[{"ref":{"name":"safety"},"checks":["pii"]}]}],
"tokenMetadata":{"organizationId":"id-acme","costCenter":"cc","labels":{"env":"prod"}},"inferencePriority":-5,
"createAuthPolicy":true}`

// TestSubscriptionWritesRequireJSONContentType: the subscription writes get
// PR 12's 415 for a body that isn't declared JSON (what a cross-site form or
// a text/plain fetch sends without a CORS preflight), before any backend
// call and before the If-Match check, so the PUT here sends none. PR 12's
// TestWritesRequireJSONContentType covers its own routes.
func TestSubscriptionWritesRequireJSONContentType(t *testing.T) {
	for _, r := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/subscriptions"},
		{http.MethodPut, "/api/v1/subscriptions/engineering"},
	} {
		for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"} {
			fake := &backendtest.Fake{}
			req := jsonRequest(r.method, r.path, validSubscription)
			if ct == "" {
				req.Header.Del("Content-Type")
			} else {
				req.Header.Set("Content-Type", ct)
			}
			rec := serve(newTestApp(t, testConfig(t), fake), req)
			if rec.Code != http.StatusUnsupportedMediaType || decodeError(t, rec).Error.Message != "request body must be JSON: send Content-Type: application/json" {
				t.Errorf("%s %s with Content-Type %q: %d %s", r.method, r.path, ct, rec.Code, rec.Body)
			}
			if len(fake.Calls) != 0 {
				t.Errorf("%s %s with %q reached the backend: %v", r.method, r.path, ct, fake.Calls)
			}
		}
	}
}

// TestSubscriptionUpdateRefusesCreateFields: PUT's body has no `name` or
// `createAuthPolicy`, so strict decoding refuses them instead of ignoring
// them.
func TestSubscriptionUpdateRefusesCreateFields(t *testing.T) {
	fake := &backendtest.Fake{Subscriptions: []*aigridv1.Subscription{{Name: "team-a", ResourceVersion: "1"}}}
	app := newTestApp(t, testConfig(t), fake)
	for _, field := range []string{`"name":"team-a"`, `"createAuthPolicy":true`} {
		rec := serve(app, withIfMatch(jsonRequest(http.MethodPut, "/api/v1/subscriptions/team-a", `{`+field+`,"priority":1,"owner":{"groups":[]},"modelRefs":[]}`), `"1"`))
		if rec.Code != http.StatusUnprocessableEntity || fake.LastSubscriptionUpdate != nil {
			t.Errorf("PUT with %s = %d %s", field, rec.Code, rec.Body.String())
		}
	}
}

func TestSubscriptionRoutes(t *testing.T) {
	ts := timestamppb.New(time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC))
	rate := "0.000002"
	granite := &aigridv1.Model{Name: "granite-3-8b", Metadata: &aigridv1.ObjectMeta{Namespace: "ai-grid-models", ResourceVersion: "1"}, Spec: &aigridv1.ModelSpec{}}
	eng := &aigridv1.Subscription{
		Name: "engineering", DisplayName: "Engineering", Priority: 100,
		Owner: &aigridv1.Owner{Users: []string{"alice"}, Groups: []string{"engineering"}},
		ModelRefs: []*aigridv1.ModelSubscriptionRef{{Name: "granite-3-8b", TokenRateLimits: []*aigridv1.TokenRateLimit{{Limit: 100000, Window: "1h"}},
			BillingRatePerToken: &rate, Guardrails: []*aigridv1.GuardrailAttachment{{RefName: "safety"}}}},
		TokenMetadata: &aigridv1.TokenMetadata{OrganizationId: "id-acme"},
		Phase:         "Active", ResourceVersion: "3", CreateTime: ts,
	}
	fake := &backendtest.Fake{
		Subscriptions: []*aigridv1.Subscription{eng, {Name: "data-science", ResourceVersion: "1"}},
		Models:        []*aigridv1.Model{granite},
		AuthPolicies: []*aigridv1.AuthPolicy{{Name: "engineering-policy", Phase: "Active",
			ModelRefs: []*aigridv1.AuthPolicyModelRef{{Name: "granite-3-8b"}}, SubjectGroups: []string{"engineering"}}},
	}
	app := newTestApp(t, testConfig(t), fake)
	send := func(method, path, body, ifMatch string) *httptest.ResponseRecorder {
		req := asUser(method, path)
		if body != "" {
			req.Body = io.NopCloser(strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
		}
		if ifMatch != "" {
			req.Header.Set("If-Match", ifMatch)
		}
		return serve(app, req)
	}

	// The list keeps the backend's order, in the PoC's MaaSSubscription shape with resourceVersion.
	var list []map[string]any
	decodeData(t, send(http.MethodGet, "/api/v1/subscriptions", "", ""), &list)
	wantEng := map[string]any{
		"name": "engineering", "displayName": "Engineering", "priority": float64(100),
		"owner": map[string]any{"users": []any{"alice"}, "groups": []any{map[string]any{"name": "engineering"}}},
		"modelRefs": []any{map[string]any{"name": "granite-3-8b", "tokenRateLimits": []any{map[string]any{"limit": float64(100000), "window": "1h"}},
			"billingRate": map[string]any{"perToken": "0.000002"}, "guardrails": []any{map[string]any{"ref": map[string]any{"name": "safety"}}}}},
		"tokenMetadata": map[string]any{"organizationId": "id-acme"},
		"phase":         "Active", "resourceVersion": "3", "creationTimestamp": "2026-09-01T09:00:00Z",
		"conditions": []any{}, "modelRefStatuses": []any{}, "tokenRateLimitStatuses": []any{},
	}
	want := []map[string]any{
		wantEng,
		{"name": "data-science", "priority": float64(0), "owner": map[string]any{"groups": []any{}}, "modelRefs": []any{}, "resourceVersion": "1",
			"conditions": []any{}, "modelRefStatuses": []any{}, "tokenRateLimitStatuses": []any{}},
	}
	if !reflect.DeepEqual(list, want) {
		t.Fatalf("subscriptions\n got %v\nwant %v", list, want)
	}

	// The info shape: the subscription, its models and the policies that cover them.
	var info map[string]any
	decodeData(t, send(http.MethodGet, "/api/v1/subscriptions/engineering", "", ""), &info)
	wantInfo := map[string]any{
		"subscription": wantEng,
		"modelRefs":    []any{jsonValue(t, toModel(granite))},
		"authPolicies": []any{map[string]any{"name": "engineering-policy", "phase": "Active", "modelRefs": []any{map[string]any{"name": "granite-3-8b"}},
			"subjects": map[string]any{"groups": []any{map[string]any{"name": "engineering"}}}, "conditions": []any{}}},
		"meteringMetadata":   map[string]any{"organizationId": "id-acme"},
		"modelRegistrations": []any{},
	}
	if !reflect.DeepEqual(info, wantInfo) {
		t.Fatalf("info\n got %v\nwant %v", info, wantInfo)
	}
	if rec := send(http.MethodGet, "/api/v1/subscriptions/nope", "", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown: %d %s", rec.Code, rec.Body)
	}

	// Create: 201 with the subscription, its policy, and a Location; the body
	// is forwarded as decoded (the backend validates and normalizes it).
	rec := send(http.MethodPost, "/api/v1/subscriptions", validSubscription, "")
	if rec.Code != http.StatusCreated || rec.Header().Get("Location") != "/api/v1/subscriptions/team-a" {
		t.Fatalf("create: %d %q %s", rec.Code, rec.Header().Get("Location"), rec.Body)
	}
	var created struct {
		Subscription map[string]any
		AuthPolicy   map[string]any
	}
	decodeData(t, rec, &created)
	if created.Subscription["name"] != "team-a" || created.AuthPolicy["name"] != "team-a-policy" {
		t.Fatalf("created %v", created)
	}
	c := fake.LastSubscriptionCreate
	o := c.GetObject()
	if !c.GetCreateAuthPolicy() || o.GetName() != "team-a" || o.GetDisplayName() != " Team A " || o.GetPriority() != 5 ||
		!reflect.DeepEqual(o.GetOwner().GetGroups(), []string{" team-a "}) || o.GetModelRefs()[0].GetBillingRatePerToken() != "0.000002" ||
		o.GetModelRefs()[0].GetTokenRateLimits()[0].GetLimit() != 1000 || o.GetModelRefs()[0].GetGuardrails()[0].GetRefName() != "safety" ||
		o.GetTokenMetadata().GetOrganizationId() != "id-acme" || o.GetTokenMetadata().GetLabels()["env"] != "prod" || o.GetInferencePriority() != -5 {
		t.Fatalf("create request %v", c)
	}

	// Update forwards the If-Match version with lock and keeps the path's name;
	// without If-Match it is 428 before any call, as on every write.
	update := `{"description":"New","priority":7,"owner":{"users":["alice"],"groups":[{"name":"engineering"}]},
"modelRefs":[{"name":"granite-3-8b","namespace":"team-b","tokenRateLimits":[{"limit":5,"window":"1m"}]}],"tokenMetadata":{"organizationId":"id-acme"}}`
	rec = send(http.MethodPut, "/api/v1/subscriptions/engineering", update, "")
	if u := fake.LastSubscriptionUpdate; rec.Code != http.StatusPreconditionRequired || u != nil {
		t.Fatalf("update without If-Match: %d %s, request %v", rec.Code, rec.Body, u)
	}
	// A header the backend cannot compare is 422 before any call.
	fake.LastSubscriptionUpdate = nil
	for _, h := range []string{`3`, `W/"3"`, `""`, `"3", "4"`} {
		if rec := send(http.MethodPut, "/api/v1/subscriptions/engineering", update, h); rec.Code != http.StatusUnprocessableEntity || fake.LastSubscriptionUpdate != nil {
			t.Fatalf("update with If-Match %s: %d %s", h, rec.Code, rec.Body)
		}
	}
	rec = send(http.MethodPut, "/api/v1/subscriptions/engineering", update, `"3"`)
	if rec.Code != http.StatusOK {
		t.Fatalf("update: %d %s", rec.Code, rec.Body)
	}
	var updated map[string]any
	decodeData(t, rec, &updated)
	if _, ok := updated["subscription"]; !ok {
		t.Fatalf("update answer %v", updated)
	}
	u := fake.LastSubscriptionUpdate
	if !u.GetLock() || u.GetObject().GetName() != "engineering" || u.GetObject().GetResourceVersion() != "3" || u.GetObject().GetPriority() != 7 ||
		u.GetObject().GetModelRefs()[0].GetNamespace() != "team-b" ||
		!reflect.DeepEqual(u.GetObject().GetOwner().GetUsers(), []string{"alice"}) {
		t.Fatalf("update request %v", u)
	}
	// A stale version is the backend's Aborted: 409 with its message.
	fake.Err = status.Error(codes.Aborted, "This subscription changed. Reload it before saving or deleting.")
	rec = send(http.MethodPut, "/api/v1/subscriptions/engineering", update, `"2"`)
	if rec.Code != http.StatusConflict || decodeError(t, rec).Error.Message != "This subscription changed. Reload it before saving or deleting." {
		t.Fatalf("stale: %d %s", rec.Code, rec.Body)
	}
	fake.Err = nil

	// Delete forwards an If-Match version as its precondition and answers 204;
	// a malformed one is 422 before any call.
	if rec := send(http.MethodDelete, "/api/v1/subscriptions/engineering", "", `W/"3"`); rec.Code != http.StatusUnprocessableEntity || fake.LastSubscriptionDelete != nil {
		t.Fatalf("delete with a weak If-Match: %d %s", rec.Code, rec.Body)
	}
	if rec := send(http.MethodDelete, "/api/v1/subscriptions/engineering", "", `"3"`); rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if d := fake.LastSubscriptionDelete; d.GetName() != "engineering" || d.GetResourceVersion() != "3" {
		t.Fatalf("delete request %v", d)
	}
	// Without If-Match the delete is 428 before any call.
	fake.LastSubscriptionDelete = nil
	if rec := send(http.MethodDelete, "/api/v1/subscriptions/engineering", "", ""); rec.Code != http.StatusPreconditionRequired || fake.LastSubscriptionDelete != nil {
		t.Fatalf("delete without If-Match: %d %s, request %v", rec.Code, rec.Body, fake.LastSubscriptionDelete)
	}

	// The real backend has no Subscriptions service yet: 501 everywhere.
	fake.Err = status.Error(codes.Unimplemented, "")
	for _, r := range []struct{ method, path, body, ifMatch string }{
		{http.MethodGet, "/api/v1/subscriptions", "", ""},
		{http.MethodGet, "/api/v1/subscriptions/engineering", "", ""},
		{http.MethodPost, "/api/v1/subscriptions", validSubscription, ""},
		{http.MethodPut, "/api/v1/subscriptions/engineering", update, `"1"`},
		{http.MethodDelete, "/api/v1/subscriptions/engineering", "", `"1"`},
	} {
		if rec := send(r.method, r.path, r.body, r.ifMatch); rec.Code != http.StatusNotImplemented {
			t.Fatalf("%s %s on the real backend: %d %s", r.method, r.path, rec.Code, rec.Body)
		}
	}
}

// TestBFFForwardsWhatItDecodes: the BFF validates nothing. A subscription
// with a blank display name reaches the backend unchanged, and the backend's
// InvalidArgument with a BadRequest comes back as 422 with its fieldErrors.
func TestBFFForwardsWhatItDecodes(t *testing.T) {
	st, err := status.New(codes.InvalidArgument, "String must contain at least 1 character(s)").WithDetails(&errdetails.BadRequest{
		FieldViolations: []*errdetails.BadRequest_FieldViolation{{Field: "displayName", Description: "String must contain at least 1 character(s)"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	fake := &backendtest.Fake{Errs: map[string]error{"CreateSubscription": st.Err()}}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/subscriptions", strings.Replace(validSubscription, `" Team A "`, `"   "`, 1)))
	if got := fake.LastSubscriptionCreate.GetObject().GetDisplayName(); got != "   " {
		t.Fatalf("forwarded displayName %q", got)
	}
	if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.FieldErrors["displayName"] != "String must contain at least 1 character(s)" {
		t.Fatalf("backend's field errors: %d %s", rec.Code, rec.Body)
	}
}

// jsonValue is v as encoding/json decodes it into an any.
func jsonValue(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// member is an AI Grid member cluster at site, Available, with the state the
// backend derives from that.
// TestSubscriptionStatusMapsOneToOne: the MaaS status (P12) comes back as the
// backend reports it, under the CRD's names, with no derived reason or
// status message.
func TestSubscriptionStatusMapsOneToOne(t *testing.T) {
	at := timestamppb.New(time.Date(2026, 10, 16, 9, 0, 1, 0, time.UTC))
	sub := &aigridv1.Subscription{
		Name: "team-a", Phase: "Degraded", ResourceVersion: "1",
		Conditions: []*aigridv1.Condition{
			{Type: "Ready", Status: aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, Reason: proto.String("PartialFailure"),
				Message: proto.String("1 of 2 model references are invalid or unavailable"), LastTransitionTime: at},
			{Type: "SpecPriorityDuplicate", Status: aigridv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED},
		},
		ModelRefStatuses: []*aigridv1.ResourceRefStatus{
			{Name: "granite-8b-instruct", Namespace: "ai-grid-models", Ready: true, Reason: "Valid"},
			{Name: "retired-llm", Namespace: "ai-grid-models", Reason: "NotFound", Message: `maasmodelrefs.maas.opendatahub.io "retired-llm" not found`},
		},
		TokenRateLimitStatuses: []*aigridv1.TokenRateLimitStatus{{Model: "granite-8b-instruct", Ref: &aigridv1.ResourceRefStatus{
			Name: "maas-trlp-granite-8b-instruct", Namespace: "ai-grid-models", Reason: "NotAccepted"}}},
	}
	fake := &backendtest.Fake{
		Subscriptions: []*aigridv1.Subscription{sub},
		AuthPolicies: []*aigridv1.AuthPolicy{{Name: "team-a-policy", Phase: "Active", ModelRefs: []*aigridv1.AuthPolicyModelRef{
			{Name: "granite-8b-instruct"}, {Name: "mistral-7b-instruct", Namespace: "team-b"}}, Conditions: []*aigridv1.Condition{
			{Type: "ConflictingAuthPolicy", Status: aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, Reason: proto.String("NoConflict")}}}},
		ModelRegistrations: []*aigridv1.ModelRegistration{{Name: "granite-8b-instruct", Namespace: "ai-grid-models", Phase: "Ready", Endpoint: "https://maas.example.com",
			Conditions: []*aigridv1.Condition{{Type: "GovernanceAttached", Status: aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: proto.String("GovernancePaired")}}}},
	}
	app := newTestApp(t, testConfig(t), fake)
	wantSub := map[string]any{
		"name": "team-a", "priority": float64(0), "owner": map[string]any{"groups": []any{}}, "modelRefs": []any{}, "resourceVersion": "1", "phase": "Degraded",
		"conditions": []any{
			map[string]any{"type": "Ready", "status": "False", "reason": "PartialFailure", "message": "1 of 2 model references are invalid or unavailable",
				"lastTransitionTime": "2026-10-16T09:00:01Z"},
			map[string]any{"type": "SpecPriorityDuplicate", "status": "Unknown"},
		},
		"modelRefStatuses": []any{
			map[string]any{"name": "granite-8b-instruct", "namespace": "ai-grid-models", "ready": true, "reason": "Valid"},
			map[string]any{"name": "retired-llm", "namespace": "ai-grid-models", "ready": false, "reason": "NotFound",
				"message": `maasmodelrefs.maas.opendatahub.io "retired-llm" not found`},
		},
		"tokenRateLimitStatuses": []any{map[string]any{"model": "granite-8b-instruct", "name": "maas-trlp-granite-8b-instruct", "namespace": "ai-grid-models",
			"ready": false, "reason": "NotAccepted"}},
	}
	var list []map[string]any
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/subscriptions")), &list)
	if len(list) != 1 || !reflect.DeepEqual(list[0], wantSub) {
		t.Fatalf("list\n got %v\nwant %v", list, wantSub)
	}
	var info map[string]any
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/subscriptions/team-a")), &info)
	if !reflect.DeepEqual(info["subscription"], wantSub) {
		t.Fatalf("info subscription\n got %v\nwant %v", info["subscription"], wantSub)
	}
	wantRegs := []any{map[string]any{"name": "granite-8b-instruct", "namespace": "ai-grid-models", "phase": "Ready", "endpoint": "https://maas.example.com",
		"conditions": []any{map[string]any{"type": "GovernanceAttached", "status": "True", "reason": "GovernancePaired"}}}}
	if !reflect.DeepEqual(info["modelRegistrations"], wantRegs) {
		t.Fatalf("registrations\n got %v\nwant %v", info["modelRegistrations"], wantRegs)
	}
	policy := info["authPolicies"].([]any)[0].(map[string]any)
	if want := []any{map[string]any{"type": "ConflictingAuthPolicy", "status": "False", "reason": "NoConflict"}}; !reflect.DeepEqual(policy["conditions"], want) {
		t.Fatalf("policy conditions %v", policy["conditions"])
	}
	if want := []any{map[string]any{"name": "granite-8b-instruct"}, map[string]any{"name": "mistral-7b-instruct", "namespace": "team-b"}}; !reflect.DeepEqual(policy["modelRefs"], want) {
		t.Fatalf("policy model refs %v", policy["modelRefs"])
	}
}
