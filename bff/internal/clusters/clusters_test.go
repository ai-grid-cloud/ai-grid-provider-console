package clusters

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube/kubetest"
)

// ListKinds registers the ManagedCluster list kind for the dynamic fake.
var ListKinds = map[schema.GroupVersionResource]string{ManagedClusterGVR: "ManagedClusterList"}

// LoadFixture reads a ManagedCluster captured from a real hub.
func LoadFixture(t *testing.T, path string) *unstructured.Unstructured {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	u := &unstructured.Unstructured{}
	if err := json.Unmarshal(raw, &u.Object); err != nil {
		t.Fatal(err)
	}
	return u
}

// NewManagedCluster builds a minimal ManagedCluster for tests.
func NewManagedCluster(name string, labels map[string]string, available string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion("cluster.open-cluster-management.io/v1")
	u.SetKind("ManagedCluster")
	u.SetName(name)
	u.SetLabels(labels)
	u.SetResourceVersion("1")
	if available != "" {
		_ = unstructured.SetNestedSlice(u.Object, []any{map[string]any{"type": conditionAvailable, "status": available}}, "status", "conditions")
	}
	return u
}

func newClient(t *testing.T, objs ...runtime.Object) *kube.Client {
	t.Helper()
	f := kubetest.NewFactory(runtime.NewScheme(), ListKinds, objs...)
	return &kube.Client{Kube: f.Kube, Dynamic: f.Dynamic}
}

func TestFromUnstructuredRealHub(t *testing.T) {
	gc := FromUnstructured(LoadFixture(t, "testdata/local-cluster.json"))
	if gc.Name != "local-cluster" || gc.Status != StatusReady {
		t.Fatalf("projection = %+v", gc)
	}
	if gc.AIGridEnabled || gc.Provisioned || gc.ProvisioningStatus != NotProvisioned || gc.Location != "" {
		t.Fatalf("fresh hub cluster should have no grid labels: %+v", gc)
	}
	if gc.ConsoleURL == "" || gc.OpenShiftVersion != "4.22.15" || gc.ResourceVersion == "" {
		t.Fatalf("claims/labels not projected: %+v", gc)
	}
}

func TestProvisioningStatus(t *testing.T) {
	cases := []struct {
		labels map[string]string
		want   string
	}{
		{nil, NotProvisioned},
		{map[string]string{LabelEnabled: "true"}, Provisioning},
		{map[string]string{LabelEnabled: "true", LabelProvisioned: "true"}, Provisioned},
		{map[string]string{LabelProvisioned: "true"}, Provisioned},
		{map[string]string{LabelEnabled: "false"}, NotProvisioned},
	}
	for _, tc := range cases {
		if got := FromUnstructured(NewManagedCluster("c", tc.labels, "True")).ProvisioningStatus; got != tc.want {
			t.Errorf("labels %v -> %q, want %q", tc.labels, got, tc.want)
		}
	}
}

func TestStatusFromCondition(t *testing.T) {
	if got := FromUnstructured(NewManagedCluster("c", nil, "False")).Status; got != StatusOffline {
		t.Errorf("False -> %q", got)
	}
	if got := FromUnstructured(NewManagedCluster("c", nil, "")).Status; got != StatusUnknown {
		t.Errorf("no condition -> %q", got)
	}
}

func TestListSortedAndEmpty(t *testing.T) {
	ctx := context.Background()
	c := newClient(t, NewManagedCluster("site-b", nil, "True"), NewManagedCluster("site-a", nil, "True"))
	got, err := List(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "site-a" || got[1].Name != "site-b" {
		t.Fatalf("list = %+v", got)
	}
	empty, err := List(ctx, newClient(t))
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty list = %v, err = %v (must be [] not null)", empty, err)
	}
}

func TestLocations(t *testing.T) {
	ready := map[string]string{LabelEnabled: "true", LabelProvisioned: "true", LabelLocation: "us-east"}
	c := newClient(t,
		NewManagedCluster("a", ready, "True"),
		NewManagedCluster("b", ready, "True"), // same location, deduplicated
		NewManagedCluster("c", map[string]string{LabelEnabled: "true", LabelProvisioned: "true", LabelLocation: "eu-west"}, "False"), // offline
		NewManagedCluster("d", map[string]string{LabelEnabled: "true", LabelLocation: "ap"}, "True"),                                 // not provisioned
		NewManagedCluster("e", map[string]string{LabelEnabled: "true", LabelProvisioned: "true"}, "True"),                            // no location
	)
	got, err := Locations(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "us-east" {
		t.Fatalf("locations = %v", got)
	}
}

func TestPatchEnrollAndLocation(t *testing.T) {
	ctx := context.Background()
	c := newClient(t, NewManagedCluster("site", nil, "True"))
	enabled := true
	loc := "us-east"
	gc, err := Patch(ctx, c, "site", Update{AIGridEnabled: &enabled, Location: &loc})
	if err != nil {
		t.Fatal(err)
	}
	if !gc.AIGridEnabled || gc.Location != "us-east" || gc.ProvisioningStatus != Provisioning {
		t.Fatalf("after patch = %+v", gc)
	}

	none := ""
	disabled := false
	gc, err = Patch(ctx, c, "site", Update{AIGridEnabled: &disabled, Location: &none})
	if err != nil {
		t.Fatal(err)
	}
	if gc.AIGridEnabled || gc.Location != "" {
		t.Fatalf("after withdraw = %+v", gc)
	}
	u, err := c.Dynamic.Resource(ManagedClusterGVR).Get(ctx, "site", metav1GetOptions())
	if err != nil {
		t.Fatal(err)
	}
	if _, has := u.GetLabels()[LabelLocation]; has {
		t.Fatal("empty location should remove the label")
	}
}

func TestPatchValidation(t *testing.T) {
	ctx := context.Background()
	c := newClient(t, NewManagedCluster("site", nil, "True"))
	if _, err := Patch(ctx, c, "site", Update{}); err == nil {
		t.Error("empty update should fail")
	}
	bad := "has space"
	if _, err := Patch(ctx, c, "site", Update{Location: &bad}); err == nil {
		t.Error("invalid label value should fail")
	}
	enabled := true
	if _, err := Patch(ctx, c, "Bad_Name", Update{AIGridEnabled: &enabled}); err == nil {
		t.Error("invalid name should fail")
	}
	if _, err := Get(ctx, c, "missing"); err == nil {
		t.Error("missing cluster should fail")
	}
}
