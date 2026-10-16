package fakebackend

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const (
	cTrue    = aigridv1.ConditionStatus_CONDITION_STATUS_TRUE
	cFalse   = aigridv1.ConditionStatus_CONDITION_STATUS_FALSE
	cUnknown = aigridv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED
)

func cond(typ string, st aigridv1.ConditionStatus, reason, message string) *aigridv1.Condition {
	return &aigridv1.Condition{Type: typ, Status: st, Reason: proto.String(reason), Message: proto.String(message), LastTransitionTime: timestamppb.New(time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC))}
}

// withConditions clones the conditions so the package-level templates below
// are never aliased into a server's store.
func withConditions(conds ...*aigridv1.Condition) *aigridv1.ManagedCluster {
	owned := make([]*aigridv1.Condition, 0, len(conds))
	for _, cd := range conds {
		owned = append(owned, proto.Clone(cd).(*aigridv1.Condition))
	}
	return &aigridv1.ManagedCluster{Name: "c", HubAcceptsClient: true, Status: &aigridv1.ManagedClusterStatus{Conditions: owned}}
}

var (
	accepted    = cond(CondHubAccepted, cTrue, ReasonHubAccepted, MessageHubAccepted)
	joined      = cond(CondJoined, cTrue, ReasonJoined, MessageJoined)
	clockSynced = cond(CondClockSynced, cTrue, ReasonClockSynced, MessageClockSynced)
	imported    = cond(CondImportSucceeded, cTrue, ReasonImported, MessageImported)
	available   = cond(CondAvailable, cTrue, ReasonAvailable, MessageAvailable)
)

// TestDeriveState walks the ACM console's derivation with the exact condition
// inputs for each of the eight states (plus "no conditions").
func TestDeriveState(t *testing.T) {
	detaching := withConditions(cond(CondImportSucceeded, cFalse, ReasonDetaching, MessageDetaching), accepted, joined, available, clockSynced)
	detaching.DeletionTimestamp = timestamppb.Now()
	denied := withConditions(cond(CondHubAccepted, cFalse, ReasonHubDenied, MessageHubDenied), joined, available)
	denied.HubAcceptsClient = false
	apiDown := "The kube-apiserver is not ok, status code: 503, the server is currently unable to handle the request"

	cases := []struct {
		name    string
		c       *aigridv1.ManagedCluster
		want    aigridv1.ManagedClusterState
		message string
	}{
		{"detaching wins over everything", detaching, aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING, MessageDetaching},
		{"no conditions", withConditions(), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNSPECIFIED, ""},
		{"denied by hub admin", denied, aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED, MessageHubDenied},
		{"accepted condition absent", withConditions(joined, available), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED, ""},
		{"accepted, import not started", withConditions(accepted, cond(CondImportSucceeded, cFalse, ReasonWaitForImporting, MessageWaitForImporting)), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT, MessageWaitForImporting},
		{"accepted, nothing else", withConditions(accepted), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT, ""},
		{"importing", withConditions(accepted, cond(CondImportSucceeded, cFalse, ReasonImporting, MessageImportApplied)), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING, MessageImportApplied},
		{"import failed", withConditions(accepted, cond(CondImportSucceeded, cFalse, ReasonImportFailed, "Try to import managed cluster, error: timeout")), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORT_FAILED, "Try to import managed cluster, error: timeout"},
		{"ready", withConditions(imported, accepted, joined, available, clockSynced), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE, MessageAvailable},
		{"joined but import not finished is still ready", withConditions(cond(CondImportSucceeded, cFalse, ReasonImporting, MessageImportApplied), accepted, joined, available), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE, MessageAvailable},
		{"offline", withConditions(imported, accepted, joined, cond(CondAvailable, cFalse, ReasonAPIServerUnavail, apiDown)), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE, apiDown},
		{"unknown, lease expired", withConditions(imported, accepted, joined, cond(CondAvailable, cUnknown, ReasonLeaseStopped, MessageLeaseStopped)), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN, MessageLeaseStopped},
		{"unknown, available condition missing", withConditions(imported, accepted, joined), aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, msg := deriveState(tc.c)
			if got != tc.want || msg != tc.message {
				t.Errorf("deriveState = %s %q, want %s %q", got, msg, tc.want, tc.message)
			}
		})
	}
}

func TestReadsRecomputeStateFromConditions(t *testing.T) {
	// A fixture that claims to be AVAILABLE while its conditions say offline.
	c := withConditions(imported, accepted, joined, cond(CondAvailable, cFalse, ReasonAPIServerUnavail, "The kube-apiserver is not ok, status code: 500, x"))
	c.Status.State = aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE
	c.Status.StateMessage = "lies"
	s, err := New(&Fixtures{Clusters: []*aigridv1.ManagedCluster{c}}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetManagedCluster(authed(context.Background()), &aigridv1.GetManagedClusterRequest{Name: "c"})
	if err != nil {
		t.Fatal(err)
	}
	if got.GetObject().GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE || !strings.HasPrefix(got.GetObject().GetStatus().GetStateMessage(), "The kube-apiserver is not ok") {
		t.Errorf("state must be recomputed on read, got %v", got.GetObject().GetStatus())
	}
}

// newServer builds a server whose hub RBAC allows writes, as Load defaults
// access.json; tests about denial pass their own Access to New.
func newServer(t *testing.T, fx *Fixtures) *Server {
	t.Helper()
	if len(fx.Access.DeniedTokens) == 0 && len(fx.Access.RejectedTokens) == 0 {
		fx.Access.DefaultAllowed = true
	}
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func readyCluster(name string) *aigridv1.ManagedCluster {
	c := withConditions(imported, accepted, joined, available, clockSynced)
	c.Name = name
	c.Labels = map[string]string{LabelName: name, LabelCloud: "BareMetal", LabelVendor: "OpenShift", LabelAddonPrefix + "work-manager": AddonAvailable}
	c.Annotations = map[string]string{"open-cluster-management/created-via": "other"}
	c.ResourceVersion = "100"
	return c
}

func TestRequiresAuthorizationExceptPing(t *testing.T) {
	s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}})
	anon := context.Background()
	if _, err := s.Ping(anon, &aigridv1.PingRequest{Name: "probe"}); err != nil {
		t.Errorf("Ping is anonymous, got %v", err)
	}
	if _, err := s.ListManagedClusters(anon, &aigridv1.ListManagedClustersRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Errorf("List without authorization = %v, want Unauthenticated", err)
	}
	if _, err := s.GetManagedCluster(anon, &aigridv1.GetManagedClusterRequest{Name: "a"}); status.Code(err) != codes.Unauthenticated {
		t.Errorf("Get without authorization = %v, want Unauthenticated", err)
	}
	if _, err := s.ListTenants(anon, &aigridv1.ListTenantsRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Errorf("ListTenants without authorization = %v, want Unauthenticated", err)
	}
	// x-forwarded-user alone grants nothing (advisory header).
	onlyUser := metadata.NewIncomingContext(anon, metadata.Pairs("x-forwarded-user", "alice"))
	if _, err := s.ListManagedClusters(onlyUser, &aigridv1.ListManagedClustersRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Errorf("x-forwarded-user alone = %v, want Unauthenticated", err)
	}
	notBearer := metadata.NewIncomingContext(anon, metadata.Pairs("authorization", "Basic abc"))
	if _, err := s.ListManagedClusters(notBearer, &aigridv1.ListManagedClustersRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Errorf("non-bearer authorization = %v, want Unauthenticated", err)
	}
	upd := &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"labels"}}}
	if _, err := s.UpdateManagedCluster(anon, upd); status.Code(err) != codes.Unauthenticated {
		t.Errorf("Update without authorization = %v, want Unauthenticated", err)
	}
}

// TestUpdateHonoursHubRBAC: the fake answers a mutating RPC the way the hub
// answers the BFF's access review for the same token (access.json), so a
// viewer cannot enrol a cluster and an expired token is Unauthenticated.
func TestUpdateHonoursHubRBAC(t *testing.T) {
	access := Access{DefaultAllowed: true, DeniedTokens: []string{"viewer-token"}, RejectedTokens: []string{"expired-token"}}
	s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}, Access: access})
	as := func(token, user string) context.Context {
		return metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "Bearer "+token, "x-forwarded-user", user))
	}
	upd := func() *aigridv1.UpdateManagedClusterRequest {
		return &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a", Labels: map[string]string{"ai-grid/enabled": "true"}}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"labels"}}}
	}
	_, err := s.UpdateManagedCluster(as("viewer-token", "viewer"), upd())
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("viewer update = %v, want PermissionDenied", err)
	}
	want := `managedclusters.cluster.open-cluster-management.io "a" is forbidden: User "viewer" cannot patch resource "managedclusters" in API group "cluster.open-cluster-management.io" at the cluster scope`
	if got := status.Convert(err).Message(); got != want {
		t.Errorf("message = %q, want %q", got, want)
	}
	if _, err := s.UpdateManagedCluster(as("expired-token", "ghost"), upd()); status.Code(err) != codes.Unauthenticated {
		t.Errorf("rejected token = %v, want Unauthenticated", err)
	}
	// Reads are not gated by patch RBAC and the store is untouched.
	got, err := s.GetManagedCluster(as("viewer-token", "viewer"), &aigridv1.GetManagedClusterRequest{Name: "a"})
	if err != nil || got.GetObject().GetLabels()["ai-grid/enabled"] != "" {
		t.Errorf("viewer read = %v, %v", got, err)
	}
	if _, err := s.ListManagedClusters(as("viewer-token", "viewer"), &aigridv1.ListManagedClustersRequest{}); err != nil {
		t.Errorf("viewer list = %v", err)
	}
	// A rejected token is an expired session: the hub answers 401 to every call, reads included.
	for name, call := range map[string]func(context.Context) error{
		"List": func(ctx context.Context) error {
			_, err := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{})
			return err
		},
		"Get": func(ctx context.Context) error {
			_, err := s.GetManagedCluster(ctx, &aigridv1.GetManagedClusterRequest{Name: "a"})
			return err
		},
		"ListTenants": func(ctx context.Context) error {
			_, err := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{})
			return err
		},
	} {
		if err := call(as("expired-token", "ghost")); status.Code(err) != codes.Unauthenticated {
			t.Errorf("%s with a rejected token = %v, want Unauthenticated", name, err)
		}
	}
	if resp, err := s.UpdateManagedCluster(as("dev-token", "dev-user"), upd()); err != nil || resp.GetObject().GetLabels()["ai-grid/enabled"] != "true" {
		t.Errorf("admin update = %v, %v", resp, err)
	}
	denyAll, err := New(&Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}, Access: Access{DefaultAllowed: false}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := denyAll.UpdateManagedCluster(as("dev-token", "dev-user"), upd()); status.Code(err) != codes.PermissionDenied {
		t.Errorf("defaultAllowed=false = %v, want PermissionDenied", err)
	}
}

func TestSetConditionKeepsTransitionTimeWhenStatusUnchanged(t *testing.T) {
	c := readyCluster("a")
	first := findCondition(c, CondAvailable).GetLastTransitionTime().AsTime()
	later := first.Add(time.Hour)
	setCondition(c, later, CondAvailable, cTrue, ReasonAvailable, MessageAvailable)
	if got := findCondition(c, CondAvailable).GetLastTransitionTime().AsTime(); !got.Equal(first) {
		t.Errorf("same status: lastTransitionTime moved to %v", got)
	}
	setCondition(c, later, CondAvailable, cFalse, ReasonAPIServerUnavail, "The kube-apiserver is not ok, status code: 503, x")
	if got := findCondition(c, CondAvailable).GetLastTransitionTime().AsTime(); !got.Equal(later) {
		t.Errorf("status change: lastTransitionTime = %v, want %v", got, later)
	}
	if findCondition(c, CondAvailable).GetObservedGeneration() != 0 {
		t.Error("the hub does not write observedGeneration on ManagedCluster conditions")
	}
}

func TestConcurrentLockedUpdatesAdmitOne(t *testing.T) {
	s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}})
	ctx := authed(context.Background())
	const n = 8
	var wg sync.WaitGroup
	results := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, results[i] = s.UpdateManagedCluster(ctx, &aigridv1.UpdateManagedClusterRequest{
				Object:     &aigridv1.ManagedCluster{Name: "a", ResourceVersion: "100", Labels: map[string]string{"writer": strconv.Itoa(i)}},
				UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"labels"}},
				Lock:       true,
			})
		}()
	}
	wg.Wait()
	ok, aborted := 0, 0
	for _, err := range results {
		switch status.Code(err) {
		case codes.OK:
			ok++
		case codes.Aborted:
			aborted++
		default:
			t.Errorf("unexpected %v", err)
		}
	}
	if ok != 1 || aborted != n-1 {
		t.Errorf("ok=%d aborted=%d, want 1 and %d", ok, aborted, n-1)
	}
}

func TestUpdateDetachingClusterKeepsState(t *testing.T) {
	c := readyCluster("a")
	c.DeletionTimestamp = timestamppb.New(time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC))
	setCondition(c, time.Now(), CondImportSucceeded, cFalse, ReasonDetaching, MessageDetaching)
	s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{c}})
	resp, err := s.UpdateManagedCluster(authed(context.Background()), &aigridv1.UpdateManagedClusterRequest{
		Object: &aigridv1.ManagedCluster{Name: "a", Labels: map[string]string{"ai-grid/enabled": "true"}}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"labels"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetObject(); got.GetLabels()["ai-grid/enabled"] != "true" || got.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING || got.GetDeletionTimestamp() == nil {
		t.Errorf("labels still change on a terminating object and it stays DETACHING: %v", got)
	}
}

func TestGetManagedClusterNotFound(t *testing.T) {
	s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}})
	_, err := s.GetManagedCluster(authed(context.Background()), &aigridv1.GetManagedClusterRequest{Name: "nope"})
	if status.Code(err) != codes.NotFound || status.Convert(err).Message() != "object with identifier 'nope' not found" {
		t.Errorf("Get missing = %v", err)
	}
}

func TestListPaging(t *testing.T) {
	s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("c"), readyCluster("a"), readyCluster("b")}})
	ctx := authed(context.Background())
	resp, err := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{Offset: proto.Int32(1), Limit: proto.Int32(1)})
	if err != nil || len(resp.GetClusters()) != 1 || resp.GetClusters()[0].GetName() != "b" || resp.GetSize() != 1 || resp.GetTotal() != 3 {
		t.Fatalf("page = %v, %v", resp, err)
	}
	if resp, err := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{Limit: proto.Int32(0)}); err != nil || len(resp.GetClusters()) != 0 || resp.GetTotal() != 3 {
		t.Errorf("limit 0 counts only: %v, %v", resp, err)
	}
	if _, err := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{Limit: proto.Int32(-1)}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("negative limit = %v, want InvalidArgument", err)
	}
	if _, err := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{Filter: proto.String(`this.name == "a"`)}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("filter = %v, want InvalidArgument until implemented", err)
	}
}

func TestUpdateManagedCluster(t *testing.T) {
	ctx := authed(context.Background())
	update := func(s *Server, req *aigridv1.UpdateManagedClusterRequest) (*aigridv1.ManagedCluster, error) {
		resp, err := s.UpdateManagedCluster(ctx, req)
		return resp.GetObject(), err
	}
	mask := func(paths ...string) *fieldmaskpb.FieldMask { return &fieldmaskpb.FieldMask{Paths: paths} }

	t.Run("mask validation", func(t *testing.T) {
		s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}})
		_, err := update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a"}})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("empty mask = %v", err)
		}
		_, err = update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a"}, UpdateMask: mask("labels", "status.conditions")})
		if status.Code(err) != codes.InvalidArgument || !strings.Contains(status.Convert(err).Message(), `"status.conditions"`) {
			t.Errorf("bad path must be InvalidArgument naming the path, got %v", err)
		}
		_, err = update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a"}, UpdateMask: mask("labels.ai-grid/enabled")})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("per-key map path = %v, want InvalidArgument", err)
		}
		_, err = update(s, &aigridv1.UpdateManagedClusterRequest{UpdateMask: mask("labels")})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("missing name = %v", err)
		}
		_, err = update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "zz"}, UpdateMask: mask("labels")})
		if status.Code(err) != codes.NotFound {
			t.Errorf("unknown cluster = %v", err)
		}
	})

	t.Run("whole-map replacement and version bump", func(t *testing.T) {
		s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}})
		got, err := update(s, &aigridv1.UpdateManagedClusterRequest{
			Object:     &aigridv1.ManagedCluster{Name: "a", Labels: map[string]string{"ai-grid/enabled": "true"}},
			UpdateMask: mask("labels"),
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(got.GetLabels()) != 1 || got.GetLabels()["ai-grid/enabled"] != "true" {
			t.Errorf("labels must be replaced as a whole, got %v", got.GetLabels())
		}
		if got.GetAnnotations()["open-cluster-management/created-via"] != "other" {
			t.Errorf("annotations were not in the mask and must be untouched, got %v", got.GetAnnotations())
		}
		if got.GetResourceVersion() == "100" || got.GetResourceVersion() == "" {
			t.Errorf("resource version must change on write, got %q", got.GetResourceVersion())
		}
		if got.GetGeneration() != 0 {
			t.Errorf("metadata changes do not bump generation, got %d", got.GetGeneration())
		}
		if got.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE {
			t.Errorf("response carries the derived state, got %s", got.GetStatus().GetState())
		}
		got2, err := update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a", Annotations: map[string]string{}}, UpdateMask: mask("annotations")})
		if err != nil || len(got2.GetAnnotations()) != 0 || len(got2.GetLabels()) != 1 {
			t.Errorf("empty annotations map clears them and leaves labels: %v, %v", got2, err)
		}
	})

	t.Run("lock compares resource_version", func(t *testing.T) {
		s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}})
		_, err := update(s, &aigridv1.UpdateManagedClusterRequest{
			Object: &aigridv1.ManagedCluster{Name: "a", ResourceVersion: "99", Labels: map[string]string{}}, UpdateMask: mask("labels"), Lock: true,
		})
		if status.Code(err) != codes.Aborted {
			t.Fatalf("stale version = %v, want Aborted", err)
		}
		got, err := update(s, &aigridv1.UpdateManagedClusterRequest{
			Object: &aigridv1.ManagedCluster{Name: "a", ResourceVersion: "100", Labels: map[string]string{"x": "y"}}, UpdateMask: mask("labels"), Lock: true,
		})
		if err != nil || got.GetLabels()["x"] != "y" {
			t.Fatalf("matching version = %v, %v", got, err)
		}
		_, err = update(s, &aigridv1.UpdateManagedClusterRequest{
			Object: &aigridv1.ManagedCluster{Name: "a", ResourceVersion: "100", Labels: map[string]string{}}, UpdateMask: mask("labels"), Lock: true,
		})
		if status.Code(err) != codes.Aborted {
			t.Errorf("the version used once is stale afterwards, got %v", err)
		}
		if _, err := update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a", ResourceVersion: "1"}, UpdateMask: mask("labels")}); err != nil {
			t.Errorf("without lock the version is ignored, got %v", err)
		}
	})

	t.Run("hub_accepts_client drives HubAcceptedManagedCluster", func(t *testing.T) {
		s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}})
		now := time.Date(2026, 10, 15, 13, 0, 0, 0, time.UTC)
		s.SetClock(func() time.Time { return now })
		got, err := update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a", HubAcceptsClient: false}, UpdateMask: mask("hub_accepts_client")})
		if err != nil {
			t.Fatal(err)
		}
		c := findCondition(got, CondHubAccepted)
		if got.GetHubAcceptsClient() || c.GetStatus() != cFalse || c.GetReason() != ReasonHubDenied || c.GetMessage() != MessageHubDenied || !c.GetLastTransitionTime().AsTime().Equal(now) {
			t.Errorf("denied condition = %v", c)
		}
		if got.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED || got.GetStatus().GetStateMessage() != MessageHubDenied {
			t.Errorf("state = %s %q", got.GetStatus().GetState(), got.GetStatus().GetStateMessage())
		}
		if got.GetGeneration() != 1 {
			t.Errorf("a spec change bumps generation, got %d", got.GetGeneration())
		}
		got, err = update(s, &aigridv1.UpdateManagedClusterRequest{Object: &aigridv1.ManagedCluster{Name: "a", HubAcceptsClient: true}, UpdateMask: mask("hub_accepts_client")})
		if err != nil {
			t.Fatal(err)
		}
		if c := findCondition(got, CondHubAccepted); c.GetReason() != ReasonHubAccepted || c.GetMessage() != MessageHubAccepted || got.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE {
			t.Errorf("re-accepted = %v, state %s", c, got.GetStatus().GetState())
		}
	})
}

// importingCluster is site-berlin-1 from the research: created by ACM, agent
// not yet joined.
func importingCluster(name string, created time.Time) *aigridv1.ManagedCluster {
	c := withConditions(
		cond(CondHubAccepted, cTrue, ReasonHubAccepted, MessageHubAccepted),
		cond(CondImportSucceeded, cFalse, ReasonImporting, MessageImportApplied),
	)
	c.Name = name
	c.Labels = map[string]string{LabelName: name, LabelCloud: LabelAutoDetect, LabelVendor: LabelAutoDetect, LabelClusterSet: "default"}
	c.Taints = []*aigridv1.Taint{{Key: TaintUnreachable, Effect: TaintNoSelect, TimeAdded: timestamppb.New(created.Add(3 * time.Second))}}
	c.CreationTimestamp = timestamppb.New(created)
	return c
}

func TestScenarioImport(t *testing.T) {
	start := time.Date(2026, 10, 15, 10, 0, 0, 0, time.UTC)
	spoke := `{"kubernetesVersion":"v1.35.6","capacity":{"cpu":"64","nvidia.com/gpu":"8"},"allocatable":{"cpu":"61","nvidia.com/gpu":"8"},
	  "clusterClaims":[{"name":"version.openshift.io","value":"4.22.15"},{"name":"id.k8s.io","value":"5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9"},
	  {"name":"platform.open-cluster-management.io","value":"AWS"},{"name":"product.open-cluster-management.io","value":"OpenShift"}]}`
	fx := &Fixtures{
		Clusters: []*aigridv1.ManagedCluster{importingCluster("berlin", start)},
		Speed:    2, // "20s" fires after 10s of wall clock
		Scenarios: []ScenarioEvent{
			{Cluster: "berlin", At: Duration{20 * time.Second}, Event: EventJoined, Spoke: []byte(spoke)},
			{Cluster: "berlin", At: Duration{70 * time.Second}, Event: EventImported},
			{Cluster: "berlin", At: Duration{90 * time.Second}, Event: EventAddonsAvailable, Addons: []string{"work-manager"}},
		},
	}
	s := newServer(t, fx)
	now := start
	s.SetClock(func() time.Time { return now })
	ctx := authed(context.Background())
	get := func() *aigridv1.ManagedCluster {
		resp, err := s.GetManagedCluster(ctx, &aigridv1.GetManagedClusterRequest{Name: "berlin"})
		if err != nil {
			t.Fatal(err)
		}
		return resp.GetObject()
	}

	c := get()
	if c.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING || c.GetStatus().GetStateMessage() != MessageImportApplied {
		t.Fatalf("t0: %s %q", c.GetStatus().GetState(), c.GetStatus().GetStateMessage())
	}
	before := c.GetResourceVersion()

	now = start.Add(9 * time.Second) // 18 scenario seconds: nothing yet
	if c = get(); c.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING || c.GetResourceVersion() != before {
		t.Fatalf("t9: %s rv %s", c.GetStatus().GetState(), c.GetResourceVersion())
	}

	now = start.Add(10 * time.Second) // joined fires at scenario 20s
	c = get()
	if c.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE {
		t.Fatalf("after joined: %s", c.GetStatus().GetState())
	}
	for _, typ := range []string{CondJoined, CondAvailable, CondClockSynced} {
		cd := findCondition(c, typ)
		if cd.GetStatus() != cTrue || !cd.GetLastTransitionTime().AsTime().Equal(start.Add(10*time.Second)) {
			t.Errorf("%s = %v; transition time must be the scheduled wall-clock instant", typ, cd)
		}
	}
	if findCondition(c, CondJoined).GetMessage() != MessageJoined || findCondition(c, CondClockSynced).GetMessage() != MessageClockSynced {
		t.Error("joined/clock-synced messages are the controllers'")
	}
	if findCondition(c, CondImportSucceeded).GetStatus() != cFalse {
		t.Error("import is not finished at join time")
	}
	l := c.GetLabels()
	if l[LabelCloud] != "Amazon" || l[LabelVendor] != "OpenShift" || l[LabelClusterID] != "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9" || l[LabelOpenShiftVersion] != "4.22.15" || l[LabelOpenShiftMajor] != "4" || l[LabelOpenShiftMajorMin] != "4.22" {
		t.Errorf("autodetect labels = %v", l)
	}
	if hasTaint(c, TaintUnreachable) {
		t.Error("the unreachable taint goes once Available is True")
	}
	if c.GetStatus().GetCapacity()["nvidia.com/gpu"] != "8" || c.GetStatus().GetKubernetesVersion() != "v1.35.6" {
		t.Errorf("spoke status not applied: %v", c.GetStatus())
	}
	if claims := c.GetStatus().GetClusterClaims(); len(claims) != 4 || claims[0].GetName() != ClaimID || claims[3].GetName() != ClaimOCPVersion {
		t.Errorf("claims must be sorted by name: %v", claims)
	}
	if c.GetResourceVersion() == before {
		t.Error("a controller write bumps resourceVersion")
	}

	now = start.Add(35 * time.Second) // 70s: imported
	c = get()
	if imp := findCondition(c, CondImportSucceeded); imp.GetStatus() != cTrue || imp.GetReason() != ReasonImported || imp.GetMessage() != MessageImported {
		t.Errorf("imported = %v", imp)
	}
	if _, ok := c.GetLabels()[LabelAddonPrefix+"work-manager"]; ok {
		t.Error("add-on labels appear only after the add-ons report")
	}

	now = start.Add(45 * time.Second) // 90s: addons
	if c = get(); c.GetLabels()[LabelAddonPrefix+"work-manager"] != AddonAvailable {
		t.Errorf("addon label = %v", c.GetLabels())
	}
}

func TestScenarioLeaseAndDetach(t *testing.T) {
	start := time.Date(2026, 10, 15, 11, 0, 0, 0, time.UTC)
	fx := &Fixtures{
		Clusters: []*aigridv1.ManagedCluster{readyCluster("madrid"), readyCluster("lyon"), readyCluster("ashburn")},
		Scenarios: []ScenarioEvent{
			{Cluster: "madrid", At: Duration{10 * time.Second}, Event: EventLeaseLost},
			{Cluster: "madrid", At: Duration{20 * time.Second}, Event: EventLeaseRecovered},
			{Cluster: "ashburn", At: Duration{10 * time.Second}, Event: EventAPIDown},
			{Cluster: "ashburn", At: Duration{20 * time.Second}, Event: EventAPIUp},
			{Cluster: "lyon", At: Duration{10 * time.Second}, Event: EventDetaching},
			{Cluster: "lyon", At: Duration{20 * time.Second}, Event: EventDetached},
		},
	}
	s := newServer(t, fx)
	now := start
	s.SetClock(func() time.Time { return now })
	ctx := authed(context.Background())
	get := func(name string) (*aigridv1.ManagedCluster, error) {
		resp, err := s.GetManagedCluster(ctx, &aigridv1.GetManagedClusterRequest{Name: name})
		return resp.GetObject(), err
	}

	now = start.Add(10 * time.Second)
	m, err := get("madrid")
	if err != nil {
		t.Fatal(err)
	}
	av := findCondition(m, CondAvailable)
	if m.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN || av.GetStatus() != cUnknown || av.GetReason() != ReasonLeaseStopped || av.GetMessage() != MessageLeaseStopped {
		t.Errorf("lease lost: %s %v", m.GetStatus().GetState(), av)
	}
	if !hasTaint(m, TaintUnreachable) || m.GetTaints()[0].GetTimeAdded().AsTime() != now || m.GetTaints()[0].GetEffect() != TaintNoSelect {
		t.Errorf("unreachable taint with timeAdded expected, got %v", m.GetTaints())
	}
	if m.GetLabels()[LabelAddonPrefix+"work-manager"] != AddonUnreachable {
		t.Errorf("addon labels flip to unreachable, got %v", m.GetLabels())
	}
	a, _ := get("ashburn")
	av = findCondition(a, CondAvailable)
	if a.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE || av.GetReason() != ReasonAPIServerUnavail || !strings.HasPrefix(av.GetMessage(), "The kube-apiserver is not ok, status code: 503, ") || !hasTaint(a, TaintUnavailable) || a.GetLabels()[LabelAddonPrefix+"work-manager"] != AddonUnhealthy {
		t.Errorf("api down: %s %v taints %v labels %v", a.GetStatus().GetState(), av, a.GetTaints(), a.GetLabels())
	}
	l, _ := get("lyon")
	if l.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING || l.GetDeletionTimestamp().AsTime() != now || l.GetStatus().GetStateMessage() != MessageDetaching {
		t.Errorf("detaching: %v", l)
	}
	if imp := findCondition(l, CondImportSucceeded); imp.GetStatus() != cFalse || imp.GetReason() != ReasonDetaching {
		t.Errorf("detaching import condition = %v", imp)
	}

	// An event for a cluster that is already gone is skipped, and
	// addons-available without a list uses the default add-ons.
	s.scenarios = append(s.scenarios,
		&scenario{ScenarioEvent: ScenarioEvent{Cluster: "lyon", At: Duration{25 * time.Second}, Event: EventImported}},
		&scenario{ScenarioEvent: ScenarioEvent{Cluster: "madrid", At: Duration{25 * time.Second}, Event: EventAddonsAvailable}},
	)

	now = start.Add(20 * time.Second)
	m, _ = get("madrid")
	av = findCondition(m, CondAvailable)
	if m.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE || !av.GetLastTransitionTime().AsTime().Equal(now) || hasTaint(m, TaintUnreachable) || m.GetLabels()[LabelAddonPrefix+"work-manager"] != AddonAvailable {
		t.Errorf("lease recovered: %s %v %v %v", m.GetStatus().GetState(), av, m.GetTaints(), m.GetLabels())
	}
	if a, _ = get("ashburn"); a.GetStatus().GetState() != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE || hasTaint(a, TaintUnavailable) {
		t.Errorf("api up: %v", a)
	}
	if _, err := get("lyon"); status.Code(err) != codes.NotFound {
		t.Errorf("detached cluster must be gone, got %v", err)
	}
	list, _ := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{})
	if list.GetTotal() != 2 {
		t.Errorf("list after detach = %d", list.GetTotal())
	}

	now = start.Add(30 * time.Second)
	m, _ = get("madrid")
	for _, a := range defaultAddons {
		if m.GetLabels()[LabelAddonPrefix+a] != AddonAvailable {
			t.Errorf("default add-on %s missing: %v", a, m.GetLabels())
		}
	}
	if _, err := get("lyon"); status.Code(err) != codes.NotFound {
		t.Errorf("an event on a detached cluster must not resurrect it, got %v", err)
	}
	for _, sc := range s.scenarios {
		if !sc.applied {
			t.Errorf("event %s/%s was not marked applied", sc.Cluster, sc.Event)
		}
	}
}

func TestDetachingEventAddsDeleting(t *testing.T) {
	s := newServer(t, &Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}, Scenarios: []ScenarioEvent{{Cluster: "a", At: Duration{time.Second}, Event: EventDetaching}}})
	now := time.Date(2026, 10, 15, 11, 0, 0, 0, time.UTC)
	s.SetClock(func() time.Time { return now })
	now = now.Add(time.Second)
	resp, err := s.GetManagedCluster(authed(context.Background()), &aigridv1.GetManagedClusterRequest{Name: "a"})
	if err != nil {
		t.Fatal(err)
	}
	d := findCondition(resp.GetObject(), CondDeleting)
	if d.GetStatus() != cTrue || d.GetReason() != ReasonResourceRemaining || d.GetMessage() != "" {
		t.Errorf("Deleting = %v", d)
	}
}

func TestScenariosAreValidated(t *testing.T) {
	if _, err := New(&Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}, Scenarios: []ScenarioEvent{{Cluster: "a", Event: "explode"}}}, nil); err == nil {
		t.Error("unknown event must fail at load")
	}
	if _, err := New(&Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}, Scenarios: []ScenarioEvent{{Cluster: "b", Event: EventImported}}}, nil); err == nil {
		t.Error("unknown cluster must fail at load")
	}
	if _, err := New(&Fixtures{Clusters: []*aigridv1.ManagedCluster{readyCluster("a")}, Scenarios: []ScenarioEvent{{Cluster: "a", Event: EventJoined, Spoke: []byte(`{"nope":1}`)}}}, nil); err == nil {
		t.Error("bad spoke payload must fail at load")
	}
}
