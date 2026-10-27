package api

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/perses"
)

// persesProject is the Perses project the test relays read, and persesDashboards its list.
const (
	persesProject    = "ai-grid-monitoring"
	persesDashboards = "/perses/api/api/v1/projects/" + persesProject + "/dashboards"
)

// persesUpstream stands in for the hub's Perses and records the Authorization it got.
func persesUpstream(t *testing.T) (*perses.Relay, *[]string) {
	t.Helper()
	var auth []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = append(auth, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	t.Cleanup(srv.Close)
	// A loopback http:// target, as for a port-forward in development.
	relay, err := perses.New(perses.Config{URL: srv.URL, Project: persesProject})
	if err != nil {
		t.Fatal(err)
	}
	return relay, &auth
}

func TestPersesRelayCarriesTheCallersToken(t *testing.T) {
	relay, auth := persesUpstream(t)
	app := newTestApp(t, testConfig(t), nil).WithPerses(relay)
	rec := serve(app, asUser(http.MethodGet, persesDashboards))
	if rec.Code != http.StatusOK || rec.Body.String() != `[]` {
		t.Fatalf("got %d %q, want Perses's answer", rec.Code, rec.Body)
	}
	if len(*auth) != 1 || (*auth)[0] != "Bearer sha256~token" {
		t.Fatalf("Perses got Authorization %q, want the caller's token from x-forwarded-access-token", *auth)
	}
}

// The relay sits behind the same checks as /api/v1: a caller without a token, and one the hub
// doesn't call a provider admin, never reach Perses.
func TestPersesRelayIsForProviderAdminsOnly(t *testing.T) {
	relay, auth := persesUpstream(t)

	app := newTestApp(t, testConfig(t), nil).WithPerses(relay)
	if rec := serve(app, httptest.NewRequest(http.MethodGet, persesDashboards, nil)); rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: got %d, want 401", rec.Code)
	}

	viewer := newTestAppWithHub(t, testConfig(t), nil, &fakeHub{allowed: false}).WithPerses(relay)
	rec := serve(viewer, asUser(http.MethodGet, persesDashboards))
	if rec.Code != http.StatusForbidden {
		t.Errorf("not a provider admin: got %d, want 403", rec.Code)
	}

	expired := newTestAppWithHub(t, testConfig(t), nil, &fakeHub{status: http.StatusUnauthorized}).WithPerses(relay)
	if rec := serve(expired, asUser(http.MethodGet, persesDashboards)); rec.Code != http.StatusUnauthorized {
		t.Errorf("token the hub rejects: got %d, want 401", rec.Code)
	}

	if len(*auth) != 0 {
		t.Fatalf("a refused caller reached Perses %d time(s)", len(*auth))
	}
}

func TestPersesRelayRefusesWrites(t *testing.T) {
	relay, auth := persesUpstream(t)
	app := newTestApp(t, testConfig(t), nil).WithPerses(relay)
	rec := serve(app, asUser(http.MethodDelete, persesDashboards+"/d"))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got %d, want 405", rec.Code)
	}
	if len(*auth) != 0 {
		t.Fatalf("a write reached Perses")
	}
}

func TestMonitoringOffWithoutPerses(t *testing.T) {
	app := newTestApp(t, testConfig(t), nil)
	rec := serve(app, asUser(http.MethodGet, persesDashboards))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", rec.Code)
	}
	if msg := decodeError(t, rec).Error.Message; msg != "monitoring is not configured on this console" {
		t.Errorf("message %q", msg)
	}
	var cfg ConsoleConfig
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/config")), &cfg)
	if cfg.Monitoring.Enabled {
		t.Errorf("config says monitoring is on without a Perses server")
	}
}

func TestConfigReportsMonitoring(t *testing.T) {
	relay, _ := persesUpstream(t)
	cfg := testConfig(t)
	cfg.PersesProject = persesProject
	app := newTestApp(t, cfg, nil).WithPerses(relay)
	var got ConsoleConfig
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/config")), &got)
	if !got.Monitoring.Enabled || got.Monitoring.PersesProject != persesProject {
		t.Errorf("monitoring = %+v, want enabled with project ai-grid-monitoring", got.Monitoring)
	}
}

// lockedBuffer is a log sink the server's handler goroutines and the test can share.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Perses stalls after the first bytes of an answer: under a real server the relay cuts the
// connection at its timeout. The browser gets no answer (the bytes were still in the server's
// buffer) or a truncated one, never a 500 written over it, and the request is still logged.
func TestPersesAnswerCutAtTheTimeout(t *testing.T) {
	stall := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"partial":`))
		w.(http.Flusher).Flush()
		<-stall
	}))
	defer upstream.Close()
	defer close(stall)
	relay, err := perses.New(perses.Config{URL: upstream.URL, Project: persesProject, Timeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	app := NewApp(testConfig(t), slog.New(slog.NewTextHandler(logs, nil)), backendtest.Start(t, &backendtest.Fake{}), startHub(t, &fakeHub{allowed: true})).WithPerses(relay)
	srv := httptest.NewServer(app.Handler())

	in := asUser(http.MethodGet, persesDashboards)
	// Far past the relay's timeout: if the relay stops cutting the exchange, fail rather than hang.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+in.URL.Path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = in.Header.Clone()
	resp, err := srv.Client().Do(req)
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("the relay did not cut a stalled answer at its timeout")
	}
	if err == nil {
		body, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		// At most the bytes Perses sent before it stalled.
		if errors.Is(readErr, context.DeadlineExceeded) {
			t.Fatal("the relay did not cut a stalled answer at its timeout")
		}
		if sent := `{"partial":`; resp.StatusCode != http.StatusOK || len(body) > len(sent) || string(body) != sent[:len(body)] || readErr == nil {
			t.Fatalf("got %d %q (read error %v), want a cut connection", resp.StatusCode, body, readErr)
		}
	}
	srv.Close() // waits for the handler, so its log line is written
	if out := logs.String(); !strings.Contains(out, `msg="request aborted"`) || strings.Contains(out, "panic serving request") {
		t.Fatalf("log should hold the aborted request and no panic:\n%s", out)
	}
}
