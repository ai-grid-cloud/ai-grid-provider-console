package fakebackend

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/subscription"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/validation"
)

// The PoC's subscription messages (MockSubscriptionService and backend/api.mjs at 62319b8).
const (
	msgSubscriptionTaken    = "A subscription with this resource name already exists."
	msgSubscriptionStale    = "This subscription changed. Reload it before saving or deleting."
	msgSubscriptionDeleting = "This subscription is being deleted."
	msgPolicyTaken          = "An independently managed authorization policy already uses this name. Choose another subscription name."
	msgPolicyNameTooLong    = "The resource name must be at most 246 characters when creating a matching authorization policy."
	msgPolicyNameField      = "Leave room for the -policy suffix."
)

// DefaultModelNamespace is the namespace of a subscription's model reference
// that names none (P6): the console's models namespace.
const DefaultModelNamespace = "ai-grid-models"

// refKey is the model store key of a subscription's model reference.
func refKey(r *aigridv1.ModelSubscriptionRef) string {
	ns := r.GetNamespace()
	if ns == "" {
		ns = DefaultModelNamespace
	}
	return modelKey(ns, r.GetName())
}

// policyKey is the model store key of an auth policy's model reference; a
// reference without a namespace is to the console's models namespace, like
// a subscription's.
func policyKey(r *aigridv1.AuthPolicyModelRef) string {
	ns := r.GetNamespace()
	if ns == "" {
		ns = DefaultModelNamespace
	}
	return modelKey(ns, r.GetName())
}

// subscriptionRefers and policyRefers say whether a subscription or a
// policy references the model with the store key.
func subscriptionRefers(sub *aigridv1.Subscription, key string) bool {
	return slices.ContainsFunc(sub.GetModelRefs(), func(r *aigridv1.ModelSubscriptionRef) bool { return refKey(r) == key })
}

func policyRefers(p *aigridv1.AuthPolicy, key string) bool {
	return slices.ContainsFunc(p.GetModelRefs(), func(m *aigridv1.AuthPolicyModelRef) bool { return policyKey(m) == key })
}

// maasReferencing is DeleteModel's in-use check (SetReferencedBy): the auth
// policies and subscriptions that reference namespace/name, sorted. The
// caller holds s.mu.
func (s *Server) maasReferencing(namespace, name string) []string {
	key := modelKey(namespace, name)
	var out []string
	for _, p := range s.authPolicies {
		if policyRefers(p, key) {
			out = append(out, "auth policy "+p.GetName())
		}
	}
	for _, sub := range s.subscriptions {
		if subscriptionRefers(sub, key) {
			out = append(out, "subscription "+sub.GetName())
		}
	}
	sort.Strings(out)
	return out
}

// Stage offsets of the MaaS controller, in scenario seconds (divided by the
// settings' `speed`), from a subscription's or policy's creation: the first
// reconcile, and Kuadrant accepting the generated TokenRateLimitPolicies.
// The controller reads only their Accepted condition
// (getTRLPAcceptedCondition), never Enforced, so acceptance is what ends
// Degraded.
const (
	subscriptionReconcile = 1 * time.Second
	trlpAccepted          = 10 * time.Second
)

// MaaS phases, condition types, reasons and messages, verbatim from
// mock/research/models-maas.md 3.4-3.6 (maas-controller's
// maassubscription_controller.go deriveFinalPhase, maasmodelref_controller.go
// deriveModelPhase, conflict_detection.go).
const (
	phasePending   = "Pending"
	phaseActive    = "Active"
	phaseDegraded  = "Degraded"
	phaseFailed    = "Failed"
	phaseReady     = "Ready"
	phaseUnhealthy = "Unhealthy"

	condReady              = "Ready"
	condConflictingPolicy  = "ConflictingAuthPolicy"
	condGovernanceAttached = "GovernanceAttached"
	condRuntimeReady       = "RuntimeReady"

	msgReconciled       = "successfully reconciled"
	msgRefsInvalidFm    = "%d of %d model references are invalid or unavailable"
	msgAllRefsInvalidFm = "all %d model references are invalid or unavailable"
	msgTRLPsPendingFm   = "%d of %d TokenRateLimitPolicies not accepted"
	msgRefNotFoundFm    = `maasmodelrefs.maas.opendatahub.io %q not found`
	msgNoConflict       = "No conflicting AuthPolicies detected on MaaS-managed HTTPRoutes"
	msgPolicyCreatedFm  = "Auth policy created for subscription %q"

	msgGovernancePaired = "Active governance pairing found"
	msgNoPairingFound   = "No active subscription and auth policy pairing found"
	msgRuntimeHealthy   = "Backend is healthy"
	msgBackendNotReady  = "Backend is not ready"
	msgModelReady       = "Governed and runtime-healthy"
	msgModelUnhealthy   = "Governed but backend is not ready"
	// msgGatewayPolicyWait is maas-controller's Pending message for an auth
	// policy (maasauthpolicy_controller.go:628) on the default gateway.
	msgGatewayPolicyWait = "Waiting for gateway AuthPolicy openshift-ingress/maas-gateway-auth to be accepted and enforced"
	msgAwaitingPairing   = "Awaiting governance pairing"
	msgAwaitingPairingRt = "Awaiting governance pairing and backend readiness"
)

// trlpPrefix names the TokenRateLimitPolicy maas-controller generates per model.
const trlpPrefix = "maas-trlp-"

// maasCondition is a condition whose last transition is at scenario time at
// (zero: unknown, left unset).
func (s *Server) maasCondition(typ string, st aigridv1.ConditionStatus, reason, message string, at time.Time) *aigridv1.Condition {
	c := &aigridv1.Condition{Type: typ, Status: st, Reason: proto.String(reason), Message: proto.String(message)}
	if !at.IsZero() {
		c.LastTransitionTime = timestamppb.New(s.wallTime(at))
	}
	return c
}

// subscriptionStatus fills a subscription's phase, Ready condition and
// status lists at scenario time now, as maas-controller's deriveFinalPhase
// leaves them: no status at all until the first reconcile (status.phase has
// no default and the controller never writes Pending); then Failed when
// every model reference is missing, Degraded when some are, Degraded while
// a generated TokenRateLimitPolicy isn't Accepted, and Active. Only a
// reference to no model is invalid (NotFound); an unlimited reference
// generates no TokenRateLimitPolicy. The timer runs from creation; an update
// doesn't restart it. The caller holds s.mu.
func (s *Server) subscriptionStatus(sub *aigridv1.Subscription, now time.Time) {
	created := s.scenarioTime(sub.GetCreateTime().AsTime())
	sub.ModelRefStatuses, sub.TokenRateLimitStatuses = nil, nil
	if now.Sub(created) < subscriptionReconcile {
		sub.Phase, sub.Conditions = "", nil
		return
	}
	reconciled := created.Add(subscriptionReconcile)
	accepted := now.Sub(created) >= trlpAccepted
	missing := 0
	for _, r := range sub.GetModelRefs() {
		ns := r.GetNamespace()
		if _, ok := s.models[refKey(r)]; !ok {
			missing++
			sub.ModelRefStatuses = append(sub.ModelRefStatuses, &aigridv1.ResourceRefStatus{
				Name: r.GetName(), Namespace: ns, Reason: "NotFound", Message: fmt.Sprintf(msgRefNotFoundFm, r.GetName()),
			})
			continue
		}
		sub.ModelRefStatuses = append(sub.ModelRefStatuses, &aigridv1.ResourceRefStatus{Name: r.GetName(), Namespace: ns, Ready: true, Reason: "Valid"})
		if r.GetUnlimited() || len(r.GetTokenRateLimits()) == 0 {
			continue
		}
		ref := &aigridv1.ResourceRefStatus{Name: trlpPrefix + r.GetName(), Namespace: ns, Ready: true, Reason: "Accepted"}
		if !accepted {
			ref.Ready, ref.Reason = false, "NotAccepted"
		}
		sub.TokenRateLimitStatuses = append(sub.TokenRateLimitStatuses, &aigridv1.TokenRateLimitStatus{Ref: ref, Model: r.GetName()})
	}
	n := len(sub.GetModelRefs())
	trlps := len(sub.TokenRateLimitStatuses)
	switch {
	case missing == n:
		sub.Phase = phaseFailed
		sub.Conditions = []*aigridv1.Condition{s.maasCondition(condReady, cFalse, "ReconcileFailed", fmt.Sprintf(msgAllRefsInvalidFm, n), reconciled)}
	case missing > 0:
		sub.Phase = phaseDegraded
		sub.Conditions = []*aigridv1.Condition{s.maasCondition(condReady, cFalse, "PartialFailure", fmt.Sprintf(msgRefsInvalidFm, missing, n), reconciled)}
	case trlps > 0 && !accepted:
		sub.Phase = phaseDegraded
		sub.Conditions = []*aigridv1.Condition{s.maasCondition(condReady, cFalse, "PartialFailure", fmt.Sprintf(msgTRLPsPendingFm, trlps, trlps), reconciled)}
	default:
		since := reconciled
		if trlps > 0 {
			since = created.Add(trlpAccepted)
		}
		sub.Phase = phaseActive
		sub.Conditions = []*aigridv1.Condition{s.maasCondition(condReady, cTrue, "Reconciled", msgReconciled, since)}
	}
}

// viewSubscription is a stored subscription with its status at scenario time
// now, each model reference with its namespace (the default when it names none).
func (s *Server) viewSubscription(sub *aigridv1.Subscription, now time.Time) *aigridv1.Subscription {
	out := proto.Clone(sub).(*aigridv1.Subscription)
	for _, r := range out.GetModelRefs() {
		if r.GetNamespace() == "" {
			r.Namespace = DefaultModelNamespace
		}
	}
	s.subscriptionStatus(out, now)
	return out
}

// viewPolicy is an auth policy with its status at scenario time now. The
// research derives no Degraded or Failed policy: one is Pending, Ready
// Unknown, until the first reconcile after it was created, then Active with
// Ready and ConflictingAuthPolicy. A fixture policy existed before the fake
// started, so it is Active.
func (s *Server) viewPolicy(p *aigridv1.AuthPolicy, now time.Time) *aigridv1.AuthPolicy {
	out := proto.Clone(p).(*aigridv1.AuthPolicy)
	var created time.Time
	if wall, ok := s.policyCreated[p.GetName()]; ok {
		created = s.scenarioTime(wall)
	}
	if !created.IsZero() && now.Sub(created) < subscriptionReconcile {
		out.Phase = phasePending
		out.Conditions = []*aigridv1.Condition{s.maasCondition(condReady, cUnknown, "Unknown", msgGatewayPolicyWait, created)}
		return out
	}
	var since time.Time
	if !created.IsZero() {
		since = created.Add(subscriptionReconcile)
	}
	out.Phase = phaseActive
	out.Conditions = []*aigridv1.Condition{
		s.maasCondition(condReady, cTrue, "Reconciled", msgReconciled, since),
		s.maasCondition(condConflictingPolicy, cFalse, "NoConflict", msgNoConflict, since),
	}
	return out
}

// modelRegistration is the status of the MaaSModelRef that registers a
// model: every model counts as registered under its own namespace and name.
// It is derived as deriveModelPhase does: governed when at least one
// subscription and one auth policy reference the model, whatever their
// phase; runtime-ready when the model's phase is Ready. The fake keeps no
// pairing history, so it never reports GovernanceGap. The caller holds s.mu.
func (s *Server) modelRegistration(m *aigridv1.Model) *aigridv1.ModelRegistration {
	ns := m.GetMetadata().GetNamespace()
	key := modelKey(ns, m.GetName())
	subscribed := slices.ContainsFunc(slices.Collect(maps.Values(s.subscriptions)), func(sub *aigridv1.Subscription) bool { return subscriptionRefers(sub, key) })
	allowed := slices.ContainsFunc(slices.Collect(maps.Values(s.authPolicies)), func(p *aigridv1.AuthPolicy) bool { return policyRefers(p, key) })
	governed := subscribed && allowed
	ready := m.GetStatus().GetPhase() == aigridv1.ModelPhase_MODEL_PHASE_READY
	var zero time.Time
	out := &aigridv1.ModelRegistration{Name: m.GetName(), Namespace: ns}
	var readyCond *aigridv1.Condition
	switch {
	case governed && ready:
		out.Phase, out.Endpoint = phaseReady, m.GetStatus().GetUrl()
		readyCond = s.maasCondition(condReady, cTrue, "Reconciled", msgModelReady, zero)
	case governed:
		out.Phase = phaseUnhealthy
		readyCond = s.maasCondition(condReady, cFalse, phaseUnhealthy, msgModelUnhealthy, zero)
	case ready:
		out.Phase = phasePending
		readyCond = s.maasCondition(condReady, cFalse, phasePending, msgAwaitingPairing, zero)
	default:
		out.Phase = phasePending
		readyCond = s.maasCondition(condReady, cFalse, phasePending, msgAwaitingPairingRt, zero)
	}
	governance := s.maasCondition(condGovernanceAttached, cFalse, "NoPairingFound", msgNoPairingFound, zero)
	if governed {
		governance = s.maasCondition(condGovernanceAttached, cTrue, "GovernancePaired", msgGovernancePaired, zero)
	}
	runtime := s.maasCondition(condRuntimeReady, cFalse, "BackendNotReady", msgBackendNotReady, zero)
	if ready {
		runtime = s.maasCondition(condRuntimeReady, cTrue, "RuntimeHealthy", msgRuntimeHealthy, zero)
	}
	out.Conditions = []*aigridv1.Condition{readyCond, governance, runtime}
	return out
}

// policySuffix names the authorization policy CreateSubscription pairs with
// a subscription; a resource name is at most 253 characters, so a
// subscription that gets one is at most 246.
const policySuffix = "-policy"

// ListSubscriptions implements Subscriptions, sorted by name.
func (s *Server) ListSubscriptions(ctx context.Context, _ *aigridv1.ListSubscriptionsRequest) (*aigridv1.ListSubscriptionsResponse, error) {
	if _, err := s.begin(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.advance()
	out := make([]*aigridv1.Subscription, 0, len(s.subscriptions))
	for _, sub := range s.subscriptions {
		out = append(out, s.viewSubscription(sub, now))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetName() < out[j].GetName() })
	return &aigridv1.ListSubscriptionsResponse{Subscriptions: out}, nil
}

// GetSubscription implements Subscriptions: the subscription, the models it
// references, the policies that cover any of them, as the PoC's getInfo, and
// the referenced models' registrations (P12).
func (s *Server) GetSubscription(ctx context.Context, req *aigridv1.GetSubscriptionRequest) (*aigridv1.GetSubscriptionResponse, error) {
	if _, err := s.begin(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.advance()
	sub, ok := s.subscriptions[req.GetName()]
	if !ok {
		return nil, notFound(req.GetName())
	}
	out := &aigridv1.GetSubscriptionResponse{Subscription: s.viewSubscription(sub, now)}
	// The models come from the model store as GetModel answers them, by
	// namespace and name; a reference to a missing model has none.
	for _, r := range sub.GetModelRefs() {
		if m, ok := s.models[refKey(r)]; ok {
			out.ModelRefs = append(out.ModelRefs, s.viewModel(m, now))
		}
	}
	// A policy covers the subscription when it references one of its models
	// by namespace and name (policyKey).
	for _, p := range s.authPolicies {
		if slices.ContainsFunc(p.GetModelRefs(), func(m *aigridv1.AuthPolicyModelRef) bool { return subscriptionRefers(sub, policyKey(m)) }) {
			out.AuthPolicies = append(out.AuthPolicies, s.viewPolicy(p, now))
		}
	}
	sort.Slice(out.ModelRefs, func(i, j int) bool {
		return modelKey(out.ModelRefs[i].GetMetadata().GetNamespace(), out.ModelRefs[i].GetName()) <
			modelKey(out.ModelRefs[j].GetMetadata().GetNamespace(), out.ModelRefs[j].GetName())
	})
	for _, m := range out.ModelRefs {
		out.ModelRegistrations = append(out.ModelRegistrations, s.modelRegistration(m))
	}
	sort.Slice(out.AuthPolicies, func(i, j int) bool { return out.AuthPolicies[i].GetName() < out.AuthPolicies[j].GetName() })
	return out, nil
}

// CreateSubscription implements Subscriptions: it validates the subscription
// with the PoC's rules and the CRD's messages and saves it normalized as the
// PoC's zod schemas output it (the display name and group names trimmed), at
// version 1, and answers it without status, as it is before the first
// reconcile. With create_auth_policy it also saves <name>-policy for the
// same groups and models, described as the hub describes it, and records
// the policy as its own.
func (s *Server) CreateSubscription(ctx context.Context, req *aigridv1.CreateSubscriptionRequest) (*aigridv1.CreateSubscriptionResponse, error) {
	token, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.authorizeProviderAdmin(ctx, token, "subscriptions"); err != nil {
		return nil, err
	}
	withPolicy := req.GetCreateAuthPolicy()
	in := subscription.InputFromSubscription(req.GetObject(), &withPolicy)
	if err := validateSubscription(in, validation.CreateSubscription); err != nil {
		return nil, err
	}
	if withPolicy && len(in.Name) > 253-len(policySuffix) {
		return nil, invalid(msgPolicyNameTooLong, map[string]string{"name": msgPolicyNameField})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, taken := s.subscriptions[in.Name]; taken {
		return nil, status.Error(codes.AlreadyExists, msgSubscriptionTaken)
	}
	policyName := in.Name + policySuffix
	if _, exists := s.authPolicies[policyName]; withPolicy && exists && !s.managedPolicies[policyName] {
		return nil, status.Error(codes.AlreadyExists, msgPolicyTaken)
	}
	now := s.advance()
	created := s.clock()
	sub := in.Normalized().Subscription()
	sub.ResourceVersion, sub.CreateTime = "1", timestamppb.New(created)
	s.subscriptions[sub.GetName()] = sub
	resp := &aigridv1.CreateSubscriptionResponse{Subscription: s.viewSubscription(sub, now)}
	if withPolicy {
		p := mirrorPolicy(sub)
		s.authPolicies[policyName] = p
		s.managedPolicies[policyName] = true
		s.policyCreated[policyName] = created
		resp.AuthPolicy = s.viewPolicy(p, now)
	}
	return resp, nil
}

// UpdateSubscription implements Subscriptions. With lock a stale
// resource_version is Aborted, and a subscription being deleted is
// FailedPrecondition. The sent fields replace the stored ones the way the
// PoC merges an update: a field sent empty (absent in the PoC's JSON) keeps
// its stored value, and so does a model's billing rate or guardrails, except
// the description, which the PoC backend clears. The
// name, status, version and times stay the backend's. The <name>-policy
// create made follows the edit (one policy per subscription, Cloud Provider
// Working Group, 2026-10-16); other policies are never touched.
func (s *Server) UpdateSubscription(ctx context.Context, req *aigridv1.UpdateSubscriptionRequest) (*aigridv1.UpdateSubscriptionResponse, error) {
	token, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.authorizeProviderAdmin(ctx, token, "subscriptions"); err != nil {
		return nil, err
	}
	obj := req.GetObject()
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.subscriptions[obj.GetName()]
	if !ok {
		return nil, notFound(obj.GetName())
	}
	if req.GetLock() && obj.GetResourceVersion() != current.GetResourceVersion() {
		return nil, status.Error(codes.Aborted, msgSubscriptionStale)
	}
	if current.GetDeletionTime() != nil {
		return nil, status.Error(codes.FailedPrecondition, msgSubscriptionDeleting)
	}
	in := subscription.InputFromSubscription(obj, nil)
	in.Name = ""
	if err := validateSubscription(in, validation.UpdateSubscription); err != nil {
		return nil, err
	}
	normalized := in.Normalized().Subscription()
	next := proto.Clone(current).(*aigridv1.Subscription)
	if normalized.GetDisplayName() != "" {
		next.DisplayName = normalized.GetDisplayName()
	}
	// As the PoC backend: a description the form clears is sent as nothing and stored as "".
	next.Description = obj.GetDescription()
	next.Priority = obj.GetPriority()
	next.Owner = normalized.GetOwner()
	if obj.GetTokenMetadata() != nil {
		next.TokenMetadata = proto.Clone(obj.GetTokenMetadata()).(*aigridv1.TokenMetadata)
	}
	if obj.InferencePriority != nil {
		next.InferencePriority = proto.Int32(obj.GetInferencePriority())
	}
	if len(obj.GetGuardrails()) > 0 {
		next.Guardrails = cloneGuardrails(obj.GetGuardrails())
	}
	next.ModelRefs = nil
	for _, r := range obj.GetModelRefs() {
		ref := proto.Clone(r).(*aigridv1.ModelSubscriptionRef)
		i := slices.IndexFunc(current.GetModelRefs(), func(old *aigridv1.ModelSubscriptionRef) bool { return refKey(old) == refKey(r) })
		if i >= 0 {
			old := current.GetModelRefs()[i]
			if ref.GetDisplayName() == "" {
				ref.DisplayName = old.GetDisplayName()
			}
			if ref.GetDescription() == "" {
				ref.Description = old.GetDescription()
			}
			if ref.BillingRatePerToken == nil && old.BillingRatePerToken != nil {
				ref.BillingRatePerToken = proto.String(old.GetBillingRatePerToken())
			}
			if len(ref.GetGuardrails()) == 0 {
				ref.Guardrails = cloneGuardrails(old.GetGuardrails())
			}
		}
		next.ModelRefs = append(next.ModelRefs, ref)
	}
	next.ResourceVersion = nextVersion(current.GetResourceVersion())
	s.subscriptions[next.GetName()] = next
	if policyName := next.GetName() + policySuffix; s.managedPolicies[policyName] {
		s.authPolicies[policyName] = mirrorPolicy(next)
	}
	return &aigridv1.UpdateSubscriptionResponse{Subscription: s.viewSubscription(next, s.advance())}, nil
}

// mirrorPolicy is the <name>-policy CreateSubscription pairs with sub: its
// display name, groups and models, described as the hub describes it.
func mirrorPolicy(sub *aigridv1.Subscription) *aigridv1.AuthPolicy {
	p := &aigridv1.AuthPolicy{
		Name:          sub.GetName() + policySuffix,
		DisplayName:   sub.GetDisplayName(),
		Description:   fmt.Sprintf(msgPolicyCreatedFm, sub.GetName()),
		SubjectGroups: slices.Clone(sub.GetOwner().GetGroups()),
	}
	for _, r := range sub.GetModelRefs() {
		p.ModelRefs = append(p.ModelRefs, &aigridv1.AuthPolicyModelRef{Name: r.GetName(), Namespace: r.GetNamespace()})
	}
	return p
}

// DeleteSubscription implements Subscriptions. With resource_version set, a
// stale one is Aborted; a subscription being deleted is FailedPrecondition.
// Its <name>-policy goes too, but only when CreateSubscription made it.
func (s *Server) DeleteSubscription(ctx context.Context, req *aigridv1.DeleteSubscriptionRequest) (*aigridv1.DeleteSubscriptionResponse, error) {
	token, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.authorizeProviderAdmin(ctx, token, "subscriptions"); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.subscriptions[req.GetName()]
	if !ok {
		return nil, notFound(req.GetName())
	}
	if v := req.GetResourceVersion(); v != "" && v != current.GetResourceVersion() {
		return nil, status.Error(codes.Aborted, msgSubscriptionStale)
	}
	if current.GetDeletionTime() != nil {
		return nil, status.Error(codes.FailedPrecondition, msgSubscriptionDeleting)
	}
	delete(s.subscriptions, req.GetName())
	delete(s.liveSubscriptions, req.GetName())
	if policyName := req.GetName() + policySuffix; s.managedPolicies[policyName] {
		delete(s.authPolicies, policyName)
		delete(s.managedPolicies, policyName)
		delete(s.policyCreated, policyName)
	}
	return &aigridv1.DeleteSubscriptionResponse{}, nil
}

// validateSubscription checks a model reference's namespace (P6, which the
// PoC's models don't have) as a namespace name, and runs one of the PoC's
// subscription rules, which take it as any string. The rule runs on the
// subscription in the API's JSON shape, so the fake rejects what the UI
// rejects, with the same messages. The rules trim as zod does, so they judge
// the normalized value; they run on the input as sent so that a display name
// of only spaces is still present and gets zod's message.
func validateSubscription(in subscription.Input, rule func(json.RawMessage) map[string]string) error {
	fields := map[string]string{}
	for i, r := range in.ModelRefs {
		if ns := r.Namespace; ns != "" && (len(ns) > maxDNSLabelLength || !dns1123Label.MatchString(ns)) {
			fields["modelRefs."+strconv.Itoa(i)+".namespace"] = fmt.Sprintf(MsgDNS1123LabelFm, "namespace", ns)
		}
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return status.Errorf(codes.Internal, "marshal subscription: %v", err)
	}
	maps.Copy(fields, rule(raw))
	if len(fields) > 0 {
		return invalid(joinMessages(fields), fields)
	}
	return nil
}

func cloneGuardrails(in []*aigridv1.GuardrailAttachment) []*aigridv1.GuardrailAttachment {
	var out []*aigridv1.GuardrailAttachment
	for _, g := range in {
		out = append(out, proto.Clone(g).(*aigridv1.GuardrailAttachment))
	}
	return out
}

// nextVersion is a subscription's next resource_version.
func nextVersion(v string) string {
	n, _ := strconv.Atoi(v)
	return strconv.Itoa(n + 1)
}
