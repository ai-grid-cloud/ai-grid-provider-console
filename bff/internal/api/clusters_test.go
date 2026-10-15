package api

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/clusters"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube/kubetest"
)

func managedCluster(name string, labels map[string]string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion("cluster.open-cluster-management.io/v1")
	u.SetKind("ManagedCluster")
	u.SetName(name)
	u.SetLabels(labels)
	_ = unstructured.SetNestedSlice(u.Object, []any{map[string]any{"type": "ManagedClusterConditionAvailable", "status": "True"}}, "status", "conditions")
	return u
}

func clustersApp(t *testing.T, objs ...runtime.Object) http.Handler {
	t.Helper()
	f := kubetest.NewFactory(runtime.NewScheme(), map[schema.GroupVersionResource]string{clusters.ManagedClusterGVR: "ManagedClusterList"}, objs...)
	return NewApp(testConfig(t), slog.New(slog.DiscardHandler), f).Handler()
}

func TestClustersList(t *testing.T) {
	h := clustersApp(t, managedCluster("local-cluster", nil), managedCluster("site-1", map[string]string{clusters.LabelEnabled: "true", clusters.LabelProvisioned: "true", clusters.LabelLocation: "us-east"}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, authed(http.MethodGet, "/api/v1/clusters"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got []clusters.GridCluster
	decodeData(t, rec, &got)
	if len(got) != 2 || got[0].Name != "local-cluster" || got[1].Location != "us-east" {
		t.Fatalf("clusters = %+v", got)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, authed(http.MethodGet, "/api/v1/locations"))
	var locs []string
	decodeData(t, rec, &locs)
	if len(locs) != 1 || locs[0] != "us-east" {
		t.Fatalf("locations = %v", locs)
	}
}

func TestClusterGetNotFound(t *testing.T) {
	h := clustersApp(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, authed(http.MethodGet, "/api/v1/clusters/nope"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestClusterPatch(t *testing.T) {
	h := clustersApp(t, managedCluster("site-1", nil))
	patch := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/clusters/site-1", strings.NewReader(body))
		req.Header.Set(config.DefaultAuthTokenHeader, "sha256~token")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	rec := patch(`{"aiGridEnabled": true, "location": "us-east"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var gc clusters.GridCluster
	decodeData(t, rec, &gc)
	if !gc.AIGridEnabled || gc.Location != "us-east" || gc.ProvisioningStatus != clusters.Provisioning {
		t.Fatalf("cluster = %+v", gc)
	}

	for body, want := range map[string]int{
		``:                         http.StatusUnprocessableEntity,
		`{}`:                       http.StatusUnprocessableEntity,
		`{"unknown": 1}`:           http.StatusUnprocessableEntity,
		`{"location": "no good"}`:  http.StatusUnprocessableEntity,
		`{"aiGridEnabled": "yes"}`: http.StatusUnprocessableEntity,
	} {
		if rec := patch(body); rec.Code != want {
			t.Errorf("body %q -> %d, want %d (%s)", body, rec.Code, want, rec.Body.String())
		}
	}
}
