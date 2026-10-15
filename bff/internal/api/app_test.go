package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube/kubetest"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	cfg, err := config.Parse(nil, func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func newTestApp(t *testing.T, cfg config.Config) *App {
	t.Helper()
	factory := kubetest.NewFactory(runtime.NewScheme(), map[schema.GroupVersionResource]string{})
	return NewApp(cfg, slog.New(slog.DiscardHandler), factory)
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return body
}

func TestHealthcheckNeedsNoToken(t *testing.T) {
	app := newTestApp(t, testConfig(t))
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthcheck", nil))
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

func TestAPIRequiresToken(t *testing.T) {
	app := newTestApp(t, testConfig(t))
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/anything", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if body := decodeError(t, rec); body.Error.Code != "401" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	app := newTestApp(t, testConfig(t))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil)
	req.Header.Set(config.DefaultAuthTokenHeader, "sha256~token")
	app.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type = %q", ct)
	}
}

func TestPanicBecomes500(t *testing.T) {
	app := newTestApp(t, testConfig(t))
	h := app.recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestClassify(t *testing.T) {
	gr := schema.GroupResource{Group: "cluster.open-cluster-management.io", Resource: "managedclusters"}
	cases := []struct {
		err  error
		want int
	}{
		{Errorf(http.StatusTeapot, "x"), http.StatusTeapot},
		{apierrors.NewUnauthorized("no"), http.StatusUnauthorized},
		{apierrors.NewForbidden(gr, "a", errors.New("denied")), http.StatusForbidden},
		{apierrors.NewNotFound(gr, "a"), http.StatusNotFound},
		{apierrors.NewConflict(gr, "a", errors.New("c")), http.StatusConflict},
		{apierrors.NewBadRequest("bad"), http.StatusUnprocessableEntity},
		{apierrors.NewInternalError(errors.New("x")), http.StatusServiceUnavailable},
		{apierrors.NewServiceUnavailable("x"), http.StatusServiceUnavailable},
		{apierrors.NewTooManyRequests("x", 1), http.StatusTooManyRequests},
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
	h := newTestApp(t, cfg).Handler()

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
	// Bypass the mux (which redirects unclean paths) to check the handler itself.
	raw := httptest.NewRequest(http.MethodGet, "/", nil)
	raw.URL.Path = "/../../etc/passwd"
	rec := httptest.NewRecorder()
	newSPAHandler(dir).ServeHTTP(rec, raw)
	if rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
		t.Fatalf("traversal should be cleaned to a client route, got %d %q", rec.Code, rec.Body.String())
	}
}
