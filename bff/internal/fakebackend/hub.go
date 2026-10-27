package fakebackend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"
)

// Hub is the slice of the Kubernetes API server the BFF talks to: the
// SelfSubjectAccessReview endpoint behind isProviderAdmin. It answers the way
// the real API server does, including the 401 for a bad token, so the BFF's
// code path is the same against the fake and against a hub.
type Hub struct {
	access Access
	logger *slog.Logger
}

// NewHub builds the fake API server slice.
func NewHub(access Access, logger *slog.Logger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	return &Hub{access: access, logger: logger}
}

// Handler returns the HTTP handler.
func (h *Hub) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews", h.selfSubjectAccessReview)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Anything else is a real API server's 403 for an anonymous caller:
		// the fake does not pretend to be a whole hub.
		writeStatus(w, http.StatusForbidden, "Forbidden", fmt.Sprintf("the fake hub only serves SelfSubjectAccessReview; %s %s is not available", r.Method, r.URL.Path))
	})
	return mux
}

// Serve listens on addr until ctx is done.
func (h *Hub) Serve(ctx context.Context, addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	srv := &http.Server{Handler: h.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	h.logger.Info("fake hub API listening", "addr", lis.Addr().String(), "serves", "SelfSubjectAccessReview")
	if err := srv.Serve(lis); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

type accessReview struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Spec       struct {
		ResourceAttributes map[string]string `json:"resourceAttributes"`
	} `json:"spec"`
	Status struct {
		Allowed bool   `json:"allowed"`
		Reason  string `json:"reason,omitempty"`
	} `json:"status"`
}

// providerAdminQuestion is the one access review the BFF asks
// (docs/plan/bff-api.md, `isProviderAdmin`): may the caller patch
// ManagedClusters? Spelled out here, not taken from the BFF's hub package,
// so that a change there fails against the fake.
var providerAdminQuestion = map[string]string{
	"group":    "cluster.open-cluster-management.io",
	"resource": "managedclusters",
	"verb":     "patch",
}

func (h *Hub) selfSubjectAccessReview(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" || slices.Contains(h.access.RejectedTokens, token) {
		writeStatus(w, http.StatusUnauthorized, "Unauthorized", "Unauthorized")
		return
	}
	var review accessReview
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&review); err != nil {
		writeStatus(w, http.StatusBadRequest, "BadRequest", err.Error())
		return
	}
	attrs := review.Spec.ResourceAttributes
	if !maps.Equal(attrs, providerAdminQuestion) {
		// access.json answers one question only, so any other one is refused
		// rather than answered by token: a BFF that asked something else (a
		// `get` instead of a `patch`) would otherwise pass every test.
		msg := fmt.Sprintf("the fake hub answers only the provider-admin access review %v; the BFF asked %v", providerAdminQuestion, attrs)
		h.logger.Warn("access review refused", "error", msg)
		writeStatus(w, http.StatusBadRequest, "BadRequest", msg)
		return
	}
	allowed := h.access.DefaultAllowed && !slices.Contains(h.access.DeniedTokens, token)
	review.Status.Allowed = allowed
	if allowed {
		review.Status.Reason = fmt.Sprintf("RBAC: allowed by ClusterRoleBinding %q of ClusterRole %q to User %q", "ai-grid-provider-admins", "ai-grid-provider-admin", "dev-user")
	}
	h.logger.Info("access review", "verb", attrs["verb"], "resource", attrs["resource"], "group", attrs["group"], "allowed", allowed)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(review)
}

// writeStatus writes a metav1.Status the way the API server does.
func writeStatus(w http.ResponseWriter, code int, reason, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"kind": "Status", "apiVersion": "v1", "metadata": map[string]any{},
		"status": "Failure", "message": message, "reason": reason, "code": code,
	})
}
