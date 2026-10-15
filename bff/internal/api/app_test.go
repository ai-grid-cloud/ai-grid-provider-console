package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"google.golang.org/grpc/codes"

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
