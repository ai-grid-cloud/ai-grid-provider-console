package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/codes"

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
// SelfSubjectAccessReview with allowed, or fails with status when set, and
// keeps the Authorization of the last review (lastAuth).
type fakeHub struct {
	allowed bool
	status  int

	mu   sync.Mutex
	auth string
}

func (f *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.auth = r.Header.Get("Authorization")
	f.mu.Unlock()
	if f.status != 0 {
		http.Error(w, http.StatusText(f.status), f.status)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte(`{"status":{"allowed":` + strconv.FormatBool(f.allowed) + `}}`))
}

// lastAuth is the Authorization header of the last access review.
func (f *fakeHub) lastAuth() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.auth
}

// recorder keeps strings a test server records, safe for its handlers to add
// to while the test reads.
type recorder struct {
	mu  sync.Mutex
	got []string
}

func (r *recorder) add(v string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, v)
}

func (r *recorder) values() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.got)
}

// startHub serves h as the hub API server and returns a client for it.
func startHub(t *testing.T, h http.Handler) *hub.Client {
	t.Helper()
	srv := httptest.NewServer(h)
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
	t.Parallel()
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
	t.Parallel()
	fake := &backendtest.Fake{}
	app := newTestApp(t, testConfig(t), fake)
	if rec := serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("ready status = %d %s", rec.Code, rec.Body.String())
	}
	fake.Err = backendtest.Status(codes.Unavailable, "down")
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("not-ready status = %d", rec.Code)
	}
}

func TestAPIRequiresToken(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/api/v1/user", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if body := decodeError(t, rec); body.Error.Code != "401" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	t.Parallel()
	rec := serve(newTestApp(t, testConfig(t), nil), asUser(http.MethodGet, "/api/v1/nope"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type = %q", ct)
	}
}

// A known path asked with a method it has no route for is 405 with Allow and
// the JSON error shape, not the unknown-path 404.
func TestWrongMethodIsJSON405(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	cases := map[string]string{
		"POST /api/v1/config": "GET, HEAD",
		"PUT /api/v1/user":    "GET, HEAD",
	}
	for req, allow := range cases {
		t.Run(req, func(t *testing.T) {
			method, path, _ := strings.Cut(req, " ")
			rec := serve(app, asUser(method, path))
			if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != allow {
				t.Fatalf("%d Allow=%q, want 405 Allow=%q", rec.Code, rec.Header().Get("Allow"), allow)
			}
			if body := decodeError(t, rec); body.Error.Code != "405" || !strings.Contains(body.Error.Message, allow) {
				t.Errorf("body %+v, want code 405 and a message naming %q", body, allow)
			}
		})
	}
	if rec := serve(app, asUser(http.MethodPost, "/api/v1/nope")); rec.Code != http.StatusNotFound || rec.Header().Get("Allow") != "" {
		t.Errorf("unknown path: %d %v", rec.Code, rec.Header())
	}
}

// HEAD is GET without the body: open on /user and /config like GET, so the
// provider-admin check doesn't refuse a viewer's HEAD that its GET passes.
func TestHeadUserAndConfigAreOpenLikeGet(t *testing.T) {
	t.Parallel()
	denied := newTestAppWithHub(t, testConfig(t), nil, &fakeHub{allowed: false})
	if rec := serve(denied, asUser(http.MethodHead, "/api/v1/config")); rec.Code != http.StatusOK {
		t.Errorf("HEAD /config by a non-admin: %d", rec.Code)
	}
	if rec := serve(denied, asUser(http.MethodHead, "/api/v1/user")); rec.Code != http.StatusOK {
		t.Errorf("HEAD /user by a non-admin: %d", rec.Code)
	}
	if rec := serve(denied, asUser(http.MethodHead, "/api/v1/nope")); rec.Code != http.StatusForbidden {
		t.Errorf("HEAD /nope by a non-admin: %d, want 403", rec.Code)
	}
}

func TestUserFromProxyHeaders(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	h := &fakeHub{allowed: true}
	var u User
	rec := serve(newTestAppWithHub(t, cfg, nil, h), asUser(http.MethodGet, "/api/v1/user"))
	decodeData(t, rec, &u)
	if u.Username != "alice" || u.Email != "alice@example.com" || len(u.Groups) != 2 || !u.IsProviderAdmin {
		t.Fatalf("user = %+v", u)
	}
	if h.lastAuth() != "Bearer sha256~token" {
		t.Fatalf("the access review must carry the caller's own token, got %q", h.lastAuth())
	}

	rec = serve(newTestAppWithHub(t, cfg, nil, &fakeHub{allowed: false}), asUser(http.MethodGet, "/api/v1/user"))
	decodeData(t, rec, &u)
	if u.IsProviderAdmin {
		t.Fatal("the hub denied the provider-admin check; alice is not a provider admin")
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

func TestOnlyProviderAdminsReachTheAPI(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	// Every /api/v1 path but GET and HEAD /user and /config, a path no route takes too; the
	// Connect relay gets the same check (relay_test.go).
	other := func() *http.Request { return asUser(http.MethodGet, "/api/v1/nope") }
	fake := &backendtest.Fake{}
	denied := newTestAppWithHub(t, cfg, fake, &fakeHub{allowed: false})
	for _, req := range []*http.Request{other(), asUser(http.MethodHead, "/api/v1/nope")} {
		rec := serve(denied, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s by a non-admin: got %d %s, want 403", req.Method, req.URL.Path, rec.Code, rec.Body.String())
		}
		// Who the console is for, not the one verb the check asks about.
		if rec.Body.Len() == 0 {
			continue // HEAD: no body
		}
		if got := decodeError(t, rec).Error.Message; got != "this console is only for provider admins, users the hub's ai-grid-provider-admin role allows, and the hub says you are not one" {
			t.Fatalf("%s %s by a non-admin: message %q", req.Method, req.URL.Path, got)
		}
	}
	if calls := fake.Calls(); len(calls) != 0 {
		t.Fatalf("a refused call must not reach the backend: %v", calls)
	}
	// Who the caller is stays answerable, so the UI can say why.
	for _, path := range []string{"/api/v1/user", "/api/v1/config"} {
		if rec := serve(denied, asUser(http.MethodGet, path)); rec.Code != http.StatusOK {
			t.Fatalf("GET %s by a non-admin: got %d %s", path, rec.Code, rec.Body.String())
		}
	}
	// A provider admin passes the check, to the API's own 404.
	if rec := serve(newTestApp(t, cfg, fake), other()); rec.Code != http.StatusNotFound {
		t.Fatalf("GET by a provider admin: got %d %s", rec.Code, rec.Body.String())
	}
	if rec := serve(newTestAppWithHub(t, cfg, fake, &fakeHub{status: http.StatusUnauthorized}), other()); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired token: got %d, want 401", rec.Code)
	}
}

func TestConfigEndpoint(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	cfg.GridEndpoint = "https://grid.example.com"
	var out ConsoleConfig
	decodeData(t, serve(newTestApp(t, cfg, nil), asUser(http.MethodGet, "/api/v1/config")), &out)
	if out.GridEndpoint != cfg.GridEndpoint || out.Version != Version {
		t.Fatalf("config = %+v", out)
	}
	// Without MODEL_HARDWARE, the wizard gets the built-in hardware list.
	if !reflect.DeepEqual(out.Models.Hardware, config.DefaultModelHardware()) {
		t.Fatalf("models.hardware = %+v, want the built-in list", out.Models.Hardware)
	}
}

// The wizard's hardware comes from MODEL_HARDWARE as configured, with the fields a list leaves
// out left out of the JSON too.
func TestConfigServesModelHardware(t *testing.T) {
	t.Parallel()
	cfg, err := config.Parse([]string{"--hub-api-url=https://hub.invalid"}, func(key string) (string, bool) {
		if key == "MODEL_HARDWARE" {
			return `[{"id":"amd-gpu","label":"AMD GPU","accelerator":"amd.com/gpu","image":"quay.io/example/vllm-rocm:1","defaults":{"accelerators":1}},{"id":"cpu","label":"CPU only"}]`, true
		}
		return "", false
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := serve(newTestApp(t, cfg, nil), asUser(http.MethodGet, "/api/v1/config"))
	var body struct {
		Data struct {
			Models json.RawMessage `json:"models"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := `{"hardware":[{"id":"amd-gpu","label":"AMD GPU","accelerator":"amd.com/gpu","image":"quay.io/example/vllm-rocm:1","defaults":{"accelerators":1}},{"id":"cpu","label":"CPU only"}]}`
	if string(body.Data.Models) != want {
		t.Fatalf("models = %s, want %s", body.Data.Models, want)
	}
}

// A hub slower than the access review's timeout is the hub's failure: 502
// with the hub message.
func TestSlowHubIs502(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	defer close(release) // before Close, which waits for the handler
	hubClient, err := hub.New(hub.Config{URL: slow.URL, Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), backendtest.Start(t, &backendtest.Fake{}), hubClient)
	for _, path := range []string{"/api/v1/user", "/api/v1/nope"} {
		rec := serve(app, asUser(http.MethodGet, path))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("GET %s with a slow hub: %d %s, want 502", path, rec.Code, rec.Body.String())
		}
		if got := decodeError(t, rec).Error.Message; got != "the hub could not confirm the caller's permissions; try again" {
			t.Fatalf("GET %s with a slow hub: message %q", path, got)
		}
	}
}

// The request line and a failure's own line ("request failed") say which
// request and which admin, so an audit can tell who asked what; the token
// never reaches the log.
func TestLogsNameTheRequestAndTheUser(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	app := NewApp(testConfig(t), slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo})), backendtest.Start(t, &backendtest.Fake{}), startHub(t, &fakeHub{status: http.StatusBadGateway}))

	rec := serve(app, asUser(http.MethodGet, "/api/v1/user"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("GET: %d %s", rec.Code, rec.Body.String())
	}
	id := rec.Header().Get("X-Request-Id")
	var request, failed string
	for line := range strings.SplitSeq(logs.String(), "\n") {
		switch {
		case strings.Contains(line, "msg=request "):
			request = line
		case strings.Contains(line, `msg="request failed"`):
			failed = line
		}
	}
	for what, line := range map[string]string{"request line": request, "failure line": failed} {
		if !strings.Contains(line, "id="+id) || !strings.Contains(line, "user=alice") {
			t.Errorf("%s = %q, want id=%s and user=alice", what, line, id)
		}
	}
	if strings.Contains(logs.String(), "sha256~token") {
		t.Fatalf("the token reached the log:\n%s", logs.String())
	}

	// A request refused before the identity is known has no user.
	logs.Reset()
	serve(app, httptest.NewRequest(http.MethodGet, "/api/v1/user", nil))
	if !strings.Contains(logs.String(), "msg=request ") || strings.Contains(logs.String(), "user=") {
		t.Errorf("anonymous request: %q", logs.String())
	}
}

// The kubelet's probes log at Debug when they succeed (thousands of lines a
// day); a failed probe is still a request line at Info.
func TestSuccessfulProbesLogAtDebug(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	fake := &backendtest.Fake{}
	app := NewApp(testConfig(t), slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo})), backendtest.Start(t, fake), startHub(t, &fakeHub{allowed: true}))
	for _, path := range []string{"/readyz", "/healthcheck"} {
		if rec := serve(app, httptest.NewRequest(http.MethodGet, path, nil)); rec.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, rec.Code)
		}
	}
	if logs.Len() != 0 {
		t.Fatalf("successful probes logged at Info:\n%s", logs.String())
	}
	fake.Err = backendtest.Status(codes.Unavailable, "down")
	serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if !strings.Contains(logs.String(), "msg=request ") || !strings.Contains(logs.String(), "status=503") || !strings.Contains(logs.String(), `"backend not ready"`) {
		t.Fatalf("a failed probe must still log:\n%s", logs.String())
	}
}

func TestPanicBecomes500(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	h := app.recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestAbortedAnswerIsNotA500(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	h := app.recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }))
	rec := httptest.NewRecorder()
	defer func() {
		if got, _ := recover().(error); !errors.Is(got, http.ErrAbortHandler) {
			t.Fatalf("recovered %v, want http.ErrAbortHandler passed on to net/http", got)
		}
		if rec.Code == http.StatusInternalServerError {
			t.Fatal("wrote a 500 over an aborted answer")
		}
	}()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	t.Fatal("recoverPanic swallowed http.ErrAbortHandler")
}

func TestClassify(t *testing.T) {
	t.Parallel()
	cases := []struct {
		err  error
		want int
	}{
		{Errorf(http.StatusTeapot, "x"), http.StatusTeapot},
		{fmt.Errorf("%w: provider-admin check: %w", errHub, context.DeadlineExceeded), http.StatusBadGateway},
		{errors.New("plain"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.err.Error(), func(t *testing.T) {
			if got, _ := classify(tc.err); got != tc.want {
				t.Errorf("classify(%v) = %d, want %d", tc.err, got, tc.want)
			}
		})
	}
}

// defaultPagePolicy is the console pages' Content-Security-Policy without a map tile server
// (pagePolicy): written out, so that a change to it shows in review.
const defaultPagePolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

func TestSPAHandler(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>index</html>"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "favicon.svg"), []byte("<svg/>"), 0o644))
	must(os.MkdirAll(filepath.Join(dir, "assets"), 0o755))
	// Names from a real `vite build`: the hash is base64url, so it may hold
	// upper case, `-` and `_`, and a name may have a double `-`.
	assets := []string{
		"index-yimuxjpv.js", "index-BPyNsiKc.css", "index--abzHtFK.js",
		"RedHatDisplayVF-D7m-OdR-.woff2", "ne_110m_land-BX_3ioGi.js", "ne_110m_land-BX_3ioGi.js.map",
	}
	for _, name := range assets {
		must(os.WriteFile(filepath.Join(dir, "assets", name), []byte("asset"), 0o644))
	}

	cfg := testConfig(t)
	cfg.StaticAssetsDir = dir
	h := newTestApp(t, cfg, nil).Handler()

	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		return rec
	}
	secure := func(what string, rec *httptest.ResponseRecorder) {
		t.Helper()
		for header, want := range map[string]string{
			"Content-Security-Policy": defaultPagePolicy,
			"X-Frame-Options":         "DENY",
			"X-Content-Type-Options":  "nosniff",
			"Referrer-Policy":         "same-origin",
		} {
			if got := rec.Header().Get(header); got != want {
				t.Errorf("%s: %s = %q, want %q", what, header, got, want)
			}
		}
	}
	for _, route := range []string{"/", "/clusters/local-cluster", "/subscriptions/view/engineering"} {
		rec := get(route)
		if rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
			t.Fatalf("%s -> %d %q", route, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q, want no-cache: index.html names the current bundle", route, got)
		}
		secure(route, rec)
	}
	for _, name := range assets {
		rec := get("/assets/" + name)
		if rec.Code != 200 || rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Errorf("asset %s -> %d %q, want immutable", name, rec.Code, rec.Header().Get("Cache-Control"))
		}
		secure(name, rec)
	}
	if rec := get("/favicon.svg"); rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("a root file -> %d %q, want no-cache: its name has no hash", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := get("/assets/missing.js"); rec.Code != 404 {
		t.Fatalf("missing asset -> %d", rec.Code)
	}
	// The JSON API is not a page: nosniff, but no frame or referrer policy of the SPA.
	rec := serve(newTestApp(t, cfg, nil), asUser(http.MethodGet, "/api/v1/config"))
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Content-Security-Policy") != "" {
		t.Errorf("API headers = %v", rec.Header())
	}
	raw := httptest.NewRequest(http.MethodGet, "/", nil)
	raw.URL.Path = "/../../etc/passwd"
	rec = httptest.NewRecorder()
	newSPAHandler(dir, defaultPagePolicy).ServeHTTP(rec, raw)
	if rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
		t.Fatalf("traversal should be cleaned to a client route, got %d %q", rec.Code, rec.Body.String())
	}
}

// TestWriteJSONFailureIs500: encoding happens before the status is committed,
// so a value JSON cannot carry is an error response, not a 200 with no body.
func TestWriteJSONFailureIs500(t *testing.T) {
	t.Parallel()
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

func TestConfigReportsFakeBackend(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	cfg.FakeBackend = true
	app := newTestApp(t, cfg, &backendtest.Fake{})
	var got ConsoleConfig
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/config")), &got)
	if !got.FakeBackend {
		t.Fatal("fakeBackend not reported")
	}
}
