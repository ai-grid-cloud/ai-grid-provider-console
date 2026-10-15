// Package kubetest provides fakes for handler and repository tests.
package kubetest

import (
	"context"
	"errors"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube"
)

// Factory returns the same fake clients for every request. Err, when set, is
// returned instead.
type Factory struct {
	Kube    *kubefake.Clientset
	Dynamic *dynamicfake.FakeDynamicClient
	Err     error
	// Calls counts ClientFor invocations.
	Calls int
}

// NewFactory builds fake typed and dynamic clients seeded with objects. gvrToList
// registers list kinds for custom resources the dynamic fake has to serve.
func NewFactory(scheme *runtime.Scheme, gvrToList map[schema.GroupVersionResource]string, objects ...runtime.Object) *Factory {
	var typed, dyn []runtime.Object
	for _, o := range objects {
		if _, isUnstructured := o.(interface{ UnstructuredContent() map[string]interface{} }); isUnstructured {
			dyn = append(dyn, o)
		} else {
			typed = append(typed, o)
		}
	}
	return &Factory{
		Kube:    kubefake.NewClientset(typed...),
		Dynamic: dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList, dyn...),
	}
}

// ClientFor implements kube.ClientFactory.
func (f *Factory) ClientFor(ctx context.Context) (*kube.Client, error) {
	f.Calls++
	if f.Err != nil {
		return nil, f.Err
	}
	if _, ok := kube.IdentityFrom(ctx); !ok {
		return nil, errors.New("no caller identity on request context")
	}
	return &kube.Client{Kube: f.Kube, Dynamic: f.Dynamic}, nil
}
