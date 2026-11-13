package relay_test

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/relay"
)

const list = "/ai_grid.v1.Clusters/List"

// headers are the proxy headers the BFF reads the caller from, as config's defaults.
var headers = identity.Headers{
	Token:  "x-forwarded-access-token",
	User:   "x-forwarded-user",
	Email:  "x-forwarded-email",
	Groups: "x-forwarded-groups",
}

// seen is what the fake backend received.
type seen struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
}

func (s *seen) record(r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, r)
	s.bodies = append(s.bodies, string(body))
}

func (s *seen) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func (s *seen) last(t *testing.T) (*http.Request, string) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requests) == 0 {
		t.Fatal("the call never reached the backend")
	}
	return s.requests[len(s.requests)-1], s.bodies[len(s.bodies)-1]
}

// connectBackend answers every call as a Connect unary answer would, and records it.
func connectBackend(t *testing.T) (*httptest.Server, *seen) {
	t.Helper()
	s := &seen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"size":0,"total":0}`))
	}))
	t.Cleanup(srv.Close)
	return srv, s
}

func newRelay(t *testing.T, cfg backend.Config, identityHeaders ...string) *relay.Relay {
	t.Helper()
	if identityHeaders == nil {
		identityHeaders = []string{headers.Token, headers.User, headers.Email, headers.Groups}
	}
	r, err := relay.New(relay.Config{Backend: cfg, IdentityHeaders: identityHeaders, Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func relayTo(t *testing.T, srv *httptest.Server) *relay.Relay {
	t.Helper()
	return newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://")})
}

// asCaller is what reaches the relay behind the BFF's requireIdentity: the proxy's headers, and
// the identity read from them on the context.
func asCaller(t *testing.T, method, target string, body io.Reader, h http.Header) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set(headers.Token, "sha256~caller")
	req.Header.Set(headers.User, "alice")
	req.Header.Set(headers.Email, "alice@example.com")
	req.Header.Set(headers.Groups, "cluster-admins,ops")
	for k, v := range h {
		req.Header[k] = v
	}
	id, err := headers.Extract(req.Header)
	if err != nil {
		t.Fatal(err)
	}
	return req.WithContext(identity.WithIdentity(req.Context(), id))
}

func serve(r *relay.Relay, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// connectError decodes the BFF's own answer, a Connect error.
func connectError(t *testing.T, rec *httptest.ResponseRecorder) (code, message string) {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q, want application/json", ct)
	}
	var body struct{ Code, Message string }
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body, err)
	}
	return body.Code, body.Message
}

func TestRelaysTheCallUnchanged(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)

	rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(`{"limit":5}`), http.Header{
		"Connect-Timeout-Ms": {"3000"},
		"Accept-Encoding":    {"gzip"},
	}))
	if rec.Code != http.StatusOK || rec.Body.String() != `{"size":0,"total":0}` || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %d %q %q, want the backend's answer", rec.Code, rec.Header().Get("Content-Type"), rec.Body)
	}
	req, body := got.last(t)
	if req.Method != http.MethodPost || req.URL.Path != list || body != `{"limit":5}` {
		t.Errorf("backend got %s %s %q, want POST %s {\"limit\":5}", req.Method, req.URL.Path, body, list)
	}
	for k, want := range map[string]string{"Content-Type": "application/json", "Connect-Protocol-Version": "1", "Connect-Timeout-Ms": "3000", "Accept-Encoding": "gzip"} {
		if v := req.Header.Get(k); v != want {
			t.Errorf("backend got %s %q, want %q", k, v, want)
		}
	}

	// Connect's GET: the message is in the query, which passes as sent.
	query := "connect=v1&encoding=json&message=%7B%22id%22%3A%22site-paris-1%22%7D"
	rec = serve(r, asCaller(t, http.MethodGet, "/ai_grid.v1.Clusters/Get?"+query, nil, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: got %d %q", rec.Code, rec.Body)
	}
	if req, _ := got.last(t); req.Method != http.MethodGet || req.URL.Path != "/ai_grid.v1.Clusters/Get" || req.URL.RawQuery != query {
		t.Errorf("backend got %s %s?%s", req.Method, req.URL.Path, req.URL.RawQuery)
	}
}

// The backend's own errors (a Connect error, its status) reach the browser as it sent them.
func TestRelaysTheBackendsErrors(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"not_found","message":"object with identifier 'x' not found"}`))
	}))
	defer srv.Close()
	rec := serve(relayTo(t, srv), asCaller(t, http.MethodPost, "/ai_grid.v1.Clusters/Get", strings.NewReader(`{"id":"x"}`), nil))
	if code, msg := connectError(t, rec); rec.Code != http.StatusNotFound || code != "not_found" || msg != "object with identifier 'x' not found" {
		t.Fatalf("got %d %s %q", rec.Code, code, msg)
	}
}

// Whatever the browser sends about who it is stays behind: the backend gets the caller as the BFF
// read it from the proxy headers, each value percent-encoded (backend.EncodeMetadataValue).
func TestForwardsOnlyTheCallersIdentity(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://")},
		headers.Token, headers.User, headers.Email, headers.Groups, "X-Remote-User")

	forged := http.Header{
		"Authorization":                  {"Bearer sha256~forged"},
		"Proxy-Authorization":            {"Basic Zm9yZ2Vk"},
		"Cookie":                         {"_oauth_proxy=forged"},
		"Forwarded":                      {"for=203.0.113.9;by=forged"},
		"X-Forwarded-For":                {"203.0.113.9"},
		"X-Forwarded-Host":               {"forged.example.com"},
		"X-Forwarded-Proto":              {"http"},
		"X-Forwarded-Preferred-Username": {"mallory"},
		"X-Auth-Request-User":            {"mallory"},
		"X-Auth-Request-Access-Token":    {"sha256~forged"},
		"X-Remote-User":                  {"mallory"},
	}
	req := asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), forged)
	// A second value under the names the BFF sets: never forwarded either.
	req.Header.Add("X-Forwarded-User", "mallory")
	req.Header.Add("X-Forwarded-Groups", "system:masters")
	req.Header.Add("X-Forwarded-Access-Token", "sha256~forged")
	if rec := serve(r, req); rec.Code != http.StatusOK {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}

	out, _ := got.last(t)
	want := http.Header{
		"Authorization":      {"Bearer sha256~caller"},
		"X-Forwarded-User":   {"alice"},
		"X-Forwarded-Email":  {"alice@example.com"},
		"X-Forwarded-Groups": {"cluster-admins,ops"},
	}
	for k, v := range want {
		if got := out.Header.Values(k); strings.Join(got, "|") != strings.Join(v, "|") {
			t.Errorf("backend got %s %q, want %q", k, got, v)
		}
	}
	for k, vs := range out.Header {
		for _, v := range vs {
			if strings.Contains(v, "forged") || strings.Contains(v, "mallory") || strings.Contains(v, "system:masters") || strings.Contains(v, "203.0.113.9") {
				t.Errorf("a forged value reached the backend: %s: %q", k, v)
			}
		}
		if _, ok := want[k]; !ok && (strings.HasPrefix(k, "X-Forwarded-") || strings.HasPrefix(k, "X-Auth-Request-")) {
			t.Errorf("backend got proxy header %s", k)
		}
	}
	for _, k := range []string{"Cookie", "Proxy-Authorization", "Forwarded", "X-Forwarded-Access-Token", "X-Remote-User"} {
		if v := out.Header.Values(k); len(v) > 0 {
			t.Errorf("backend got %s %q", k, v)
		}
	}
}

// A name outside printable ASCII is percent-encoded, each group on its own, as for gRPC metadata;
// an identity without email or groups sends neither, not the forged ones.
func TestIdentityEncodingAndMissingFields(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)

	req := httptest.NewRequest(http.MethodPost, list, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headers.Token, "sha256~caller")
	req.Header.Set(headers.User, "équipe-admin")
	req.Header.Set(headers.Groups, "équipe-ops,100%")
	id, err := headers.Extract(req.Header)
	if err != nil {
		t.Fatal(err)
	}
	if rec := serve(r, req.WithContext(identity.WithIdentity(req.Context(), id))); rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	out, _ := got.last(t)
	if u, g := out.Header.Get("X-Forwarded-User"), out.Header.Get("X-Forwarded-Groups"); u != "%C3%A9quipe-admin" || g != "%C3%A9quipe-ops,100%25" {
		t.Errorf("user %q groups %q", u, g)
	}

	bare := httptest.NewRequest(http.MethodPost, list, strings.NewReader(`{}`))
	bare.Header.Set("Content-Type", "application/json")
	bare.Header.Set(headers.Token, "sha256~caller")
	id, err = headers.Extract(bare.Header)
	if err != nil {
		t.Fatal(err)
	}
	bare.Header.Set("X-Forwarded-Email-Forged", "x")
	if rec := serve(r, bare.WithContext(identity.WithIdentity(bare.Context(), id))); rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	out, _ = got.last(t)
	for _, k := range []string{"X-Forwarded-User", "X-Forwarded-Email", "X-Forwarded-Groups", "X-Forwarded-Email-Forged"} {
		if v := out.Header.Values(k); len(v) > 0 {
			t.Errorf("backend got %s %q for a caller without it", k, v)
		}
	}
}

func TestNoIdentityIsRefused(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	req := httptest.NewRequest(http.MethodPost, list, strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer sha256~forged")
	rec := serve(relayTo(t, srv), req)
	if code, _ := connectError(t, rec); rec.Code != http.StatusUnauthorized || code != "unauthenticated" {
		t.Fatalf("got %d %s", rec.Code, code)
	}
	if got.count() != 0 {
		t.Fatal("a call without an identity reached the backend")
	}
}

func TestOnlyPostAndGet(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)
	for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead, http.MethodOptions, "TRACE", "CONNECT"} {
		rec := serve(r, asCaller(t, method, list, nil, nil))
		if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, POST" {
			t.Errorf("%s: got %d Allow %q, want 405 with Allow: GET, POST", method, rec.Code, rec.Header().Get("Allow"))
			continue
		}
		if method != http.MethodHead {
			if code, _ := connectError(t, rec); code != "unimplemented" {
				t.Errorf("%s: code %s", method, code)
			}
		}
	}
	if got.count() != 0 {
		t.Fatalf("%d refused call(s) reached the backend", got.count())
	}
}

// Only /ai_grid.v1.<Service>/<Method> passes, so the backend routes the path the relay checked:
// not its REST gateway, health or reflection on the same port, nor a path it would clean or decode
// into another.
func TestOnlyProcedurePaths(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)
	for _, target := range []string{
		"/ai_grid.v1.Clusters",
		"/ai_grid.v1.Clusters/",
		"/ai_grid.v1./List",
		"/ai_grid.v1.Clusters/List/extra",
		"/ai_grid.v1.Clusters/../../api/v1/clusters",
		"/ai_grid.v1.Clusters/./List",
		"/ai_grid.v1.Clusters//List",
		"/ai_grid.v1.Clusters%2FList",
		"/ai_grid.v1.Clus%74ers/List",
		"/ai_grid.v1.draft.v1.Models/List",
		"/grpc.health.v1.Health/Check",
		"/api/v1/clusters",
	} {
		rec := serve(r, asCaller(t, http.MethodPost, target, strings.NewReader(`{}`), nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", target, rec.Code)
			continue
		}
		if code, _ := connectError(t, rec); code != "unimplemented" {
			t.Errorf("%s: code %s", target, code)
		}
	}
	if got.count() != 0 {
		t.Fatalf("%d refused path(s) reached the backend", got.count())
	}
}

func TestBodyLimit(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)

	// Declared too large: refused before the backend is called.
	big := strings.Repeat("a", relay.MaxBodyBytes+1)
	rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(big), nil))
	if code, msg := connectError(t, rec); rec.Code != http.StatusRequestEntityTooLarge || code != "resource_exhausted" || !strings.Contains(msg, "1048576") {
		t.Fatalf("declared: got %d %s %q", rec.Code, code, msg)
	}
	if got.count() != 0 {
		t.Fatal("a declared oversized body reached the backend")
	}

	// Sent without a length (chunked): cut at the limit while it streams to the backend.
	req := asCaller(t, http.MethodPost, list, io.MultiReader(strings.NewReader(big)), nil)
	req.ContentLength = -1
	rec = serve(r, req)
	if code, _ := connectError(t, rec); rec.Code != http.StatusRequestEntityTooLarge || code != "resource_exhausted" {
		t.Fatalf("chunked: got %d %s", rec.Code, code)
	}

	// At the limit: passes whole.
	exact := strings.Repeat("a", relay.MaxBodyBytes)
	rec = serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(exact), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("at the limit: got %d %q", rec.Code, rec.Body)
	}
	if _, body := got.last(t); len(body) != relay.MaxBodyBytes {
		t.Fatalf("backend got %d bytes, want %d", len(body), relay.MaxBodyBytes)
	}
}

// stallingBackend holds every call until release is called or the call is cancelled: a unary
// call (and a stream sent with X-Stall-Headers) with nothing sent, any other stream with its
// headers sent, after which it says so on streaming. A released call answers `{}`.
func stallingBackend(t *testing.T) (srv *httptest.Server, streaming <-chan struct{}, release func()) {
	t.Helper()
	opened := make(chan struct{}, 1)
	released := make(chan struct{})
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ct := r.Header.Get("Content-Type")
		if strings.HasPrefix(ct, "application/connect+") && r.Header.Get("X-Stall-Headers") == "" {
			w.Header().Set("Content-Type", ct)
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			opened <- struct{}{}
		}
		select {
		case <-released:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", ct)
		_, _ = w.Write([]byte(`{}`))
	}))
	release = sync.OnceFunc(func() { close(released) })
	t.Cleanup(srv.Close)
	t.Cleanup(release) // before Close, which waits for the handlers
	return srv, opened, release
}

// A unary call is cut at the backend timeout with 504.
func TestUnaryTimeout(t *testing.T) {
	t.Parallel()
	srv, _, _ := stallingBackend(t)
	r := newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://"), Timeout: 100 * time.Millisecond})
	for _, method := range []string{http.MethodPost, http.MethodGet} {
		rec := serve(r, asCaller(t, method, list, strings.NewReader(`{}`), nil))
		if code, _ := connectError(t, rec); rec.Code != http.StatusGatewayTimeout || code != "deadline_exceeded" {
			t.Errorf("%s unary: got %d %s, want 504 deadline_exceeded", method, rec.Code, code)
		}
	}
}

// A stream whose headers came isn't cut at the unary timeout. It is open before a unary call
// starts, so once that call has timed out the stream has outlived the timeout, and it still gets
// its whole answer when the backend sends it.
func TestStreamOutlivesTheUnaryTimeout(t *testing.T) {
	// Not parallel: the stream's headers must arrive within the 100 ms timeout.
	for _, ct := range []string{"application/connect+json", "application/connect+proto"} {
		t.Run(ct, func(t *testing.T) {
			srv, streaming, release := stallingBackend(t)
			r := newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://"), Timeout: 100 * time.Millisecond})
			stream := asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), http.Header{"Content-Type": {ct}})
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- serve(r, stream) }()
			select {
			case <-streaming:
			case rec := <-done:
				t.Fatalf("the stream ended before the backend sent its headers: %d %q", rec.Code, rec.Body)
			}

			rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), nil))
			if code, _ := connectError(t, rec); rec.Code != http.StatusGatewayTimeout || code != "deadline_exceeded" {
				t.Fatalf("unary call next to the stream: got %d %s, want 504 deadline_exceeded", rec.Code, code)
			}
			release()
			if rec := <-done; rec.Code != http.StatusOK || rec.Body.String() != `{}` {
				t.Errorf("stream: got %d %q, want the whole answer after the unary timeout", rec.Code, rec.Body)
			}
		})
	}
}

// A backend that sends no headers can't hold a call, a stream included: past the backend timeout
// the relay answers 504 (the transport's ResponseHeaderTimeout).
func TestResponseHeaderTimeout(t *testing.T) {
	t.Parallel()
	srv, _, _ := stallingBackend(t)
	r := newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://"), Timeout: 100 * time.Millisecond})
	rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), http.Header{
		"Content-Type":    {"application/connect+json"},
		"X-Stall-Headers": {"1"},
	}))
	if code, _ := connectError(t, rec); rec.Code != http.StatusGatewayTimeout || code != "deadline_exceeded" {
		t.Fatalf("stream without headers: got %d %s %q, want 504 deadline_exceeded", rec.Code, code, rec.Body)
	}
}

// The procedures that change data, by the allowlist; every other allowed one reads.
var writeProcedures = []string{
	"/ai_grid.v1.Clusters/Update",
	"/ai_grid.v1.Tenants/Create", "/ai_grid.v1.Tenants/Update", "/ai_grid.v1.Tenants/Delete",
	"/ai_grid.v1.Models/Create", "/ai_grid.v1.Models/Update", "/ai_grid.v1.Models/Delete",
	"/ai_grid.v1.Subscriptions/Create", "/ai_grid.v1.Subscriptions/Update", "/ai_grid.v1.Subscriptions/Delete",
}

var readProcedures = []string{
	"/ai_grid.v1.AiGrid/Ping",
	"/ai_grid.v1.Clusters/List", "/ai_grid.v1.Clusters/Get",
	"/ai_grid.v1.Tenants/List", "/ai_grid.v1.Tenants/Get",
	"/ai_grid.v1.Models/List", "/ai_grid.v1.Models/Get", "/ai_grid.v1.Models/ListPlacementClusters",
	"/ai_grid.v1.Subscriptions/List", "/ai_grid.v1.Subscriptions/Get",
}

func TestIsWrite(t *testing.T) {
	t.Parallel()
	for _, path := range writeProcedures {
		if !relay.IsWrite(path) {
			t.Errorf("IsWrite(%q) = false, want true", path)
		}
	}
	for _, path := range append(readProcedures, "/ai_grid.v1.Clusters/Delete", "/ai_grid.v1.NewService/Create") {
		if relay.IsWrite(path) {
			t.Errorf("IsWrite(%q) = true, want false (a read, or not allowed at all)", path)
		}
	}
}

// A write is cut at the write timeout, not the read timeout: with a long read timeout and a short
// write timeout, every write procedure is 504 while the stalling backend still holds it.
func TestWriteTimeoutBoundsWrites(t *testing.T) {
	t.Parallel()
	srv, _, _ := stallingBackend(t)
	r := newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://"), Timeout: time.Minute, WriteTimeout: 100 * time.Millisecond})
	for _, path := range writeProcedures {
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			rec := serve(r, asCaller(t, http.MethodPost, path, strings.NewReader(`{}`), nil))
			if code, _ := connectError(t, rec); rec.Code != http.StatusGatewayTimeout || code != "deadline_exceeded" {
				t.Errorf("got %d %s, want 504 deadline_exceeded at the write timeout", rec.Code, code)
			}
		})
	}
}

// A read is cut at the read timeout, whatever the write timeout.
func TestReadTimeoutBoundsReads(t *testing.T) {
	t.Parallel()
	srv, _, _ := stallingBackend(t)
	r := newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://"), Timeout: 100 * time.Millisecond, WriteTimeout: time.Minute})
	for _, path := range readProcedures {
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			rec := serve(r, asCaller(t, http.MethodPost, path, strings.NewReader(`{}`), nil))
			if code, _ := connectError(t, rec); rec.Code != http.StatusGatewayTimeout || code != "deadline_exceeded" {
				t.Errorf("got %d %s, want 504 deadline_exceeded at the read timeout", rec.Code, code)
			}
		})
	}
}

// A write outlives the read timeout: it is open at the backend before a read starts, so once the
// read has timed out the write has outlived the read timeout, and it still gets the backend's
// answer, headers included (the write transport's ResponseHeaderTimeout is the write timeout).
func TestWriteOutlivesTheReadTimeout(t *testing.T) {
	t.Parallel()
	arrived := make(chan struct{}, 1)
	released := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ai_grid.v1.Models/Create" {
			arrived <- struct{}{}
		}
		select {
		case <-released:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":{}}`))
	}))
	release := sync.OnceFunc(func() { close(released) })
	t.Cleanup(srv.Close)
	t.Cleanup(release)
	r := newRelay(t, backend.Config{Address: strings.TrimPrefix(srv.URL, "http://"), Timeout: 100 * time.Millisecond, WriteTimeout: time.Minute})

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- serve(r, asCaller(t, http.MethodPost, "/ai_grid.v1.Models/Create", strings.NewReader(`{}`), nil))
	}()
	select {
	case <-arrived:
	case rec := <-done:
		t.Fatalf("the write ended before it reached the backend: %d %q", rec.Code, rec.Body)
	}
	rec := serve(r, asCaller(t, http.MethodPost, "/ai_grid.v1.Models/Get", strings.NewReader(`{}`), nil))
	if code, _ := connectError(t, rec); rec.Code != http.StatusGatewayTimeout || code != "deadline_exceeded" {
		t.Fatalf("read next to the write: got %d %s, want 504 deadline_exceeded", rec.Code, code)
	}
	release()
	if rec := <-done; rec.Code != http.StatusOK || rec.Body.String() != `{"object":{}}` {
		t.Errorf("write: got %d %q, want the backend's answer after the read timeout", rec.Code, rec.Body)
	}
}

// Only the Connect protocol passes: gRPC, gRPC-Web (which the backend serves on the same port)
// and any other body are 415 before the backend is called.
func TestOnlyConnectContentTypes(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)
	for _, ct := range []string{
		"application/grpc",
		"application/grpc+proto",
		"application/grpc-web+proto",
		"application/grpc-web-text",
		"text/plain",
		"application/x-www-form-urlencoded",
		"application/connect+thrift",
		"",
	} {
		rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), http.Header{"Content-Type": {ct}}))
		if code, _ := connectError(t, rec); rec.Code != http.StatusUnsupportedMediaType || code != "unimplemented" {
			t.Errorf("%q: got %d %s, want 415 unimplemented", ct, rec.Code, code)
		}
	}
	if got.count() != 0 {
		t.Fatalf("%d refused call(s) reached the backend", got.count())
	}
	for _, ct := range []string{"application/json; charset=utf-8", "APPLICATION/PROTO", "application/connect+json", "application/connect+proto"} {
		if rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), http.Header{"Content-Type": {ct}})); rec.Code != http.StatusOK {
			t.Errorf("%q: got %d %q", ct, rec.Code, rec.Body)
		}
	}
}

// Of the backend's answer only what a Connect client and the browser need comes back; the backend
// can't set a cookie for the console's origin, open it to other sites or speak for its security
// headers.
func TestRelaysOnlyTheResponseHeadersAClientNeeds(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		for k, v := range map[string]string{
			"Content-Type":                     "application/json",
			"Accept-Encoding":                  "gzip",
			"Connect-Content-Encoding":         "identity",
			"Trailer-X-Backend-Trace":          "abc",
			"Grpc-Status":                      "0",
			"Vary":                             "Accept-Encoding",
			"Cache-Control":                    "private, max-age=5",
			"Set-Cookie":                       "_oauth_proxy=stolen; Path=/",
			"Access-Control-Allow-Origin":      "*",
			"Access-Control-Allow-Credentials": "true",
			"Www-Authenticate":                 `Basic realm="backend"`,
			"Location":                         "https://attacker.example/",
			"Refresh":                          "0; url=https://attacker.example/",
			"Content-Security-Policy":          "default-src *",
			"X-Content-Type-Options":           "sniff",
			"X-Frame-Options":                  "ALLOWALL",
			"Strict-Transport-Security":        "max-age=0",
			"X-Backend-Internal":               "node-7",
		} {
			h.Set(k, v)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	rec := serve(relayTo(t, srv), asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %q", rec.Code, rec.Body)
	}
	want := map[string]string{
		"Content-Type":             "application/json",
		"Content-Length":           "2",
		"Accept-Encoding":          "gzip",
		"Connect-Content-Encoding": "identity",
		"Trailer-X-Backend-Trace":  "abc",
		"Grpc-Status":              "0",
		"Vary":                     "Accept-Encoding",
		"Cache-Control":            "private, max-age=5",
		"Date":                     rec.Header().Get("Date"),
		"X-Content-Type-Options":   "nosniff",
	}
	if rec.Header().Get("Date") == "" {
		t.Error("the backend's Date did not pass")
	}
	for k, v := range want {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	for k := range rec.Header() {
		if _, ok := want[k]; !ok {
			t.Errorf("the backend's %s reached the browser: %q", k, rec.Header().Values(k))
		}
	}
}

// A server stream reaches the browser as the backend flushes it, not at its end. The pinned API has
// no streaming RPC and the relay passes only allowed procedures; it tells a stream by its content
// type, so an allowed path carries one here.
func TestStreamsFlushAsTheyCome(t *testing.T) {
	t.Parallel()
	released := make(chan struct{})
	release := sync.OnceFunc(func() { close(released) })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/connect+json")
		_, _ = w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		select {
		case <-released:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte("second\n"))
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(release) // a failed read must not leave the handler waiting: Close waits for it
	r := relayTo(t, srv)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		id, err := headers.Extract(req.Header)
		if err != nil {
			t.Error(err)
			return
		}
		r.ServeHTTP(w, req.WithContext(identity.WithIdentity(req.Context(), id)))
	}))
	t.Cleanup(front.Close)

	// A relay that holds the first message back fails by never answering while the backend keeps
	// the stream open, so no event can end the wait: only a clock can. The deadline turns that hang
	// into a failure and does not decide the outcome otherwise: a relay that flushes delivers both
	// messages in milliseconds, and the second is sent only after the test reads the first.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, front.URL+"/ai_grid.v1.Clusters/List", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/connect+json")
	req.Header.Set(headers.Token, "sha256~caller")
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	lines := bufio.NewReader(resp.Body)
	if line, err := lines.ReadString('\n'); err != nil || line != "first\n" {
		t.Fatalf("first message: got %q, %v; want %q", line, err, "first\n")
	}
	release()
	if line, err := lines.ReadString('\n'); err != nil || line != "second\n" {
		t.Fatalf("second message: got %q, %v; want %q", line, err, "second\n")
	}
}

// hangUpListener accepts connections and closes them at once: a backend that is down, without
// relying on a closed port staying free while other test binaries run.
func hangUpListener(t *testing.T) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lis.Close() })
	go func() {
		for {
			conn, err := lis.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	return lis.Addr().String()
}

func TestBackendUnreachable(t *testing.T) {
	t.Parallel()
	rec := serve(newRelay(t, backend.Config{Address: hangUpListener(t)}), asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), nil))
	if code, msg := connectError(t, rec); rec.Code != http.StatusBadGateway || code != "unavailable" || msg != "the AI grid backend could not be reached; try again" {
		t.Fatalf("got %d %s %q, want 502 unavailable", rec.Code, code, msg)
	}
}

// writeCA writes the test server's certificate as a CA file.
func writeCA(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ca.crt")
	block := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(path, block, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// otherCA writes a self-signed CA that signed nothing the tests serve. Every httptest TLS server
// shares one certificate, so another server's would be trusted.
func otherCA(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "other CA"},
		DNSNames:              []string{"example.com"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "other-ca.crt")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The relay reaches the backend under the gRPC client's rules (backend.Config.TLS): plaintext to
// loopback or with Insecure, TLS verified against BACKEND_CA_FILE (and BACKEND_SERVER_NAME)
// otherwise, and not at all in plaintext across the network.
func TestTLSSelection(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		cfg     backend.Config
		wantURL string
		wantErr string
	}{
		{"loopback IPv4", backend.Config{Address: "127.0.0.1:9090"}, "http://127.0.0.1:9090", ""},
		{"localhost", backend.Config{Address: "localhost:9090"}, "http://localhost:9090", ""},
		{"loopback IPv6", backend.Config{Address: "[::1]:9090"}, "http://[::1]:9090", ""},
		{"network, no CA", backend.Config{Address: "ai-grid-backend.ai-grid.svc:8080"}, "", "not loopback"},
		{"network, insecure", backend.Config{Address: "ai-grid-backend.ai-grid.svc:8080", Insecure: true}, "http://ai-grid-backend.ai-grid.svc:8080", ""},
		{"missing CA file", backend.Config{Address: "127.0.0.1:9090", CAFile: "/nonexistent/ca.crt"}, "", "backend CA"},
		{"empty address", backend.Config{}, "", "must not be empty"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := relay.New(relay.Config{Backend: tc.cfg})
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want one with %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if r.URL() != tc.wantURL {
				t.Fatalf("URL %s, want %s", r.URL(), tc.wantURL)
			}
		})
	}

	notPEM := filepath.Join(t.TempDir(), "not.pem")
	if err := os.WriteFile(notPEM, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := relay.New(relay.Config{Backend: backend.Config{Address: "127.0.0.1:9090", CAFile: notPEM}}); err == nil || !strings.Contains(err.Error(), "no PEM certificate") {
		t.Fatalf("a CA file without a certificate: err = %v", err)
	}

	got := &seen{}
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.record(r)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer tlsSrv.Close()
	u, _ := url.Parse(tlsSrv.URL)
	ca := writeCA(t, tlsSrv)

	// The CA file selects https and verifies the backend's certificate; httptest's names example.com.
	r := newRelay(t, backend.Config{Address: u.Host, CAFile: ca, ServerName: "example.com"})
	if !strings.HasPrefix(r.URL(), "https://") {
		t.Fatalf("URL %s, want https", r.URL())
	}
	if rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), nil)); rec.Code != http.StatusOK {
		t.Fatalf("TLS with the right CA and name: got %d %q", rec.Code, rec.Body)
	}
	if req, _ := got.last(t); req.TLS == nil || req.Header.Get("Authorization") != "Bearer sha256~caller" {
		t.Fatalf("backend got TLS %v, Authorization %q", req.TLS != nil, req.Header.Get("Authorization"))
	}

	// A certificate for another name, or one the CA file didn't sign, is not the backend.
	// (httptest's certificate names example.com and *.example.com.)
	for name, cfg := range map[string]backend.Config{
		"wrong server name": {Address: u.Host, CAFile: ca, ServerName: "backend.invalid"},
		"untrusted":         {Address: u.Host, CAFile: otherCA(t), ServerName: "example.com"},
	} {
		before := got.count()
		rec := serve(newRelay(t, cfg), asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), nil))
		if rec.Code != http.StatusBadGateway || got.count() != before {
			t.Errorf("%s: got %d (backend reached: %v), want 502 before any request", name, rec.Code, got.count() != before)
		}
	}
}

// The BFF's own refusals on the relay's paths are Connect errors the browser's client can read.
func TestWriteError(t *testing.T) {
	t.Parallel()
	for status, want := range map[int]string{
		http.StatusUnauthorized:        "unauthenticated",
		http.StatusForbidden:           "permission_denied",
		http.StatusBadGateway:          "unavailable",
		http.StatusInternalServerError: "internal",
		http.StatusTeapot:              "unknown",
	} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			rec := httptest.NewRecorder()
			relay.WriteError(rec, status, "why")
			if code, msg := connectError(t, rec); rec.Code != status || code != want || msg != "why" {
				t.Errorf("got %d %s %q, want %d %s %q", rec.Code, code, msg, status, want, "why")
			}
			if cc, nosniff := rec.Header().Get("Cache-Control"), rec.Header().Get("X-Content-Type-Options"); cc != "no-store" || nosniff != "nosniff" {
				t.Errorf("Cache-Control %q, X-Content-Type-Options %q; want no-store and nosniff", cc, nosniff)
			}
		})
	}
	for path, want := range map[string]bool{"/ai_grid.v1.Clusters/List": true, "/api/v1/clusters": false, "/ai_grid.draft.v1.Models/List": false} {
		if got := relay.Handles(path); got != want {
			t.Errorf("Handles(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestUnreviewedProceduresStayBehindTheBoundary(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)
	for _, path := range []string{
		"/ai_grid.v1.Tenants/ListMembers",
		"/ai_grid.v1.Clusters/Create",
		"/ai_grid.v1.Clusters/Delete",
		"/ai_grid.v1.Clusters/NewMethod",
		"/ai_grid.v1.NewService/List",
	} {
		t.Run(path, func(t *testing.T) {
			rec := serve(r, asCaller(t, http.MethodPost, path, strings.NewReader(`{}`), nil))
			if code, _ := connectError(t, rec); rec.Code != http.StatusNotFound || code != "unimplemented" {
				t.Fatalf("got %d %q", rec.Code, rec.Body)
			}
		})
	}
	if got.count() != 0 {
		t.Fatal("an unreviewed procedure reached the backend")
	}
}

func TestRefusesCompressedRequests(t *testing.T) {
	t.Parallel()
	srv, got := connectBackend(t)
	r := relayTo(t, srv)
	for _, tc := range []struct {
		name, method, path string
		headers            http.Header
	}{
		{"unary", http.MethodPost, list, http.Header{"Content-Encoding": {"gzip"}}},
		{"stream", http.MethodPost, list, http.Header{"Content-Type": {"application/connect+json"}, "Connect-Content-Encoding": {"gzip"}}},
		{"duplicate encoding", http.MethodPost, list, http.Header{"Content-Encoding": {"identity", "gzip"}}},
		{"get", http.MethodGet, list + "?compression=gzip&encoding=json&message=e30", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := serve(r, asCaller(t, tc.method, tc.path, strings.NewReader(`{}`), tc.headers))
			if code, _ := connectError(t, rec); rec.Code != http.StatusUnsupportedMediaType || code != "unimplemented" {
				t.Fatalf("got %d %q", rec.Code, rec.Body)
			}
		})
	}
	if got.count() != 0 {
		t.Fatal("a compressed request reached the backend")
	}
	rec := serve(r, asCaller(t, http.MethodPost, list, strings.NewReader(`{}`), http.Header{"Content-Encoding": {"identity"}}))
	if rec.Code != http.StatusOK {
		t.Fatalf("identity encoding: got %d %q", rec.Code, rec.Body)
	}
}
