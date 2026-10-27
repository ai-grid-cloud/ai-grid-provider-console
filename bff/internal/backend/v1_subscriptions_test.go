package backend

import (
	"context"
	"maps"
	"slices"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

var subCreated = timestamppb.New(time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC))

// v1Sub is a stored subscription as the backend answers it.
func v1Sub() *backendv1.Subscription {
	return &backendv1.Subscription{
		Id: "gold",
		Metadata: &backendv1.Metadata{
			Version: 12, CreationTimestamp: subCreated,
			Annotations: map[string]string{annotationDisplayName: "Gold", annotationDescription: "Paid tier", "other": "kept"},
		},
		Spec: &backendv1.SubscriptionSpec{
			Owner:             &backendv1.SubscriptionOwner{Groups: []string{"group1"}, Users: []string{"svc"}},
			Priority:          5,
			Organization:      &backendv1.SubscriptionOrganization{Id: "org-uuid"},
			TokenMetadata:     &backendv1.TokenMetadata{CostCenter: "cc1", Labels: map[string]string{"k": "v"}},
			InferencePriority: proto.Int32(2),
			Guardrails:        []*backendv1.GuardrailAttachment{{RefName: "pii", Checks: []string{"email"}}},
			ModelRefs: []*backendv1.SubscriptionModelRef{{
				Name: "granite", Namespace: "models-as-a-service", DisplayName: "Granite",
				TokenRateLimits: []*backendv1.TokenRateLimit{{Limit: 1000, Window: "1m"}},
				BillingRate:     &backendv1.BillingRate{PerToken: "0.001"},
			}},
		},
		Status: &backendv1.SubscriptionStatus{
			Phase:                  "Active",
			Conditions:             []*backendv1.Condition{{Type: "Ready", Status: backendv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: proto.String("Reconciled")}},
			ModelRefStatuses:       []*backendv1.ResourceRefStatus{{Name: "granite", Ready: true, Reason: "Valid"}},
			TokenRateLimitStatuses: []*backendv1.TokenRateLimitStatus{{Ref: &backendv1.ResourceRefStatus{Name: "maas-trlp-granite"}, Model: "granite"}},
		},
	}
}

// draftSub is v1Sub in the draft.
func draftSub() *aigridv1.Subscription {
	return &aigridv1.Subscription{
		Name: "gold", DisplayName: "Gold", Description: "Paid tier", Priority: 5,
		Owner:             &aigridv1.Owner{Groups: []string{"group1"}, Users: []string{"svc"}},
		TokenMetadata:     &aigridv1.TokenMetadata{OrganizationId: "org-uuid", CostCenter: "cc1", Labels: map[string]string{"k": "v"}},
		InferencePriority: proto.Int32(2),
		Guardrails:        []*aigridv1.GuardrailAttachment{{RefName: "pii", Checks: []string{"email"}}},
		ModelRefs: []*aigridv1.ModelSubscriptionRef{{
			Name: "granite", Namespace: "models-as-a-service", DisplayName: "Granite",
			TokenRateLimits:     []*aigridv1.TokenRateLimit{{Limit: 1000, Window: "1m"}},
			BillingRatePerToken: proto.String("0.001"),
		}},
		Phase:                  "Active",
		ResourceVersion:        "12",
		CreateTime:             subCreated,
		Conditions:             []*aigridv1.Condition{{Type: "Ready", Status: aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: proto.String("Reconciled")}},
		ModelRefStatuses:       []*aigridv1.ResourceRefStatus{{Name: "granite", Ready: true, Reason: "Valid"}},
		TokenRateLimitStatuses: []*aigridv1.TokenRateLimitStatus{{Ref: &aigridv1.ResourceRefStatus{Name: "maas-trlp-granite"}, Model: "granite"}},
	}
}

func TestV1SubscriptionReads(t *testing.T) {
	ctx := context.Background()
	conn := &recordingConn{reply: &backendv1.SubscriptionsListResponse{Items: []*backendv1.Subscription{v1Sub()}}}
	list, err := v1Subscriptions{conn}.ListSubscriptions(ctx, &aigridv1.ListSubscriptionsRequest{})
	if err != nil || conn.method != methodSubscriptionsList {
		t.Fatalf("List sent %s: %v", conn.method, err)
	}
	if len(list.GetSubscriptions()) != 1 || !proto.Equal(list.GetSubscriptions()[0], draftSub()) {
		t.Fatalf("List got %v, want %v", list.GetSubscriptions(), draftSub())
	}

	conn = &recordingConn{reply: &backendv1.SubscriptionsGetResponse{
		Object: v1Sub(),
		AuthPolicies: []*backendv1.AuthPolicy{{
			Id: "gold-policy", Metadata: &backendv1.Metadata{Annotations: map[string]string{annotationDisplayName: "Gold"}},
			SubjectGroups: []string{"group1"}, ModelRefs: []*backendv1.AuthPolicyModelRef{{Name: "granite", Namespace: "models-as-a-service"}},
			Phase: "Active",
		}},
		ModelRegistrations: []*backendv1.ModelRegistration{
			{Name: "granite", Namespace: "models-as-a-service", Phase: "Ready", Endpoint: "https://maas/granite",
				Conditions: []*backendv1.Condition{{Type: "Ready", Status: backendv1.ConditionStatus_CONDITION_STATUS_TRUE}}},
			{Name: "opt", Namespace: "models-as-a-service", Phase: "Unhealthy",
				Conditions: []*backendv1.Condition{{Type: "Ready", Status: backendv1.ConditionStatus_CONDITION_STATUS_FALSE, Message: proto.String("no endpoints")}}},
			// Git mode: no phase, and a Ready condition of unknown status, reason SavedToGit.
			{Name: "llama", Namespace: "models-as-a-service",
				Conditions: []*backendv1.Condition{{Type: "Ready", Status: backendv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED, Reason: proto.String("SavedToGit"), Message: proto.String("Saved to Git")}}},
			// Not reconciled yet: no phase and no conditions.
			{Name: "phi", Namespace: "models-as-a-service"},
		},
	}}
	got, err := v1Subscriptions{conn}.GetSubscription(ctx, &aigridv1.GetSubscriptionRequest{Name: "gold"})
	if err != nil || conn.method != methodSubscriptionsGet || conn.req.(*backendv1.SubscriptionsGetRequest).GetId() != "gold" {
		t.Fatalf("Get sent %s %v: %v", conn.method, conn.req, err)
	}
	if !proto.Equal(got.GetSubscription(), draftSub()) {
		t.Fatalf("Get subscription %v, want %v", got.GetSubscription(), draftSub())
	}
	wantPolicy := &aigridv1.AuthPolicy{
		Name: "gold-policy", DisplayName: "Gold", Phase: "Active", SubjectGroups: []string{"group1"},
		ModelRefs: []*aigridv1.AuthPolicyModelRef{{Name: "granite", Namespace: "models-as-a-service"}},
	}
	if len(got.GetAuthPolicies()) != 1 || !proto.Equal(got.GetAuthPolicies()[0], wantPolicy) {
		t.Fatalf("Get policies %v, want %v", got.GetAuthPolicies(), wantPolicy)
	}
	if len(got.GetModelRegistrations()) != 4 || got.GetModelRegistrations()[0].GetEndpoint() != "https://maas/granite" {
		t.Fatalf("Get registrations %v", got.GetModelRegistrations())
	}
	// The view page reads each referenced model's state from model_refs: a
	// registered model is found, with its MaaS phase.
	wantModels := []*aigridv1.Model{
		{Name: "granite", Metadata: &aigridv1.ObjectMeta{Namespace: "models-as-a-service"}, Status: &aigridv1.ModelStatus{Phase: aigridv1.ModelPhase_MODEL_PHASE_READY}},
		{Name: "opt", Metadata: &aigridv1.ObjectMeta{Namespace: "models-as-a-service"}, Status: &aigridv1.ModelStatus{Phase: aigridv1.ModelPhase_MODEL_PHASE_FAILED, Reason: "Unhealthy", Message: "no endpoints"}},
		// Saved to Git has no phase; the console shows it as Saved to Git, not Pending.
		{Name: "llama", Metadata: &aigridv1.ObjectMeta{Namespace: "models-as-a-service"}, Status: &aigridv1.ModelStatus{Reason: "SavedToGit", Message: "Saved to Git"}},
		{Name: "phi", Metadata: &aigridv1.ObjectMeta{Namespace: "models-as-a-service"}, Status: &aigridv1.ModelStatus{Phase: aigridv1.ModelPhase_MODEL_PHASE_PENDING}},
	}
	if len(got.GetModelRefs()) != len(wantModels) {
		t.Fatalf("Get models %v, want %v", got.GetModelRefs(), wantModels)
	}
	for i, m := range wantModels {
		if !proto.Equal(got.GetModelRefs()[i], m) {
			t.Errorf("model %d: %v, want %v", i, got.GetModelRefs()[i], m)
		}
	}
}

func TestV1SubscriptionCreate(t *testing.T) {
	conn := &recordingConn{reply: &backendv1.SubscriptionsCreateResponse{Object: v1Sub(), AuthPolicy: &backendv1.AuthPolicy{Id: "gold-policy"}}}
	in := draftSub()
	got, err := v1Subscriptions{conn}.CreateSubscription(context.Background(), &aigridv1.CreateSubscriptionRequest{Object: in, CreateAuthPolicy: true})
	if err != nil || conn.method != methodSubscriptionsCreate {
		t.Fatalf("Create sent %s: %v", conn.method, err)
	}
	// Output-only fields aren't sent; the organization goes to spec.organization.id.
	want := &backendv1.SubscriptionsCreateRequest{Object: &backendv1.Subscription{
		Id:       "gold",
		Metadata: &backendv1.Metadata{Annotations: map[string]string{annotationDisplayName: "Gold", annotationDescription: "Paid tier"}},
		Spec: &backendv1.SubscriptionSpec{
			Owner:             &backendv1.SubscriptionOwner{Groups: []string{"group1"}, Users: []string{"svc"}},
			Priority:          5,
			Organization:      &backendv1.SubscriptionOrganization{Id: "org-uuid"},
			TokenMetadata:     &backendv1.TokenMetadata{CostCenter: "cc1", Labels: map[string]string{"k": "v"}},
			InferencePriority: proto.Int32(2),
			Guardrails:        []*backendv1.GuardrailAttachment{{RefName: "pii", Checks: []string{"email"}}},
			ModelRefs: []*backendv1.SubscriptionModelRef{{
				Name: "granite", Namespace: "models-as-a-service",
				TokenRateLimits: []*backendv1.TokenRateLimit{{Limit: 1000, Window: "1m"}},
				BillingRate:     &backendv1.BillingRate{PerToken: "0.001"},
			}},
		},
	}}
	if !proto.Equal(conn.req.(proto.Message), want) {
		t.Fatalf("Create sent %v, want %v", conn.req, want)
	}
	if !proto.Equal(got.GetSubscription(), draftSub()) || got.GetAuthPolicy().GetName() != "gold-policy" {
		t.Fatalf("Create got %v", got)
	}

	// The backend always creates <name>-policy, so a create without one is refused.
	_, err = v1Subscriptions{conn}.CreateSubscription(context.Background(), &aigridv1.CreateSubscriptionRequest{Object: in})
	if status.Code(err) != codes.Unimplemented {
		t.Fatalf("Create without a policy: %v, want Unimplemented", err)
	}
}

func TestV1SubscriptionUpdate(t *testing.T) {
	conn := &methodConn{replies: map[string]proto.Message{
		methodSubscriptionsGet:    &backendv1.SubscriptionsGetResponse{Object: v1Sub()},
		methodSubscriptionsUpdate: &backendv1.SubscriptionsUpdateResponse{Object: v1Sub()},
	}}
	in := draftSub()
	in.DisplayName = "Gold plus"
	in.Description = "" // cleared: left out, because git mode replaces the annotations
	got, err := v1Subscriptions{conn}.UpdateSubscription(context.Background(), &aigridv1.UpdateSubscriptionRequest{Object: in, Lock: true})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{methodSubscriptionsGet, methodSubscriptionsUpdate}; !slices.Equal(conn.called, want) {
		t.Fatalf("Update called %v, want %v", conn.called, want)
	}
	if id := conn.reqs[0].(*backendv1.SubscriptionsGetRequest).GetId(); id != "gold" {
		t.Fatalf("Update read subscription %q, want gold", id)
	}
	req := conn.reqs[1].(*backendv1.SubscriptionsUpdateRequest)
	if want := []string{"spec", "metadata.annotations"}; !proto.Equal(req.GetUpdateMask(), &fieldmaskpb.FieldMask{Paths: want}) || !req.GetLock() {
		t.Fatalf("Update mask %v lock %v, want %v and lock", req.GetUpdateMask(), req.GetLock(), want)
	}
	// The mask replaces the whole map: annotations the console doesn't edit
	// are sent back as read, the display name changes, and the cleared
	// description is left out.
	meta := req.GetObject().GetMetadata()
	if want := map[string]string{annotationDisplayName: "Gold plus", "other": "kept"}; meta.GetVersion() != 12 || !maps.Equal(meta.GetAnnotations(), want) {
		t.Fatalf("Update metadata %v, want version 12 and annotations %v", meta, want)
	}
	if req.GetObject().GetSpec().GetOrganization().GetId() != "org-uuid" {
		t.Fatalf("Update spec %v", req.GetObject().GetSpec())
	}
	if got.GetSubscription().GetResourceVersion() != "12" {
		t.Fatalf("Update got %v", got)
	}

	in.ResourceVersion = "abc"
	if _, err := (v1Subscriptions{conn}).UpdateSubscription(context.Background(), &aigridv1.UpdateSubscriptionRequest{Object: in, Lock: true}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("Update with a version the backend never answered: %v, want FailedPrecondition", err)
	}
}

func TestV1SubscriptionDelete(t *testing.T) {
	conn := &recordingConn{reply: &backendv1.SubscriptionsDeleteResponse{}}
	if _, err := (v1Subscriptions{conn}).DeleteSubscription(context.Background(), &aigridv1.DeleteSubscriptionRequest{Name: "gold", ResourceVersion: "12"}); err != nil {
		t.Fatal(err)
	}
	if want := (&backendv1.SubscriptionsDeleteRequest{Id: "gold", ResourceVersion: 12}); conn.method != methodSubscriptionsDelete || !proto.Equal(conn.req.(proto.Message), want) {
		t.Fatalf("Delete sent %s %v, want %v", conn.method, conn.req, want)
	}

	// A stale version: the backend's Aborted reaches the API layer, which answers 409.
	stale := abortingConn{&recordingConn{}}
	if _, err := (v1Subscriptions{stale}).DeleteSubscription(context.Background(), &aigridv1.DeleteSubscriptionRequest{Name: "gold", ResourceVersion: "11"}); status.Code(err) != codes.Aborted {
		t.Fatalf("stale Delete: %v, want Aborted", err)
	}

	// Version 0 is the backend's "no check": refused, so If-Match never makes a delete unconditional.
	unsent := &recordingConn{}
	if _, err := (v1Subscriptions{unsent}).DeleteSubscription(context.Background(), &aigridv1.DeleteSubscriptionRequest{Name: "gold", ResourceVersion: "0"}); status.Code(err) != codes.FailedPrecondition || unsent.method != "" {
		t.Fatalf("Delete with version 0: %v after calling %q, want FailedPrecondition and no call", err, unsent.method)
	}
}

type abortingConn struct{ *recordingConn }

func (abortingConn) Invoke(context.Context, string, any, any, ...grpc.CallOption) error {
	return status.Error(codes.Aborted, "the subscription changed since it was read")
}
