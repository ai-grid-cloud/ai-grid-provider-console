package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
)

// right is what a SelfSubjectAccessReview asks about: a verb on an API resource (Group and
// Resource), or on a non-resource URL (Path).
type right struct {
	Group, Resource, Path, Verb string
}

// The rights the tests below give their callers, written out rather than taken from
// hub.ProviderAdminCheck, so that a change to the check fails here.
var (
	// patchManagedClusters is what ACM's open-cluster-management:hypershift-addon:agent
	// ClusterRoleBinding grants every authenticated user of a hub, so it can't tell a provider
	// admin from anyone else who can log in.
	patchManagedClusters = right{Group: "cluster.open-cluster-management.io", Resource: "managedclusters", Verb: "patch"}
	// clusterReaderGet is what OpenShift's cluster-reader grants on the console's path: its
	// `*` nonResourceURLs rule allows get on every path, so get can't tell a provider admin from
	// a cluster reader.
	clusterReaderGet = right{Path: "/ai-grid/provider-console", Verb: "get"}
	// postProviderConsole is the rule of the chart's ai-grid-provider-admin ClusterRole.
	postProviderConsole = right{Path: "/ai-grid/provider-console", Verb: "post"}
)

// rbacHub answers SelfSubjectAccessReviews the way the hub's RBAC does: a review asks about
// either a resource or a non-resource URL, never both (the API server refuses that), and is
// allowed when the bearer token's user holds exactly the right it asks about. It records the
// right of every review it got.
type rbacHub struct {
	t      *testing.T
	grants map[string][]right // by bearer token

	mu      sync.Mutex
	reviews []right
}

func (h *rbacHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Spec struct {
			ResourceAttributes    *struct{ Group, Resource, Verb string } `json:"resourceAttributes"`
			NonResourceAttributes *struct{ Path, Verb string }            `json:"nonResourceAttributes"`
		} `json:"spec"`
	}
	raw, err := io.ReadAll(r.Body)
	if err == nil {
		err = json.Unmarshal(raw, &body)
	}
	res, nonRes := body.Spec.ResourceAttributes, body.Spec.NonResourceAttributes
	if err == nil && (res == nil) == (nonRes == nil) {
		err = errors.New("exactly one of nonResourceAttributes or resourceAttributes must be specified")
	}
	if err != nil {
		h.t.Errorf("access review body %q: %v", raw, err)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var asked right
	if res != nil {
		asked = right{Group: res.Group, Resource: res.Resource, Verb: res.Verb}
	} else {
		asked = right{Path: nonRes.Path, Verb: nonRes.Verb}
	}
	h.mu.Lock()
	h.reviews = append(h.reviews, asked)
	h.mu.Unlock()
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	allowed := slices.Contains(h.grants[token], asked)
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"status": map[string]any{"allowed": allowed}})
}

func (h *rbacHub) got() []right {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.reviews)
}

// rbacApp is an App on h with the Connect and Perses relays on, and the upstreams' records.
func rbacApp(t *testing.T, h *rbacHub) (app *App, backend *backendtest.Fake, connect, perses *recorder) {
	t.Helper()
	backend = &backendtest.Fake{}
	connectRelay, connect := connectUpstream(t)
	persesRelay, perses := persesUpstream(t)
	app = NewApp(testConfig(t), slog.New(slog.DiscardHandler), backendtest.Start(t, backend), startHub(t, h)).
		WithRelay(connectRelay).WithPerses(persesRelay)
	return app, backend, connect, perses
}

// forwarded builds a request the way kube-auth-proxy forwards it for the caller with token. A
// browser signed in with the proxy's session cookie and a client that sends its token as a bearer
// reach the BFF the same way: the proxy puts the caller's token in x-forwarded-access-token, the
// one header the BFF reads it from. The bearer path through the proxy is covered end to end by
// hack/test-chart-kind.sh.
func forwarded(token, method, path string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set(config.DefaultAuthTokenHeader, token)
	req.Header.Set(config.DefaultAuthUserHeader, "someone")
	req.Header.Set(config.DefaultAuthGroupsHeader, "system:authenticated")
	return req
}

// Neither a user whom the hub lets patch ManagedClusters, as ACM lets every authenticated user,
// nor a cluster reader, whom OpenShift lets get every non-resource URL, is a provider admin: the
// console asks for its own right, post on the non-resource URL /ai-grid/provider-console, which
// the ai-grid-provider-admin ClusterRole grants. Without it, the API, the Connect relay and the
// Perses relay all refuse, and /user says so.
func TestProviderAdminIsTheConsolesOwnRight(t *testing.T) {
	t.Parallel()
	const (
		viewer = "sha256~viewer"
		reader = "sha256~reader"
		admin  = "sha256~admin"
	)
	h := &rbacHub{t: t, grants: map[string][]right{
		viewer: {patchManagedClusters},
		reader: {clusterReaderGet},
		admin:  {postProviderConsole},
	}}
	app, backend, connect, perses := rbacApp(t, h)

	for _, caller := range []struct{ name, token string }{
		{"a user who may patch ManagedClusters", viewer},
		{"a cluster reader", reader},
	} {
		var u User
		rec := serve(app, forwarded(caller.token, http.MethodGet, "/api/v1/user"))
		decodeData(t, rec, &u)
		if rec.Code != http.StatusOK || u.IsProviderAdmin {
			t.Errorf("GET /api/v1/user for %s: %d %+v, want isProviderAdmin false", caller.name, rec.Code, u)
		}
		rec = serve(app, forwarded(caller.token, http.MethodGet, "/api/v1/nope"))
		if rec.Code != http.StatusForbidden {
			t.Errorf("/api/v1 for %s: got %d %s, want 403", caller.name, rec.Code, rec.Body)
		}
		rec = serve(app, connectCall(forwarded(caller.token, http.MethodPost, connectList)))
		if code, _ := decodeConnectError(t, rec); rec.Code != http.StatusForbidden || code != "permission_denied" {
			t.Errorf("Connect relay for %s: got %d %s, want 403 permission_denied", caller.name, rec.Code, rec.Body)
		}
		rec = serve(app, forwarded(caller.token, http.MethodGet, persesDashboards))
		if rec.Code != http.StatusForbidden {
			t.Errorf("Perses relay for %s: got %d %s, want 403", caller.name, rec.Code, rec.Body)
		}
	}

	var u User
	rec := serve(app, forwarded(admin, http.MethodGet, "/api/v1/user"))
	decodeData(t, rec, &u)
	if rec.Code != http.StatusOK || !u.IsProviderAdmin {
		t.Errorf("GET /api/v1/user for a provider admin: %d %+v, want isProviderAdmin true", rec.Code, u)
	}
	if rec = serve(app, forwarded(admin, http.MethodGet, "/api/v1/nope")); rec.Code != http.StatusNotFound {
		t.Errorf("/api/v1 for a provider admin: got %d %s, want the API's own 404", rec.Code, rec.Body)
	}
	if rec = serve(app, connectCall(forwarded(admin, http.MethodPost, connectList))); rec.Code != http.StatusOK {
		t.Errorf("Connect relay for a provider admin: got %d %s, want 200", rec.Code, rec.Body)
	}
	if rec = serve(app, forwarded(admin, http.MethodGet, persesDashboards)); rec.Code != http.StatusOK {
		t.Errorf("Perses relay for a provider admin: got %d %s, want 200", rec.Code, rec.Body)
	}

	if calls := backend.Calls(); len(calls) != 0 {
		t.Errorf("the backend was called: %v", calls)
	}
	if n := len(connect.values()); n != 1 {
		t.Errorf("the Connect relay passed %d calls, want the provider admin's 1", n)
	}
	if n := len(perses.values()); n != 1 {
		t.Errorf("the Perses relay passed %d calls, want the provider admin's 1", n)
	}
	reviews := h.got()
	if len(reviews) == 0 {
		t.Fatal("no access review reached the hub")
	}
	for _, asked := range reviews {
		if asked != postProviderConsole {
			t.Errorf("the hub was asked about %+v, want only %+v", asked, postProviderConsole)
		}
	}
}
