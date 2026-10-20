package relay_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/contract/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/contract/ai_grid/v1/ai_gridv1connect"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/relay"
)

// stubBackend stands in for ai-grid-provider-backend. It records the headers of the last
// call so a test can assert on what the relay forwarded, the way
// internal/backend/backendtest records incoming gRPC metadata.
type stubBackend struct {
	ai_gridv1connect.UnimplementedClustersHandler
	lastHeader http.Header
	err        error
}

func (s *stubBackend) List(_ context.Context, req *connect.Request[aigridv1.ClustersListRequest]) (*connect.Response[aigridv1.ClustersListResponse], error) {
	s.lastHeader = req.Header().Clone()
	if s.err != nil {
		return nil, s.err
	}
	return connect.NewResponse(&aigridv1.ClustersListResponse{
		Size:  1,
		Total: 1,
		Items: []*aigridv1.ManagedCluster{{Id: "site-paris-1"}},
	}), nil
}

// serve starts the stub on plaintext HTTP/2 and returns a relay pointed at it. Identity, when
// given, is injected into the request context the way the BFF's middleware does.
func serve(t *testing.T, stub *stubBackend, id *identity.Identity) ai_gridv1connect.ClustersClient {
	t.Helper()

	backendMux := http.NewServeMux()
	backendMux.Handle(ai_gridv1connect.NewClustersHandler(stub))
	backend := httptest.NewUnstartedServer(h2c.NewHandler(backendMux, &http2.Server{}))
	backend.EnableHTTP2 = true
	backend.Start()
	t.Cleanup(backend.Close)

	r := relay.New(backend.Listener.Addr().String(), nil)
	frontMux := http.NewServeMux()
	for path, handler := range r.Handlers() {
		frontMux.Handle(path, handler)
	}

	front := httptest.NewUnstartedServer(h2c.NewHandler(
		http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if id != nil {
				req = req.WithContext(identity.WithIdentity(req.Context(), *id))
			}
			frontMux.ServeHTTP(w, req)
		}), &http2.Server{}))
	front.EnableHTTP2 = true
	front.Start()
	t.Cleanup(front.Close)

	return ai_gridv1connect.NewClustersClient(front.Client(), front.URL)
}

func TestRelayForwardsIdentity(t *testing.T) {
	t.Parallel()

	// Built the way the BFF builds it, from the proxy's headers: the token is unexported,
	// so Extract is the only way in.
	id := mustIdentity(t, http.Header{
		"X-Forwarded-Access-Token": {"dev-token"},
		"X-Forwarded-User":         {"dev-user"},
		"X-Forwarded-Email":        {"dev@example.com"},
		"X-Forwarded-Groups":       {"admins,devs"},
	})

	stub := &stubBackend{}
	client := serve(t, stub, &id)

	if _, err := client.List(context.Background(), connect.NewRequest(&aigridv1.ClustersListRequest{})); err != nil {
		t.Fatalf("List() error = %v", err)
	}

	for header, want := range map[string]string{
		"Authorization":      "Bearer dev-token",
		"X-Forwarded-User":   "dev-user",
		"X-Forwarded-Email":  "dev@example.com",
		"X-Forwarded-Groups": "admins,devs",
	} {
		if got := stub.lastHeader.Get(header); got != want {
			t.Errorf("backend saw %s = %q, want %q", header, got, want)
		}
	}
}

func TestRelayWithoutIdentitySendsNone(t *testing.T) {
	t.Parallel()

	stub := &stubBackend{}
	client := serve(t, stub, nil)

	if _, err := client.List(context.Background(), connect.NewRequest(&aigridv1.ClustersListRequest{})); err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if got := stub.lastHeader.Get("Authorization"); got != "" {
		t.Errorf("backend saw Authorization = %q, want none", got)
	}
}

// The relay decides nothing: the backend's code and message reach the caller unchanged.
func TestRelayPassesTheBackendsError(t *testing.T) {
	t.Parallel()

	stub := &stubBackend{err: connect.NewError(connect.CodePermissionDenied, errForbidden{})}
	client := serve(t, stub, nil)

	_, err := client.List(context.Background(), connect.NewRequest(&aigridv1.ClustersListRequest{}))
	if err == nil {
		t.Fatal("List() error = nil, want PermissionDenied")
	}
	if got := connect.CodeOf(err); got != connect.CodePermissionDenied {
		t.Errorf("code = %v, want %v", got, connect.CodePermissionDenied)
	}
	if want := "cannot list managedclusters"; !strings.Contains(err.Error(), want) {
		t.Errorf("error = %q, want it to contain %q", err.Error(), want)
	}
}

type errForbidden struct{}

func (errForbidden) Error() string { return "cannot list managedclusters" }

func mustIdentity(t *testing.T, header http.Header) identity.Identity {
	t.Helper()
	id, err := identity.Headers{
		User:   "X-Forwarded-User",
		Email:  "X-Forwarded-Email",
		Groups: "X-Forwarded-Groups",
		Token:  "X-Forwarded-Access-Token",
	}.Extract(header)
	if err != nil {
		t.Fatalf("Extract() error = %v", err)
	}
	return id
}
