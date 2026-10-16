package fakebackend

import (
	"context"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// fixedNow is the clock of newRepoServer.
var fixedNow = time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)

// newRepoServer is a server on the shipped fixtures whose clock stands still
// at fixedNow.
func newRepoServer(t *testing.T) *Server {
	t.Helper()
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	s.SetClock(func() time.Time { return fixedNow })
	return s
}

// fieldViolations are the BadRequest field violations of err, by field.
func fieldViolations(err error) map[string]string {
	out := map[string]string{}
	for _, d := range status.Convert(err).Details() {
		if br, ok := d.(*errdetails.BadRequest); ok {
			for _, v := range br.GetFieldViolations() {
				out[v.GetField()] = v.GetDescription()
			}
		}
	}
	return out
}

// acmeRobotics is the id of the fixture organization acme-robotics.
const acmeRobotics = "3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c"

// teamA is a valid new subscription, as the BFF sends it.
func teamA() *aigridv1.Subscription {
	return &aigridv1.Subscription{
		Name: "team-a", DisplayName: "Team A", Priority: 5,
		Owner: &aigridv1.Owner{Groups: []string{"team-a"}},
		ModelRefs: []*aigridv1.ModelSubscriptionRef{{
			Name: "granite-8b-instruct", Namespace: "ai-grid-models", TokenRateLimits: []*aigridv1.TokenRateLimit{{Limit: 1000, Window: "1h"}},
		}},
		TokenMetadata: &aigridv1.TokenMetadata{OrganizationId: acmeRobotics},
	}
}

func modelNames(models []*aigridv1.Model) []string {
	var out []string
	for _, m := range models {
		out = append(out, m.GetMetadata().GetNamespace()+"/"+m.GetName())
	}
	return out
}

func policyNames(t *testing.T, s *Server, sub string) []string {
	t.Helper()
	info, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: sub})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range info.GetAuthPolicies() {
		names = append(names, p.GetName())
	}
	return names
}

func TestSubscriptionFixtures(t *testing.T) {
	s := newRepoServer(t)
	list, err := s.ListSubscriptions(authed(context.Background()), &aigridv1.ListSubscriptionsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, sub := range list.GetSubscriptions() {
		names = append(names, sub.GetName())
	}
	if !slices.Equal(names, []string{"data-science", "engineering", "onboarding", "research"}) {
		t.Fatalf("fixture subscriptions %v", names)
	}
	// No fixture stores a phase: engineering is Active, data-science Degraded
	// (a missing model), research Failed, and onboarding, created when the
	// fake starts, has no status while the clock stands still.
	s.mu.RLock()
	for _, sub := range s.subscriptions {
		if sub.GetPhase() != "" || len(sub.GetConditions()) > 0 {
			t.Errorf("fixture %s stores %q %v", sub.GetName(), sub.GetPhase(), sub.GetConditions())
		}
	}
	for _, p := range s.authPolicies {
		if p.GetPhase() != "" {
			t.Errorf("fixture policy %s stores %q", p.GetName(), p.GetPhase())
		}
	}
	s.mu.RUnlock()
	wantSubPhase(t, listed(t, s, "engineering"), "Active", cTrue, "Reconciled", "successfully reconciled")
	wantSubPhase(t, listed(t, s, "data-science"), "Degraded", cFalse, "PartialFailure", "1 of 2 model references are invalid or unavailable")
	wantSubPhase(t, listed(t, s, "research"), "Failed", cFalse, "ReconcileFailed", "all 1 model references are invalid or unavailable")
	wantUnreconciled(t, listed(t, s, "onboarding"))
	info, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: "engineering"})
	if err != nil {
		t.Fatal(err)
	}
	eng := info.GetSubscription()
	if eng.GetTokenMetadata().GetOrganizationId() != acmeRobotics || eng.GetModelRefs()[0].GetBillingRatePerToken() != "0.000002" ||
		eng.GetResourceVersion() != "1" || eng.GetPhase() != "Active" {
		t.Fatalf("engineering %v", eng)
	}
	// The referenced models come from the model store, by namespace and name.
	if refs := modelNames(info.GetModelRefs()); !slices.Equal(refs, []string{"ai-grid-models/granite-8b-instruct"}) {
		t.Fatalf("engineering models %v", refs)
	}
	// A reference without a namespace is to the console's models namespace;
	// a missing model has no entry.
	ob, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: "onboarding"})
	if err != nil {
		t.Fatal(err)
	}
	if refs := modelNames(ob.GetModelRefs()); !slices.Equal(refs, []string{"ai-grid-models/tiny-llm"}) {
		t.Fatalf("onboarding models %v", refs)
	}
	ds, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: "data-science"})
	if err != nil {
		t.Fatal(err)
	}
	if refs := modelNames(ds.GetModelRefs()); !slices.Equal(refs, []string{"ai-grid-models/granite-8b-instruct"}) {
		t.Fatalf("data-science models %v", refs)
	}
	// The policies that cover granite-8b-instruct: engineering's and data-science's.
	if got := policyNames(t, s, "engineering"); !slices.Equal(got, []string{"data-science-policy", "engineering-policy"}) {
		t.Fatalf("policies %v", got)
	}
	if _, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: "nope"}); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown: %v", err)
	}
}

func TestSubscriptionCreateMakesManagedPolicy(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	resp, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: teamA(), CreateAuthPolicy: true})
	if err != nil {
		t.Fatal(err)
	}
	sub := resp.GetSubscription()
	if sub.GetPhase() != "" || sub.GetResourceVersion() != "1" || !sub.GetCreateTime().AsTime().Equal(fixedNow) {
		t.Fatalf("created %v", sub)
	}
	p := resp.GetAuthPolicy()
	if p.GetName() != "team-a-policy" || p.GetPhase() != "Pending" || p.GetDisplayName() != "Team A" ||
		!slices.Equal(p.GetSubjectGroups(), []string{"team-a"}) || len(p.GetModelRefs()) != 1 || p.GetModelRefs()[0].GetName() != "granite-8b-instruct" {
		t.Fatalf("policy %v", p)
	}
	if got := policyNames(t, s, "team-a"); !slices.Contains(got, "team-a-policy") {
		t.Fatalf("info policies %v", got)
	}

	// Without create_auth_policy, no policy.
	other := teamA()
	other.Name = "team-b"
	resp, err = s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: other})
	if err != nil || resp.GetAuthPolicy() != nil {
		t.Fatalf("no policy: %v %v", resp, err)
	}

	_, err = s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: teamA(), CreateAuthPolicy: true})
	if status.Code(err) != codes.AlreadyExists || status.Convert(err).Message() != "A subscription with this resource name already exists." {
		t.Fatalf("duplicate: %v", err)
	}
	// engineering-policy is independently managed: a subscription can't take its name.
	s.mu.Lock()
	delete(s.subscriptions, "engineering")
	s.mu.Unlock()
	eng := teamA()
	eng.Name = "engineering"
	_, err = s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: eng, CreateAuthPolicy: true})
	if status.Code(err) != codes.AlreadyExists || status.Convert(err).Message() != "An independently managed authorization policy already uses this name. Choose another subscription name." {
		t.Fatalf("policy collision: %v", err)
	}
	// With a policy, the name leaves room for the -policy suffix.
	long := teamA()
	long.Name = strings.Repeat("a", 247)
	_, err = s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: long, CreateAuthPolicy: true})
	if status.Code(err) != codes.InvalidArgument || fieldViolations(err)["name"] != "Leave room for the -policy suffix." {
		t.Fatalf("long name: %v", err)
	}
	// The shared rules apply, with their field errors.
	bad := teamA()
	bad.TokenMetadata = nil
	bad.ModelRefs[0].TokenRateLimits = nil
	_, err = s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: bad, CreateAuthPolicy: true})
	want := map[string]string{
		"tokenMetadata.organizationId": "Select an organization",
		"modelRefs.0":                  "tokenRateLimits is required unless unlimited is true",
	}
	if status.Code(err) != codes.InvalidArgument || !maps.Equal(fieldViolations(err), want) {
		t.Fatalf("invalid: %v %v", err, fieldViolations(err))
	}
}

func TestSubscriptionDeleteRemovesOnlyManagedPolicy(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	if _, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: teamA(), CreateAuthPolicy: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteSubscription(ctx, &aigridv1.DeleteSubscriptionRequest{Name: "team-a", ResourceVersion: "1"}); err != nil {
		t.Fatal(err)
	}
	// Deleting the fixture engineering leaves engineering-policy, as the PoC does.
	if _, err := s.DeleteSubscription(ctx, &aigridv1.DeleteSubscriptionRequest{Name: "engineering", ResourceVersion: "1"}); err != nil {
		t.Fatal(err)
	}
	if got := policyNames(t, s, "data-science"); !slices.Equal(got, []string{"data-science-policy", "engineering-policy", "research-policy"}) {
		t.Fatalf("policies after delete %v", got)
	}
	s.mu.RLock()
	_, teamPolicy := s.authPolicies["team-a-policy"]
	_, engineering := s.subscriptions["engineering"]
	s.mu.RUnlock()
	if teamPolicy || engineering {
		t.Fatalf("team-a-policy kept %v, engineering kept %v", teamPolicy, engineering)
	}
	// The name is free again, policy and all.
	if _, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: teamA(), CreateAuthPolicy: true}); err != nil {
		t.Fatalf("re-create: %v", err)
	}
	if _, err := s.DeleteSubscription(ctx, &aigridv1.DeleteSubscriptionRequest{Name: "nope"}); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown: %v", err)
	}

	// A subscription being deleted can't be deleted or saved again.
	s.mu.Lock()
	s.subscriptions["research"].DeletionTime = timestamppb.New(fixedNow)
	s.mu.Unlock()
	_, err := s.DeleteSubscription(ctx, &aigridv1.DeleteSubscriptionRequest{Name: "research", ResourceVersion: "1"})
	if status.Code(err) != codes.FailedPrecondition || status.Convert(err).Message() != "This subscription is being deleted." {
		t.Fatalf("being deleted: %v", err)
	}
	research := info(t, s, "research")
	_, err = s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: research, Lock: true})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("update while being deleted: %v", err)
	}
}

func info(t *testing.T, s *Server, name string) *aigridv1.Subscription {
	t.Helper()
	resp, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: name})
	if err != nil {
		t.Fatal(err)
	}
	return resp.GetSubscription()
}

func TestSubscriptionUpdatePreservesUnknownFields(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	eng := info(t, s, "engineering")
	ip := int32(-5)
	s.mu.Lock()
	stored := s.subscriptions["engineering"]
	stored.Owner.Users = []string{"alice"}
	stored.InferencePriority = &ip
	stored.Guardrails = []*aigridv1.GuardrailAttachment{{RefName: "safety"}}
	s.mu.Unlock()

	// The form sends back what it doesn't edit, with a new description.
	edit := proto.Clone(eng).(*aigridv1.Subscription)
	edit.Owner.Users = []string{"alice"}
	edit.InferencePriority = &ip
	edit.Guardrails = []*aigridv1.GuardrailAttachment{{RefName: "safety"}}
	edit.Description = "Changed description"
	resp, err := s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true})
	if err != nil {
		t.Fatal(err)
	}
	got := resp.GetSubscription()
	if got.GetDescription() != "Changed description" || got.GetResourceVersion() != "2" || got.GetPhase() != "Active" ||
		!got.GetCreateTime().AsTime().Equal(eng.GetCreateTime().AsTime()) {
		t.Fatalf("updated %v", got)
	}
	if got.GetModelRefs()[0].GetBillingRatePerToken() != "0.000002" || !slices.Equal(got.GetOwner().GetUsers(), []string{"alice"}) ||
		got.GetTokenMetadata().GetCostCenter() != "engineering" || got.GetTokenMetadata().GetLabels()["environment"] != "production" ||
		got.GetInferencePriority() != -5 || got.GetGuardrails()[0].GetRefName() != "safety" {
		t.Fatalf("lost fields: %v", got)
	}

	// A model ref sent without billing keeps the stored billing, and token metadata
	// sent as nothing keeps the stored one, as the PoC merges them.
	edit = proto.Clone(got).(*aigridv1.Subscription)
	edit.ModelRefs[0].BillingRatePerToken = nil
	edit.TokenMetadata = nil
	edit.Owner.Groups = []string{"engineering", "platform"}
	resp, err = s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true})
	if err != nil {
		t.Fatal(err)
	}
	got = resp.GetSubscription()
	if got.GetModelRefs()[0].GetBillingRatePerToken() != "0.000002" || got.GetTokenMetadata().GetOrganizationId() != acmeRobotics ||
		!slices.Equal(got.GetOwner().GetGroups(), []string{"engineering", "platform"}) {
		t.Fatalf("merge: %v", got)
	}
	// Update never touches a policy create did not make.
	if got := policyNames(t, s, "engineering"); !slices.Equal(got, []string{"data-science-policy", "engineering-policy"}) {
		t.Fatalf("policies %v", got)
	}
	s.mu.RLock()
	subjects := s.authPolicies["engineering-policy"].GetSubjectGroups()
	s.mu.RUnlock()
	if !slices.Equal(subjects, []string{"engineering"}) {
		t.Fatalf("policy subjects changed: %v", subjects)
	}

	// The shared update rules apply; an unlimited model needs no limits.
	edit = proto.Clone(got).(*aigridv1.Subscription)
	edit.ModelRefs[0].TokenRateLimits = nil
	_, err = s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true})
	if status.Code(err) != codes.InvalidArgument || fieldViolations(err)["modelRefs.0"] == "" {
		t.Fatalf("invalid: %v", err)
	}
	edit.ModelRefs[0].Unlimited = true
	if _, err := s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true}); err != nil {
		t.Fatalf("unlimited: %v", err)
	}
	if _, err := s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: &aigridv1.Subscription{Name: "nope"}}); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown: %v", err)
	}
}

func TestSubscriptionRejectsStaleVersion(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	stale := info(t, s, "engineering")
	fresh := proto.Clone(stale).(*aigridv1.Subscription)
	fresh.Priority = 42
	if _, err := s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: fresh, Lock: true}); err != nil {
		t.Fatal(err)
	}
	const msg = "This subscription changed. Reload it before saving or deleting."
	stale.Description = "Unsaved description"
	_, err := s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: stale, Lock: true})
	if status.Code(err) != codes.Aborted || status.Convert(err).Message() != msg {
		t.Fatalf("stale update: %v", err)
	}
	_, err = s.DeleteSubscription(ctx, &aigridv1.DeleteSubscriptionRequest{Name: "engineering", ResourceVersion: "1"})
	if status.Code(err) != codes.Aborted || status.Convert(err).Message() != msg {
		t.Fatalf("stale delete: %v", err)
	}
	if got := info(t, s, "engineering"); got.GetPriority() != 42 || got.GetDescription() == "Unsaved description" {
		t.Fatalf("overwritten: %v", got)
	}
}

// TestSubscriptionUpdateClearsDescription: the edit form sends no description
// when the user clears it, and the PoC backend stores "" (backend/api.mjs:90).
func TestSubscriptionUpdateClearsDescription(t *testing.T) {
	s := newRepoServer(t)
	edit := info(t, s, "engineering")
	edit.Description = ""
	resp, err := s.UpdateSubscription(authed(context.Background()), &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetSubscription().GetDescription(); got != "" {
		t.Fatalf("description kept: %q", got)
	}
}

// TestSubscriptionUpdateKeepsTheManagedPolicyInStep: an edit applies its
// groups and models to the <name>-policy create made, so access follows the
// subscription (1:1, Cloud Provider Working Group, 2026-10-16).
func TestSubscriptionUpdateKeepsTheManagedPolicyInStep(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	resp, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: teamA(), CreateAuthPolicy: true})
	if err != nil {
		t.Fatal(err)
	}
	edit := resp.GetSubscription()
	edit.Owner.Groups = []string{"team-b"}
	edit.ModelRefs[0].Namespace = "team-b"
	if _, err := s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true}); err != nil {
		t.Fatal(err)
	}
	s.mu.RLock()
	p := s.authPolicies["team-a-policy"]
	s.mu.RUnlock()
	if refs := p.GetModelRefs(); !slices.Equal(p.GetSubjectGroups(), []string{"team-b"}) || len(refs) != 1 || refs[0].GetNamespace() != "team-b" {
		t.Fatalf("managed policy %v", p)
	}
}

// TestSubscriptionUpdateMergesModelRefsByNamespace: a reference to a model
// of the same name in another namespace is another model, so it keeps none
// of the stored reference's billing rate.
func TestSubscriptionUpdateMergesModelRefsByNamespace(t *testing.T) {
	s := newRepoServer(t)
	edit := info(t, s, "engineering")
	edit.ModelRefs[0].Namespace, edit.ModelRefs[0].BillingRatePerToken = "team-b", nil
	resp, err := s.UpdateSubscription(authed(context.Background()), &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true})
	if err != nil {
		t.Fatal(err)
	}
	if ref := resp.GetSubscription().GetModelRefs()[0]; ref.BillingRatePerToken != nil {
		t.Fatalf("team-b ref took the other namespace's billing: %v", ref)
	}
}

// TestSubscriptionModelRefsReadWithTheirNamespace: a reference stored
// without a namespace reads back with the default one, so a client never
// sees a bare name that could stand for a model in any namespace.
func TestSubscriptionModelRefsReadWithTheirNamespace(t *testing.T) {
	s := newRepoServer(t)
	sub := teamA()
	sub.ModelRefs[0].Namespace = ""
	resp, err := s.CreateSubscription(authed(context.Background()), &aigridv1.CreateSubscriptionRequest{Object: sub})
	if err != nil {
		t.Fatal(err)
	}
	if ns := resp.GetSubscription().GetModelRefs()[0].GetNamespace(); ns != DefaultModelNamespace {
		t.Fatalf("namespace %q, want %q", ns, DefaultModelNamespace)
	}
}

// TestSubscriptionsAreNormalizedBeforeValidation: the backend trims the
// display name and group names as the PoC's zod schemas do, and stores the
// trimmed values; a display name of only spaces is the PoC's message.
func TestSubscriptionsAreNormalizedBeforeValidation(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	in := teamA()
	in.DisplayName = "  Team A  "
	in.Owner.Groups = []string{" team-a "}
	resp, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: in})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetSubscription(); got.GetDisplayName() != "Team A" || !slices.Equal(got.GetOwner().GetGroups(), []string{"team-a"}) {
		t.Fatalf("created %v", got)
	}
	edit := info(t, s, "team-a")
	edit.DisplayName = "\tTeam A2 "
	edit.Owner.Groups = []string{" team-b"}
	upd, err := s.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := upd.GetSubscription(); got.GetDisplayName() != "Team A2" || !slices.Equal(got.GetOwner().GetGroups(), []string{"team-b"}) {
		t.Fatalf("updated %v", got)
	}
	if got := info(t, s, "team-a"); got.GetDisplayName() != "Team A2" {
		t.Fatalf("stored %v", got)
	}

	blank := teamA()
	blank.Name, blank.DisplayName = "team-c", "   "
	_, err = s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: blank})
	if status.Code(err) != codes.InvalidArgument || fieldViolations(err)["displayName"] != "String must contain at least 1 character(s)" {
		t.Fatalf("blank display name: %v %v", err, fieldViolations(err))
	}
}

// TestSubscriptionsNeedAProviderAdminToWrite: like PR 12's RPCs, every
// subscription RPC needs a bearer token, and a token the hub denies (a
// viewer) reads but can't create, update or delete.
func TestSubscriptionsNeedAProviderAdminToWrite(t *testing.T) {
	s := newRepoServer(t)
	viewer := metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "Bearer viewer-token", "x-forwarded-user", "viewer"))
	anon := context.Background()
	if _, err := s.ListSubscriptions(anon, &aigridv1.ListSubscriptionsRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("anonymous list: %v", err)
	}
	if _, err := s.ListSubscriptions(viewer, &aigridv1.ListSubscriptionsRequest{}); err != nil {
		t.Fatalf("viewer list: %v", err)
	}
	if _, err := s.GetSubscription(viewer, &aigridv1.GetSubscriptionRequest{Name: "engineering"}); err != nil {
		t.Fatalf("viewer get: %v", err)
	}
	eng := info(t, s, "engineering")
	for name, call := range map[string]func() error{
		"create": func() error {
			_, err := s.CreateSubscription(viewer, &aigridv1.CreateSubscriptionRequest{Object: teamA()})
			return err
		},
		"update": func() error {
			_, err := s.UpdateSubscription(viewer, &aigridv1.UpdateSubscriptionRequest{Object: eng, Lock: true})
			return err
		},
		"delete": func() error {
			_, err := s.DeleteSubscription(viewer, &aigridv1.DeleteSubscriptionRequest{Name: "engineering"})
			return err
		},
	} {
		if err := call(); status.Code(err) != codes.PermissionDenied {
			t.Errorf("viewer %s: %v, want PermissionDenied", name, err)
		}
	}
	if got := info(t, s, "engineering"); got.GetResourceVersion() != "1" {
		t.Fatalf("viewer changed engineering: %v", got)
	}
}

// TestDeleteModelReferencedBySubscription: a model a subscription references
// can't be deleted, and the refusal names the subscriptions; a reference
// without a namespace is to ai-grid-models, and one in another namespace
// doesn't count.
func TestDeleteModelReferencedBySubscription(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	_, err := s.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: "ai-grid-models", Name: "granite-8b-instruct"})
	if status.Code(err) != codes.FailedPrecondition || status.Convert(err).Message() !=
		"model ai-grid-models/granite-8b-instruct is referenced by auth policy data-science-policy, auth policy engineering-policy, subscription data-science, subscription engineering; remove those references first" {
		t.Fatalf("referenced: %v", err)
	}
	_, err = s.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: "ai-grid-models", Name: "tiny-llm"})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(status.Convert(err).Message(), "by subscription onboarding;") {
		t.Fatalf("referenced without a namespace: %v", err)
	}
	other := teamA()
	other.ModelRefs[0].Name, other.ModelRefs[0].Namespace = "mistral-7b-instruct", "team-b"
	if _, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: other}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: "ai-grid-models", Name: "mistral-7b-instruct"}); err != nil {
		t.Fatalf("a reference in another namespace blocked the delete: %v", err)
	}
	for _, name := range []string{"engineering", "data-science"} {
		if _, err := s.DeleteSubscription(ctx, &aigridv1.DeleteSubscriptionRequest{Name: name}); err != nil {
			t.Fatal(err)
		}
	}
	s.mu.Lock()
	delete(s.authPolicies, "engineering-policy")
	delete(s.authPolicies, "data-science-policy")
	s.mu.Unlock()
	if _, err := s.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: "ai-grid-models", Name: "granite-8b-instruct"}); err != nil {
		t.Fatalf("no longer referenced: %v", err)
	}
}

// TestModelRefNamespaceIsANamespaceName: the PoC's rules forbid a model
// reference's namespace (its models had none); the backend checks P6's
// namespace as a namespace name instead.
func TestModelRefNamespaceIsANamespaceName(t *testing.T) {
	s := newRepoServer(t)
	bad := teamA()
	bad.ModelRefs[0].Namespace = "Team_B"
	_, err := s.CreateSubscription(authed(context.Background()), &aigridv1.CreateSubscriptionRequest{Object: bad})
	if status.Code(err) != codes.InvalidArgument || !strings.HasPrefix(fieldViolations(err)["modelRefs.0.namespace"], `namespace: Invalid value: "Team_B": a lowercase RFC 1123 label`) {
		t.Fatalf("bad namespace: %v %v", err, fieldViolations(err))
	}
}

// clockServer is a server on the shipped fixtures whose clock the test moves:
// the scenario starts at fixedNow, at the given speed.
func clockServer(t *testing.T, speed float64) (*Server, *time.Time) {
	t.Helper()
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	fx.Speed = speed
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	now := fixedNow
	s.SetClock(func() time.Time { return now })
	return s, &now
}

// readyCondition is the Ready condition of a subscription or policy.
func readyCondition(conds []*aigridv1.Condition) *aigridv1.Condition {
	for _, c := range conds {
		if c.GetType() == "Ready" {
			return c
		}
	}
	return nil
}

// wantPhase checks a subscription's phase and its Ready condition.
func wantSubPhase(t *testing.T, sub *aigridv1.Subscription, phase string, st aigridv1.ConditionStatus, reason, message string) {
	t.Helper()
	c := readyCondition(sub.GetConditions())
	if sub.GetPhase() != phase || c == nil || c.GetStatus() != st || c.GetReason() != reason || c.GetMessage() != message {
		t.Fatalf("%s: phase %q, Ready %v; want %s %v/%s %q", sub.GetName(), sub.GetPhase(), c, phase, st, reason, message)
	}
}

// wantUnreconciled checks a subscription the controller hasn't reconciled:
// status.phase has no default and the controller never writes Pending, so
// it has no phase, conditions or status lists.
func wantUnreconciled(t *testing.T, sub *aigridv1.Subscription) {
	t.Helper()
	if sub.GetPhase() != "" || len(sub.GetConditions())+len(sub.GetModelRefStatuses())+len(sub.GetTokenRateLimitStatuses()) != 0 {
		t.Fatalf("%s: want no status before the first reconcile, got phase %q, %v", sub.GetName(), sub.GetPhase(), sub)
	}
}

func listed(t *testing.T, s *Server, name string) *aigridv1.Subscription {
	t.Helper()
	list, err := s.ListSubscriptions(authed(context.Background()), &aigridv1.ListSubscriptionsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, sub := range list.GetSubscriptions() {
		if sub.GetName() == name {
			return sub
		}
	}
	t.Fatalf("%s not listed", name)
	return nil
}

func TestSubscriptionLifecycle(t *testing.T) {
	for _, speed := range []float64{1, 10} {
		s, now := clockServer(t, speed)
		at := func(seconds float64) { *now = fixedNow.Add(time.Duration(seconds / speed * float64(time.Second))) }
		resp, err := s.CreateSubscription(authed(context.Background()), &aigridv1.CreateSubscriptionRequest{Object: teamA()})
		if err != nil {
			t.Fatal(err)
		}
		wantUnreconciled(t, resp.GetSubscription())

		at(0.5)
		sub := listed(t, s, "team-a")
		wantUnreconciled(t, sub)

		at(2)
		sub = info(t, s, "team-a")
		wantSubPhase(t, sub, "Degraded", cFalse, "PartialFailure", "1 of 1 TokenRateLimitPolicies not accepted")
		trlp := sub.GetTokenRateLimitStatuses()
		if len(trlp) != 1 || trlp[0].GetModel() != "granite-8b-instruct" || trlp[0].GetRef().GetName() != "maas-trlp-granite-8b-instruct" ||
			trlp[0].GetRef().GetNamespace() != "ai-grid-models" || trlp[0].GetRef().GetReady() || trlp[0].GetRef().GetReason() != "NotAccepted" {
			t.Fatalf("speed %v: token rate limit statuses %v", speed, trlp)
		}
		refs := sub.GetModelRefStatuses()
		if len(refs) != 1 || refs[0].GetName() != "granite-8b-instruct" || refs[0].GetNamespace() != "ai-grid-models" || !refs[0].GetReady() || refs[0].GetReason() != "Valid" {
			t.Fatalf("model ref statuses %v", refs)
		}

		at(11)
		sub = listed(t, s, "team-a")
		wantSubPhase(t, sub, "Active", cTrue, "Reconciled", "successfully reconciled")
		if r := sub.GetTokenRateLimitStatuses()[0].GetRef(); !r.GetReady() || r.GetReason() != "Accepted" {
			t.Fatalf("accepted: %v", r)
		}
		// An update doesn't restart the timer.
		edit := proto.Clone(sub).(*aigridv1.Subscription)
		edit.Priority = 7
		upd, err := s.UpdateSubscription(authed(context.Background()), &aigridv1.UpdateSubscriptionRequest{Object: edit, Lock: true})
		if err != nil {
			t.Fatal(err)
		}
		wantSubPhase(t, upd.GetSubscription(), "Active", cTrue, "Reconciled", "successfully reconciled")
	}
}

func TestSubscriptionPhaseFromModelRefs(t *testing.T) {
	s, now := clockServer(t, 1)
	ctx := authed(context.Background())
	partial := teamA()
	partial.ModelRefs = append(partial.ModelRefs, &aigridv1.ModelSubscriptionRef{Name: "retired-llm", TokenRateLimits: []*aigridv1.TokenRateLimit{{Limit: 10, Window: "1m"}}})
	missing := teamA()
	missing.Name, missing.ModelRefs[0].Name = "team-b", "retired-llm"
	unlimited := teamA()
	unlimited.Name, unlimited.ModelRefs[0].TokenRateLimits, unlimited.ModelRefs[0].Unlimited = "team-c", nil, true
	for _, sub := range []*aigridv1.Subscription{partial, missing, unlimited} {
		if _, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: sub}); err != nil {
			t.Fatal(err)
		}
	}
	*now = fixedNow.Add(2 * time.Second)
	wantSubPhase(t, listed(t, s, "team-c"), "Active", cTrue, "Reconciled", "successfully reconciled")
	if got := listed(t, s, "team-c").GetTokenRateLimitStatuses(); len(got) != 0 {
		t.Fatalf("unlimited ref has a TokenRateLimitPolicy: %v", got)
	}
	failed := listed(t, s, "team-b")
	wantSubPhase(t, failed, "Failed", cFalse, "ReconcileFailed", "all 1 model references are invalid or unavailable")
	r := failed.GetModelRefStatuses()
	if len(r) != 1 || r[0].GetReady() || r[0].GetReason() != "NotFound" || r[0].GetNamespace() != "ai-grid-models" ||
		r[0].GetMessage() != `maasmodelrefs.maas.opendatahub.io "retired-llm" not found` {
		t.Fatalf("not found status %v", r)
	}
	*now = fixedNow.Add(11 * time.Second)
	degraded := listed(t, s, "team-a")
	wantSubPhase(t, degraded, "Degraded", cFalse, "PartialFailure", "1 of 2 model references are invalid or unavailable")
	if r := degraded.GetModelRefStatuses(); len(r) != 2 || r[0].GetReason() != "Valid" || r[1].GetReason() != "NotFound" {
		t.Fatalf("partial statuses %v", r)
	}
}

func TestTokenRateLimitsAreCountedPerModel(t *testing.T) {
	s, now := clockServer(t, 1)
	sub := teamA()
	limit := []*aigridv1.TokenRateLimit{{Limit: 10, Window: "1m"}}
	sub.ModelRefs = append(sub.ModelRefs,
		&aigridv1.ModelSubscriptionRef{Name: "tiny-llm", TokenRateLimits: limit},
		&aigridv1.ModelSubscriptionRef{Name: "codellama-13b", Unlimited: true})
	if _, err := s.CreateSubscription(authed(context.Background()), &aigridv1.CreateSubscriptionRequest{Object: sub}); err != nil {
		t.Fatal(err)
	}
	*now = fixedNow.Add(2 * time.Second)
	got := listed(t, s, "team-a")
	wantSubPhase(t, got, "Degraded", cFalse, "PartialFailure", "2 of 2 TokenRateLimitPolicies not accepted")
	var names []string
	for _, st := range got.GetTokenRateLimitStatuses() {
		names = append(names, st.GetRef().GetName())
	}
	if !slices.Equal(names, []string{"maas-trlp-granite-8b-instruct", "maas-trlp-tiny-llm"}) {
		t.Fatalf("token rate limit policies %v", names)
	}
}

func TestAuthPolicyLifecycle(t *testing.T) {
	s, now := clockServer(t, 1)
	resp, err := s.CreateSubscription(authed(context.Background()), &aigridv1.CreateSubscriptionRequest{Object: teamA(), CreateAuthPolicy: true})
	if err != nil {
		t.Fatal(err)
	}
	policy := func() *aigridv1.AuthPolicy {
		t.Helper()
		got, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: "team-a"})
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range got.GetAuthPolicies() {
			if p.GetName() == "team-a-policy" {
				return p
			}
		}
		t.Fatal("team-a-policy missing")
		return nil
	}
	if p := resp.GetAuthPolicy(); p.GetPhase() != "Pending" {
		t.Fatalf("created policy %v", p)
	}
	*now = fixedNow.Add(500 * time.Millisecond)
	if p := policy(); p.GetPhase() != "Pending" || readyCondition(p.GetConditions()).GetStatus() != cUnknown || readyCondition(p.GetConditions()).GetReason() != "Unknown" ||
		!strings.HasSuffix(readyCondition(p.GetConditions()).GetMessage(), "to be accepted and enforced") {
		t.Fatalf("pending policy %v", p)
	}
	*now = fixedNow.Add(2 * time.Second)
	p := policy()
	ready := readyCondition(p.GetConditions())
	var conflict *aigridv1.Condition
	for _, c := range p.GetConditions() {
		if c.GetType() == "ConflictingAuthPolicy" {
			conflict = c
		}
	}
	if p.GetPhase() != "Active" || ready.GetStatus() != cTrue || ready.GetReason() != "Reconciled" || ready.GetMessage() != "successfully reconciled" ||
		conflict.GetStatus() != cFalse || conflict.GetReason() != "NoConflict" || conflict.GetMessage() != "No conflicting AuthPolicies detected on MaaS-managed HTTPRoutes" {
		t.Fatalf("active policy %v", p)
	}
}

func TestManagedPolicyDescription(t *testing.T) {
	s := newRepoServer(t)
	in := teamA()
	in.Description = "Models for team A."
	resp, err := s.CreateSubscription(authed(context.Background()), &aigridv1.CreateSubscriptionRequest{Object: in, CreateAuthPolicy: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetAuthPolicy().GetDescription(); got != `Auth policy created for subscription "team-a"` {
		t.Fatalf("description %q", got)
	}
}

// registration is the model registration GetSubscription returns for a model.
func registration(t *testing.T, s *Server, sub, model string) *aigridv1.ModelRegistration {
	t.Helper()
	resp, err := s.GetSubscription(authed(context.Background()), &aigridv1.GetSubscriptionRequest{Name: sub})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range resp.GetModelRegistrations() {
		if r.GetName() == model {
			return r
		}
	}
	t.Fatalf("%s: no registration for %s in %v", sub, model, resp.GetModelRegistrations())
	return nil
}

func regCondition(conds []*aigridv1.Condition, typ string) *aigridv1.Condition {
	for _, c := range conds {
		if c.GetType() == typ {
			return c
		}
	}
	return &aigridv1.Condition{}
}

func TestModelRegistrationPairing(t *testing.T) {
	s, now := clockServer(t, 1)
	ctx := authed(context.Background())
	*now = fixedNow.Add(2 * time.Second)
	// A subscription and a policy pair whatever their phase: team-f is still
	// Pending when the registrations are read.
	failing := teamA()
	failing.Name = "team-f"
	failing.ModelRefs = append(failing.ModelRefs, &aigridv1.ModelSubscriptionRef{Name: "llama-3-70b", TokenRateLimits: []*aigridv1.TokenRateLimit{{Limit: 10, Window: "1m"}}},
		&aigridv1.ModelSubscriptionRef{Name: "tiny-llm", TokenRateLimits: []*aigridv1.TokenRateLimit{{Limit: 10, Window: "1m"}}})
	if _, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: failing}); err != nil {
		t.Fatal(err)
	}
	// Without a policy on codellama-13b: not governed.
	lonely := teamA()
	lonely.Name, lonely.ModelRefs[0].Name = "team-l", "codellama-13b"
	if _, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: lonely}); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.authPolicies["team-f-policy"] = &aigridv1.AuthPolicy{Name: "team-f-policy", ModelRefs: policyRefs("granite-8b-instruct", "llama-3-70b", "tiny-llm"), SubjectGroups: []string{"team-a"}}
	s.mu.Unlock()

	r := registration(t, s, "team-l", "codellama-13b")
	if c := regCondition(r.GetConditions(), "GovernanceAttached"); c.GetStatus() != cFalse || c.GetReason() != "NoPairingFound" ||
		c.GetMessage() != "No active subscription and auth policy pairing found" {
		t.Fatalf("unpaired governance %v", c)
	}
	if r.GetPhase() != "Pending" || r.GetEndpoint() != "" || !strings.HasPrefix(regCondition(r.GetConditions(), "Ready").GetMessage(), "Awaiting governance pairing") {
		t.Fatalf("unpaired %v", r)
	}

	r = registration(t, s, "team-f", "llama-3-70b")
	if c := regCondition(r.GetConditions(), "GovernanceAttached"); c.GetStatus() != cTrue || c.GetReason() != "GovernancePaired" || c.GetMessage() != "Active governance pairing found" {
		t.Fatalf("paired governance %v", c)
	}
	if c := regCondition(r.GetConditions(), "RuntimeReady"); c.GetStatus() != cFalse || c.GetReason() != "BackendNotReady" || c.GetMessage() != "Backend is not ready" {
		t.Fatalf("failed runtime %v", c)
	}
	if r.GetPhase() != "Unhealthy" || r.GetEndpoint() != "" || regCondition(r.GetConditions(), "Ready").GetMessage() != "Governed but backend is not ready" {
		t.Fatalf("unhealthy %v", r)
	}

	r = registration(t, s, "team-f", "tiny-llm")
	ready := regCondition(r.GetConditions(), "Ready")
	if r.GetPhase() != "Ready" || r.GetEndpoint() == "" || ready.GetStatus() != cTrue || ready.GetReason() != "Reconciled" || ready.GetMessage() != "Governed and runtime-healthy" ||
		regCondition(r.GetConditions(), "RuntimeReady").GetReason() != "RuntimeHealthy" {
		t.Fatalf("ready %v", r)
	}
	m, err := s.GetModel(ctx, &aigridv1.GetModelRequest{Namespace: "ai-grid-models", Name: "tiny-llm"})
	if err != nil {
		t.Fatal(err)
	}
	if r.GetEndpoint() != m.GetObject().GetStatus().GetUrl() {
		t.Fatalf("endpoint %q, model url %q", r.GetEndpoint(), m.GetObject().GetStatus().GetUrl())
	}
}

func TestDeleteModelReferencedByAuthPolicy(t *testing.T) {
	s := newRepoServer(t)
	s.mu.Lock()
	s.authPolicies["coders"] = &aigridv1.AuthPolicy{Name: "coders", ModelRefs: policyRefs("codellama-13b"), SubjectGroups: []string{"coders"}}
	s.mu.Unlock()
	_, err := s.DeleteModel(authed(context.Background()), &aigridv1.DeleteModelRequest{Namespace: "ai-grid-models", Name: "codellama-13b"})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(status.Convert(err).Message(), "auth policy coders") {
		t.Fatalf("referenced by a policy: %v", err)
	}
}

func TestSubscriptionCRDMessages(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	for name, tc := range map[string]struct {
		edit  func(r *aigridv1.ModelSubscriptionRef)
		field string
		msg   string
	}{
		"no limits":           {func(r *aigridv1.ModelSubscriptionRef) { r.TokenRateLimits = nil }, "modelRefs.0", "tokenRateLimits is required unless unlimited is true"},
		"unlimited and limit": {func(r *aigridv1.ModelSubscriptionRef) { r.Unlimited = true }, "modelRefs.0", "tokenRateLimits must not be set when unlimited is true"},
		"window 1d":           {func(r *aigridv1.ModelSubscriptionRef) { r.TokenRateLimits[0].Window = "1d" }, "modelRefs.0.tokenRateLimits.0.window", `should match '^[1-9]\d{0,3}(s|m|h)$'`},
		"window 0h":           {func(r *aigridv1.ModelSubscriptionRef) { r.TokenRateLimits[0].Window = "0h" }, "modelRefs.0.tokenRateLimits.0.window", `should match '^[1-9]\d{0,3}(s|m|h)$'`},
		"limit 0":             {func(r *aigridv1.ModelSubscriptionRef) { r.TokenRateLimits[0].Limit = 0 }, "modelRefs.0.tokenRateLimits.0.limit", "should be greater than or equal to 1"},
		"limit 1e9+1":         {func(r *aigridv1.ModelSubscriptionRef) { r.TokenRateLimits[0].Limit = 1_000_000_001 }, "modelRefs.0.tokenRateLimits.0.limit", "should be less than or equal to 1000000000"},
	} {
		in := teamA()
		tc.edit(in.ModelRefs[0])
		_, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: in})
		if got := fieldViolations(err); status.Code(err) != codes.InvalidArgument || !maps.Equal(got, map[string]string{tc.field: tc.msg}) {
			t.Errorf("%s: %v %v", name, err, got)
		}
	}
}

// policyRefs are auth policy model references to models in the default namespace.
func policyRefs(names ...string) []*aigridv1.AuthPolicyModelRef {
	var out []*aigridv1.AuthPolicyModelRef
	for _, n := range names {
		out = append(out, &aigridv1.AuthPolicyModelRef{Name: n})
	}
	return out
}

// TestManagedPolicyKeepsTheModelNamespace: the managed policy copies each
// reference's namespace, so it covers its own subscription, pairs the model
// in that namespace, and blocks deleting that model only.
func TestManagedPolicyKeepsTheModelNamespace(t *testing.T) {
	s := newRepoServer(t)
	ctx := authed(context.Background())
	s.mu.Lock()
	src := s.models[modelKey(DefaultModelNamespace, "mistral-7b-instruct")]
	other := *src
	other.obj = proto.Clone(src.obj).(*aigridv1.Model)
	other.obj.Metadata.Namespace = "team-b"
	s.models[modelKey("team-b", "mistral-7b-instruct")] = &other
	s.mu.Unlock()

	in := teamA()
	in.Name, in.ModelRefs[0].Name, in.ModelRefs[0].Namespace = "team-b", "mistral-7b-instruct", "team-b"
	resp, err := s.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{Object: in, CreateAuthPolicy: true})
	if err != nil {
		t.Fatal(err)
	}
	if refs := resp.GetAuthPolicy().GetModelRefs(); len(refs) != 1 || refs[0].GetName() != "mistral-7b-instruct" || refs[0].GetNamespace() != "team-b" {
		t.Fatalf("policy model refs %v", refs)
	}
	if got := policyNames(t, s, "team-b"); !slices.Equal(got, []string{"team-b-policy"}) {
		t.Fatalf("team-b policies %v", got)
	}
	if c := regCondition(registration(t, s, "team-b", "mistral-7b-instruct").GetConditions(), "GovernanceAttached"); c.GetStatus() != cTrue {
		t.Fatalf("team-b/mistral-7b-instruct governance %v", c)
	}
	// The model of the same name in ai-grid-models isn't referenced.
	if _, err := s.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: DefaultModelNamespace, Name: "mistral-7b-instruct"}); err != nil {
		t.Fatalf("blocked by a policy on another namespace: %v", err)
	}
	_, err = s.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: "team-b", Name: "mistral-7b-instruct"})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(status.Convert(err).Message(), "auth policy team-b-policy, subscription team-b;") {
		t.Fatalf("team-b/mistral-7b-instruct: %v", err)
	}
}
