package api

import (
	"net/http"
	"net/url"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/subscription"
)

// Subscriptions are MaaS subscriptions and the authorization policies paired
// with them: ai_grid.v1 Subscriptions. The JSON shapes are in package
// subscription.

// listSubscriptions answers GET /api/v1/subscriptions in the backend's order.
// ListSubscriptionsRequest is empty, so any query parameter is 422 (noQuery).
func (a *App) listSubscriptions(w http.ResponseWriter, r *http.Request) {
	if err := noQuery(r, "subscriptions"); err != nil {
		a.respondError(w, r, err)
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Subscriptions.ListSubscriptions(ctx, &aigridv1.ListSubscriptionsRequest{})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out := make([]subscription.Subscription, 0, len(resp.GetSubscriptions()))
	for _, s := range resp.GetSubscriptions() {
		out = append(out, subscription.FromSubscription(s))
	}
	writeData(w, http.StatusOK, out)
}

// SubscriptionInfo is GET /api/v1/subscriptions/{name}: the PoC's
// SubscriptionInfoResponse, with the referenced models in the Model JSON of
// GET /api/v1/models.
type SubscriptionInfo struct {
	subscription.Info
	ModelRefs []Model `json:"modelRefs"`
}

// getSubscription answers GET /api/v1/subscriptions/{name} with SubscriptionInfo.
func (a *App) getSubscription(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Subscriptions.GetSubscription(ctx, &aigridv1.GetSubscriptionRequest{Name: r.PathValue("name")})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out := SubscriptionInfo{Info: subscription.FromGetResponse(resp), ModelRefs: []Model{}}
	for _, m := range resp.GetModelRefs() {
		out.ModelRefs = append(out.ModelRefs, toModel(m))
	}
	setETag(w, resp.GetSubscription().GetResourceVersion())
	writeData(w, http.StatusOK, out)
}

// createSubscription answers POST /api/v1/subscriptions with 201, the new
// subscription and its authorization policy, and the subscription's URL in
// Location.
func (a *App) createSubscription(w http.ResponseWriter, r *http.Request) {
	in, ok := a.decodeSubscription(w, r)
	if !ok {
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Subscriptions.CreateSubscription(ctx, &aigridv1.CreateSubscriptionRequest{
		Object:           in.Subscription(),
		CreateAuthPolicy: in.CreateAuthPolicy != nil && *in.CreateAuthPolicy,
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out := subscription.Mutation{Subscription: subscription.FromSubscription(resp.GetSubscription())}
	if p := resp.GetAuthPolicy(); p != nil {
		policy := subscription.FromAuthPolicy(p)
		out.AuthPolicy = &policy
	}
	a.log(r).Info("subscription created", "name", out.Subscription.Name, "authPolicy", out.AuthPolicy != nil)
	w.Header().Set("Location", APIPrefix+"/subscriptions/"+url.PathEscape(out.Subscription.Name))
	writeData(w, http.StatusCreated, out)
}

// updateSubscription answers PUT /api/v1/subscriptions/{name}. The If-Match
// version is the version the caller read: the update is written with lock on
// it, so a stale tab gets a 409 instead of overwriting a newer change; without
// If-Match (or with `*`) it is 428, as on every write.
func (a *App) updateSubscription(w http.ResponseWriter, r *http.Request) {
	if err := requireJSON(r); err != nil {
		a.respondError(w, r, err)
		return
	}
	version, err := requireIfMatch(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var in subscription.Update
	if err := decodeBody(w, r, &in); err != nil {
		a.respondError(w, r, err)
		return
	}
	obj := subscription.Input{Update: in}.Subscription()
	obj.Name, obj.ResourceVersion = r.PathValue("name"), version
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Subscriptions.UpdateSubscription(ctx, &aigridv1.UpdateSubscriptionRequest{Object: obj, Lock: true})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	a.log(r).Info("subscription updated", "name", obj.GetName())
	setETag(w, resp.GetSubscription().GetResourceVersion())
	writeData(w, http.StatusOK, subscription.Mutation{Subscription: subscription.FromSubscription(resp.GetSubscription())})
}

// deleteSubscription answers DELETE /api/v1/subscriptions/{name} with 204.
// Like PUT, the If-Match version is the backend's precondition (409 when the
// subscription changed since); without it the answer is 428.
func (a *App) deleteSubscription(w http.ResponseWriter, r *http.Request) {
	version, err := requireIfMatch(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	if _, err := a.backend.Subscriptions.DeleteSubscription(ctx, &aigridv1.DeleteSubscriptionRequest{Name: r.PathValue("name"), ResourceVersion: version}); err != nil {
		a.respondError(w, r, err)
		return
	}
	a.log(r).Info("subscription deleted", "name", r.PathValue("name"))
	w.WriteHeader(http.StatusNoContent)
}

// decodeSubscription reads a subscription body. It is forwarded as decoded:
// the backend validates and normalizes it, and its field violations come back
// as fieldErrors.
func (a *App) decodeSubscription(w http.ResponseWriter, r *http.Request) (subscription.Input, bool) {
	var in subscription.Input
	if err := decodeBody(w, r, &in); err != nil {
		a.respondError(w, r, err)
		return in, false
	}
	return in, true
}
