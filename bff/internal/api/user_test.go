package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube/kubetest"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/users"
)

func authed(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req.Header.Set(config.DefaultAuthTokenHeader, "sha256~token")
	return req
}

func decodeData(t *testing.T, rec *httptest.ResponseRecorder, into any) {
	t.Helper()
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope %q: %v", rec.Body.String(), err)
	}
	if err := json.Unmarshal(env.Data, into); err != nil {
		t.Fatalf("decode data %q: %v", string(env.Data), err)
	}
}

func TestGetUser(t *testing.T) {
	f := kubetest.NewFactory(runtime.NewScheme(), map[schema.GroupVersionResource]string{})
	kubetest.ReactForIdentity(f.Kube, "juntwang", []string{"cluster-admins"}, true)
	app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), f)

	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, authed(http.MethodGet, "/api/v1/user"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var u users.User
	decodeData(t, rec, &u)
	if u.Username != "juntwang" || !u.IsProviderAdmin {
		t.Fatalf("user = %+v", u)
	}
	if f.Calls != 1 {
		t.Fatalf("client factory called %d times", f.Calls)
	}
}

func TestGetUserClientFailure(t *testing.T) {
	f := kubetest.NewFactory(runtime.NewScheme(), map[schema.GroupVersionResource]string{})
	f.Err = errors.New("kubeconfig missing")
	app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), f)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, authed(http.MethodGet, "/api/v1/user"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestGetConfig(t *testing.T) {
	cfg := testConfig(t)
	cfg.GridEndpoint = "https://ai.example.com"
	cfg.HubNamespace = "hub"
	app := newTestApp(t, cfg)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, authed(http.MethodGet, "/api/v1/config"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var c ConsoleConfig
	decodeData(t, rec, &c)
	if c.GridEndpoint != "https://ai.example.com" || c.HubNamespace != "hub" || c.Version != Version {
		t.Fatalf("config = %+v", c)
	}
}
