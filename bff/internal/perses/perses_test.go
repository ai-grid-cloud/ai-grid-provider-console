package perses

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// project is the Perses project the test relays read.
const project = "ai-grid-monitoring"

func TestAllowed(t *testing.T) {
	relay, err := New(Config{URL: "https://perses.example.svc:8080", Project: project})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path, raw string
		want              int
	}{
		// What the dashboard components read: the configured project's, and the global datasources.
		{"GET", "/api/v1/projects/ai-grid-monitoring/dashboards", "", 0},
		{"GET", "/api/v1/projects/ai-grid-monitoring/dashboards/dashboard-0-fleet", "", 0},
		{"GET", "/api/v1/projects/ai-grid-monitoring/datasources", "", 0},
		{"GET", "/api/v1/projects/ai-grid-monitoring/datasources/thanos", "", 0},
		{"GET", "/api/v1/globaldatasources", "", 0},
		{"GET", "/api/v1/globaldatasources/thanos", "", 0},
		// Queries through a datasource's proxy, GET or the Prometheus plugin's POST form.
		{"GET", "/proxy/projects/ai-grid-monitoring/datasources/thanos/api/v1/query", "", 0},
		{"POST", "/proxy/projects/ai-grid-monitoring/datasources/thanos/api/v1/query_range", "", 0},
		{"GET", "/proxy/globaldatasources/thanos/api/v1/label/namespace/values", "", 0},
		{"GET", "/proxy/projects/ai-grid-monitoring/datasources/loki/loki/api/v1/query_range", "", 0},
		// Every project's list, another project, and a datasource a dashboard defines: Perses would
		// send the caller's token on to a server that whoever writes there chose.
		{"GET", "/api/v1/dashboards", "", http.StatusNotFound},
		{"POST", "/api/v1/dashboards", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/other/dashboards", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/other/datasources/thanos", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/ai-grid-monitoring-2/dashboards", "", http.StatusNotFound},
		{"GET", "/proxy/projects/other/datasources/thanos/api/v1/query", "", http.StatusNotFound},
		{"GET", "/proxy/projects/ai-grid-monitoring/dashboards/d/datasources/thanos/api/v1/query", "", http.StatusNotFound},
		{"POST", "/proxy/projects/ai-grid-monitoring/dashboards/d/datasources/thanos/api/v1/series", "", http.StatusNotFound},
		{"POST", "/proxy/unsaved/projects/ai-grid-monitoring/datasources/api/v1/query", "", http.StatusNotFound},
		// Writes and anything else Perses serves are refused.
		{"POST", "/api/v1/projects/ai-grid-monitoring/dashboards", "", http.StatusMethodNotAllowed},
		{"PUT", "/api/v1/projects/ai-grid-monitoring/dashboards/d", "", http.StatusMethodNotAllowed},
		{"DELETE", "/api/v1/globaldatasources/thanos", "", http.StatusMethodNotAllowed},
		{"GET", "/api/v1/users", "", http.StatusNotFound},
		{"GET", "/api/v1/projects", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/ai-grid-monitoring", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/ai-grid-monitoring/secrets", "", http.StatusNotFound},
		{"GET", "/api/auth/providers", "", http.StatusNotFound},
		{"GET", "/proxy/projects/ai-grid-monitoring/datasources/thanos/api/v1/admin/tsdb/delete_series", "", http.StatusNotFound},
		{"GET", "/proxy/projects/ai-grid-monitoring/datasources/thanos/federate", "", http.StatusNotFound},
		{"GET", "/plugins/Prometheus/mf-manifest.json", "", http.StatusNotFound},
		// Paths that could resolve to something else upstream.
		{"GET", "/api/v1/projects/ai-grid-monitoring/dashboards/../../users", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/ai-grid-monitoring/dashboards/../../other/dashboards", "", http.StatusNotFound},
		{"GET", "/api/v1//dashboards", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/ai-grid-monitoring/dashboards/", "", http.StatusNotFound},
		{"GET", "/api/v1/projects/ai-grid-monitoring/dashboards/a/b", "/api/v1/projects/ai-grid-monitoring/dashboards/a%2Fb", http.StatusNotFound},
		{"GET", "", "", http.StatusNotFound},
	} {
		got, _ := relay.Allowed(tc.method, tc.path, tc.raw)
		if got != tc.want {
			t.Errorf("Allowed(%s %q) = %d, want %d", tc.method, tc.path, got, tc.want)
		}
	}
}

// The project is matched as written: a dot in its name is a dot, not any character.
func TestAllowedMatchesTheProjectAsWritten(t *testing.T) {
	relay, err := New(Config{URL: "https://perses.example.svc:8080", Project: "ai.grid"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := relay.Allowed(http.MethodGet, "/api/v1/projects/ai.grid/dashboards", ""); got != 0 {
		t.Errorf("the configured project: got %d, want it allowed", got)
	}
	if got, _ := relay.Allowed(http.MethodGet, "/api/v1/projects/aiXgrid/dashboards", ""); got != http.StatusNotFound {
		t.Errorf("a project the dot matches as a pattern: got %d, want 404", got)
	}
}

func TestNewValidates(t *testing.T) {
	dir := t.TempDir()
	notPEM := filepath.Join(dir, "ca.txt")
	if err := os.WriteFile(notPEM, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		cfg  Config
		ok   bool
	}{
		{"https", Config{URL: "https://perses.example.svc:8080", Project: project}, true},
		{"loopback plaintext", Config{URL: "http://127.0.0.1:9005", Project: project}, true},
		{"localhost plaintext", Config{URL: "http://localhost:9005", Project: project}, true},
		{"remote plaintext", Config{URL: "http://perses.example.svc:8080", Project: project}, false},
		{"remote plaintext, insecure allowed", Config{URL: "http://perses.example.svc:8080", Project: project, Insecure: true}, true},
		{"no scheme", Config{URL: "perses.example.svc:8080", Project: project}, false},
		{"other scheme", Config{URL: "ftp://perses.example.svc", Project: project}, false},
		{"missing CA file", Config{URL: "https://perses.example.svc", Project: project, CAFile: filepath.Join(dir, "missing.crt")}, false},
		{"CA file without a certificate", Config{URL: "https://perses.example.svc", Project: project, CAFile: notPEM}, false},
		{"no project", Config{URL: "https://perses.example.svc"}, false},
		{"a project of letters, digits, dots, dashes and underscores", Config{URL: "https://perses.example.svc", Project: "Team_1.ai-grid"}, true},
		{"a project of two segments", Config{URL: "https://perses.example.svc", Project: "a/b"}, false},
		{"a dot segment for a project", Config{URL: "https://perses.example.svc", Project: ".."}, false},
		{"a project with a space", Config{URL: "https://perses.example.svc", Project: "ai grid"}, false},
		{"a project with a pattern character", Config{URL: "https://perses.example.svc", Project: "ai-grid|other"}, false},
	} {
		_, err := New(tc.cfg)
		if (err == nil) != tc.ok {
			t.Errorf("%s: New() error = %v, want ok=%v", tc.name, err, tc.ok)
		}
	}
}

type upstreamCall struct {
	method, path, query, body string
	header                    http.Header
}

// tlsUpstream starts a TLS server standing in for Perses and returns a relay that trusts it.
func tlsUpstream(t *testing.T, handler func(http.ResponseWriter, *http.Request), calls chan<- upstreamCall, timeout time.Duration) *Relay {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if calls != nil {
			calls <- upstreamCall{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, body: string(body), header: r.Header.Clone()}
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	ca := filepath.Join(t.TempDir(), "ca.crt")
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(ca, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	relay, err := New(Config{URL: srv.URL, CAFile: ca, Project: project, Timeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	return relay
}

func serve(relay *Relay, req *http.Request, token string) *httptest.ResponseRecorder {
	if token != "" {
		req = req.WithContext(WithToken(req.Context(), token))
	}
	rec := httptest.NewRecorder()
	relay.ServeHTTP(rec, req)
	return rec
}

func errorMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body %q is not the console's envelope: %v", rec.Body, err)
	}
	return body.Error.Code + " " + body.Error.Message
}

func TestRelayForwardsTheCallersTokenAndNothingElseOfTheirs(t *testing.T) {
	calls := make(chan upstreamCall, 1)
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "perses=session; Path=/")
		_, _ = w.Write([]byte(`[{"kind":"Dashboard"}]`))
	}, calls, 0)

	req := httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards?metadata_only=true", nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer client-sent")
	req.Header.Set("Cookie", "_oauth_proxy=console-session")
	req.Header.Set("X-Forwarded-Access-Token", "proxy-token")
	req.Header.Set("X-Forwarded-User", "alice")
	rec := serve(relay, req, "caller-token")

	if rec.Code != http.StatusOK || rec.Body.String() != `[{"kind":"Dashboard"}]` {
		t.Fatalf("got %d %q, want Perses's answer", rec.Code, rec.Body)
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Errorf("Perses's Set-Cookie reached the browser: %q", rec.Header().Get("Set-Cookie"))
	}
	got := <-calls
	if got.path != "/api/v1/projects/ai-grid-monitoring/dashboards" || got.query != "metadata_only=true" {
		t.Errorf("upstream got %s?%s, want the Perses path without the prefix and the same query", got.path, got.query)
	}
	if a := got.header.Get("Authorization"); a != "Bearer caller-token" {
		t.Errorf("Authorization = %q, want the caller's token", a)
	}
	for _, h := range []string{"Cookie", "X-Forwarded-Access-Token", "X-Forwarded-User"} {
		if v := got.header.Get(h); v != "" {
			t.Errorf("%s reached Perses: %q", h, v)
		}
	}
	if got.header.Get("Accept") != "application/json" {
		t.Errorf("Accept was dropped")
	}
}

func TestRelayPassesPersesErrorsThrough(t *testing.T) {
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"forbidden"}`))
	}, nil, 0)
	rec := serve(relay, httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil), "t")
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"message":"forbidden"}` {
		t.Fatalf("got %d %q, want Perses's 403 as it sent it", rec.Code, rec.Body)
	}
}

// An answer a browser could render, such as an HTML error page from a datasource, stays inert on
// the console's origin, whatever headers Perses sent.
func TestRelayAnswersCannotRunAsAPage(t *testing.T) {
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Security-Policy", "script-src *")
		_, _ = w.Write([]byte(`<script>alert(document.cookie)</script>`))
	}, nil, 0)
	rec := serve(relay, httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards/d", nil), "t")
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Values("Content-Security-Policy"); len(got) != 1 || got[0] != "sandbox; default-src 'none'" {
		t.Errorf("Content-Security-Policy = %q, want only the relay's sandbox", got)
	}
}

// Only the headers the browser needs to read an answer reach it. A CORS grant from Perses or a
// datasource would only open the answers to other sites, a Basic challenge would make the browser
// ask for a password on the console's origin, and a Refresh or Link would send it elsewhere.
func TestRelayPassesOnlyTheHeadersAnAnswerNeeds(t *testing.T) {
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Expose-Headers", "X-Thanos")
		w.Header().Set("WWW-Authenticate", `Basic realm="thanos"`)
		w.Header().Set("Refresh", "0; url=https://attacker.example/")
		w.Header().Set("Link", "<https://attacker.example/x.js>; rel=preload; as=script")
		w.Header().Set("Location", "https://attacker.example/")
		w.Header().Set("X-Thanos-Partial", "true")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"status":"error"}`))
	}, nil, 0)
	rec := serve(relay, httptest.NewRequest(http.MethodGet, Prefix+"/proxy/globaldatasources/thanos/api/v1/query", nil), "t")
	if rec.Code != http.StatusUnauthorized || rec.Body.String() != `{"status":"error"}` {
		t.Fatalf("got %d %q, want the datasource's 401 as it sent it", rec.Code, rec.Body)
	}
	for _, h := range []string{
		"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Expose-Headers",
		"WWW-Authenticate", "Refresh", "Link", "Location", "X-Thanos-Partial",
	} {
		if v := rec.Header().Values(h); len(v) != 0 {
			t.Errorf("%s reached the browser: %q", h, v)
		}
	}
	if rec.Header().Get("Content-Type") != "application/json" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Content-Type %q, Cache-Control %q: want Perses's", rec.Header().Get("Content-Type"), rec.Header().Get("Cache-Control"))
	}
}

// A cacheable answer keeps what a cache needs to tell how old it already is.
func TestRelayKeepsTheAgeOfACachedAnswer(t *testing.T) {
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "max-age=60")
		w.Header().Set("Age", "59")
		w.Header().Set("Date", "Mon, 26 Oct 2026 12:00:00 GMT")
		w.Header().Set("Expires", "Mon, 26 Oct 2026 12:00:01 GMT")
		_, _ = w.Write([]byte(`{}`))
	}, nil, 0)
	rec := serve(relay, httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil), "t")
	for h, want := range map[string]string{"Age": "59", "Date": "Mon, 26 Oct 2026 12:00:00 GMT", "Expires": "Mon, 26 Oct 2026 12:00:01 GMT"} {
		if got := rec.Header().Get(h); got != want {
			t.Errorf("%s = %q, want %q", h, got, want)
		}
	}
}

// ReverseProxy forwards a 1xx and the trailers outside ModifyResponse; neither reaches the browser.
// Over real connections, since a recorder sees neither the way a browser would.
func TestRelayDropsInformationalAnswersAndTrailers(t *testing.T) {
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Link", "<https://attacker.example/x.js>; rel=preload; as=script")
		w.WriteHeader(http.StatusEarlyHints)
		w.Header().Del("Link")
		w.Header().Set("Trailer", "X-Declared")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"success"}`))
		w.Header().Set("X-Declared", "x")
		w.Header().Set(http.TrailerPrefix+"X-Undeclared", "y")
	}, nil, 0)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		relay.ServeHTTP(w, r.WithContext(WithToken(r.Context(), "t")))
	}))
	t.Cleanup(front.Close)

	var informational []int
	trace := &httptrace.ClientTrace{Got1xxResponse: func(code int, _ textproto.MIMEHeader) error {
		informational = append(informational, code)
		return nil
	}}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace),
		http.MethodGet, front.URL+Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != `{"status":"success"}` {
		t.Fatalf("got %d %q, want Perses's answer", resp.StatusCode, body)
	}
	if len(informational) != 0 {
		t.Errorf("informational answers reached the browser: %v", informational)
	}
	if v := resp.Header.Values("Link"); len(v) != 0 {
		t.Errorf("Link reached the browser: %q", v)
	}
	if len(resp.Trailer) != 0 || resp.Header.Get("Trailer") != "" {
		t.Errorf("trailers reached the browser: %v, announced %q", resp.Trailer, resp.Header.Get("Trailer"))
	}
}

// A redirect from Perses never reaches the browser, whatever its status: it answers 502 instead,
// without the Location.
func TestRelayRefusesRedirects(t *testing.T) {
	for _, code := range []int{http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusNotModified, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Location", "https://attacker.example/")
			w.Header().Set("Refresh", "0; url=https://attacker.example/")
			w.WriteHeader(code)
		}, nil, 0)
		rec := serve(relay, httptest.NewRequest(http.MethodGet, Prefix+"/proxy/globaldatasources/thanos/api/v1/query", nil), "t")
		if rec.Code != http.StatusBadGateway {
			t.Errorf("%d: got %d, want 502", code, rec.Code)
		}
		if msg := errorMessage(t, rec); !strings.Contains(msg, "redirect") {
			t.Errorf("%d: message %q", code, msg)
		}
		for _, h := range []string{"Location", "Refresh"} {
			if v := rec.Header().Get(h); v != "" {
				t.Errorf("%d: %s reached the browser: %q", code, h, v)
			}
		}
	}
}

// A browser that accepts gzip gets Perses's compressed answer as it was sent; a client that
// doesn't gets it uncompressed.
func TestRelayPassesCompressedAnswersThrough(t *testing.T) {
	const plain = `{"status":"success","data":{"resultType":"matrix","result":[]}}`
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	_, _ = zw.Write([]byte(plain))
	_ = zw.Close()

	calls := make(chan upstreamCall, 2)
	relay := tlsUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(compressed.Bytes())
			return
		}
		_, _ = w.Write([]byte(plain))
	}, calls, 0)
	path := Prefix + "/proxy/projects/ai-grid-monitoring/datasources/thanos/api/v1/query_range"

	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	rec := serve(relay, req, "t")
	if got := (<-calls).header.Get("Accept-Encoding"); got != "gzip, deflate, br" {
		t.Errorf("Perses got Accept-Encoding %q, want the browser's", got)
	}
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "gzip" || !bytes.Equal(rec.Body.Bytes(), compressed.Bytes()) {
		t.Errorf("gzip: got %d, Content-Encoding %q, %d bytes; want Perses's %d gzip bytes unchanged",
			rec.Code, rec.Header().Get("Content-Encoding"), rec.Body.Len(), compressed.Len())
	}

	rec = serve(relay, httptest.NewRequest(http.MethodGet, path, nil), "t")
	<-calls
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != plain {
		t.Errorf("no Accept-Encoding: got %d, Content-Encoding %q, %q; want the plain answer",
			rec.Code, rec.Header().Get("Content-Encoding"), rec.Body)
	}
}

func TestRelayQueriesWithTheFormThePrometheusPluginSends(t *testing.T) {
	calls := make(chan upstreamCall, 1)
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success"}`))
	}, calls, 0)
	path := Prefix + "/proxy/projects/ai-grid-monitoring/datasources/thanos/api/v1/query_range"
	form := "query=up&start=1&end=2&step=15"

	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if rec := serve(relay, req, "t"); rec.Code != http.StatusOK {
		t.Fatalf("query: got %d %q", rec.Code, rec.Body)
	}
	got := <-calls
	if got.method != http.MethodPost || got.body != form || got.header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Errorf("upstream got %s %q (%s), want the form unchanged", got.method, got.body, got.header.Get("Content-Type"))
	}

	req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"query":"up"}`))
	req.Header.Set("Content-Type", "application/json")
	if rec := serve(relay, req, "t"); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("JSON query: got %d, want 415", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, path, strings.NewReader("query="+strings.Repeat("a", MaxBodyBytes)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if rec := serve(relay, req, "t"); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized query: got %d %q, want 413", rec.Code, rec.Body)
	}
}

func TestRelayRefuses(t *testing.T) {
	calls := make(chan upstreamCall, 1)
	relay := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {}, calls, 0)
	for _, tc := range []struct {
		name  string
		req   *http.Request
		token string
		want  int
	}{
		{"no token", httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil), "", http.StatusUnauthorized},
		{"a write", httptest.NewRequest(http.MethodDelete, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards/d", nil), "t", http.StatusMethodNotAllowed},
		{"another project", httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/other/dashboards", nil), "t", http.StatusNotFound},
		{"every project's dashboards", httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/dashboards", nil), "t", http.StatusNotFound},
		{"a dashboard's own datasource", httptest.NewRequest(http.MethodGet, Prefix+"/proxy/projects/ai-grid-monitoring/dashboards/d/datasources/x/api/v1/query", nil), "t", http.StatusNotFound},
		{"a path outside the allowlist", httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/users", nil), "t", http.StatusNotFound},
		{"outside the prefix", httptest.NewRequest(http.MethodGet, "/other/api/v1/dashboards", nil), "t", http.StatusNotFound},
	} {
		rec := serve(relay, tc.req, tc.token)
		if rec.Code != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, rec.Code, tc.want)
		}
		_ = errorMessage(t, rec)
	}
	select {
	case c := <-calls:
		t.Errorf("a refused request reached Perses: %s %s", c.method, c.path)
	default:
	}
}

func TestRelayWhenPersesFails(t *testing.T) {
	// Down: nothing listens at the address.
	relay, err := New(Config{URL: "http://127.0.0.1:1", Project: project})
	if err != nil {
		t.Fatal(err)
	}
	rec := serve(relay, httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil), "t")
	if rec.Code != http.StatusBadGateway {
		t.Errorf("down: got %d, want 502", rec.Code)
	}
	if msg := errorMessage(t, rec); !strings.Contains(msg, "could not be reached") {
		t.Errorf("down: message %q", msg)
	}

	// Slow: the response headers don't arrive within the timeout.
	release := make(chan struct{})
	slow := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) { <-release }, nil, 50*time.Millisecond)
	defer close(release)
	rec = serve(slow, httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil), "t")
	if rec.Code != http.StatusGatewayTimeout {
		t.Errorf("slow: got %d %q, want 504", rec.Code, rec.Body)
	}

	// Slow answer: the headers arrive, the body stalls; the timeout cuts it too.
	stall := make(chan struct{})
	defer close(stall)
	stalls := tlsUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"partial":`))
		w.(http.Flusher).Flush()
		<-stall
	}, nil, 50*time.Millisecond)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- serve(stalls, httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil), "t")
	}()
	select {
	case rec = <-done:
		if rec.Body.String() != `{"partial":` {
			t.Errorf("slow answer: body %q", rec.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("slow answer: the relay did not cut a stalled body at its timeout")
	}

	// Untrusted: the certificate isn't signed by the configured CA.
	other := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer other.Close()
	untrusted, err := New(Config{URL: other.URL, Project: project})
	if err != nil {
		t.Fatal(err)
	}
	rec = serve(untrusted, httptest.NewRequest(http.MethodGet, Prefix+"/api/v1/projects/ai-grid-monitoring/dashboards", nil), "t")
	if rec.Code != http.StatusBadGateway {
		t.Errorf("untrusted certificate: got %d, want 502", rec.Code)
	}
}
