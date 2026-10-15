package users

import (
	"context"
	"errors"
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	kubefake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube/kubetest"
)

func newClient(t *testing.T) (*kube.Client, *kubefake.Clientset) {
	t.Helper()
	f := kubetest.NewFactory(runtime.NewScheme(), map[schema.GroupVersionResource]string{})
	return &kube.Client{Kube: f.Kube, Dynamic: f.Dynamic}, f.Kube
}

func TestCurrentAdmin(t *testing.T) {
	c, cs := newClient(t)
	kubetest.ReactForIdentity(cs, "juntwang", []string{"cluster-admins", "system:authenticated"}, true)
	u, err := Current(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "juntwang" || !u.IsProviderAdmin || len(u.Groups) != 2 {
		t.Fatalf("user = %+v", u)
	}
}

func TestCurrentReadOnlyUser(t *testing.T) {
	c, cs := newClient(t)
	kubetest.ReactForIdentity(cs, "viewer", nil, false)
	u, err := Current(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if u.IsProviderAdmin {
		t.Fatal("viewer should not be provider admin")
	}
	if u.Groups == nil {
		t.Fatal("groups should serialize as an empty list, not null")
	}
}

func TestCurrentServiceAccount(t *testing.T) {
	c, cs := newClient(t)
	kubetest.ReactForIdentity(cs, "system:serviceaccount:ai-grid:console", nil, true)
	u, err := Current(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "ai-grid/console" {
		t.Fatalf("username = %q", u.Username)
	}
}

func TestCurrentPropagatesErrors(t *testing.T) {
	c, cs := newClient(t)
	cs.PrependReactor("create", "selfsubjectreviews", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("boom")
	})
	if _, err := Current(context.Background(), c); err == nil {
		t.Fatal("expected error")
	}
}
