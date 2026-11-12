package api

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/hub"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
)

// User is the signed-in caller as the UI shows it.
type User struct {
	Username string   `json:"username"`
	Email    string   `json:"email,omitempty"`
	Groups   []string `json:"groups"`
	// IsProviderAdmin tells the UI whether to offer provider-admin actions. It
	// comes from the hub's own answer to "may this user post to
	// /ai-grid/provider-console?" (the ai-grid-provider-admin ClusterRole, or
	// cluster-admin), asked with the caller's token, so it reflects the user's
	// RBAC and nothing the console decides. The same check gates every other API
	// call and both relays (requireProviderAdmin), because the backend
	// authorizes nothing yet.
	IsProviderAdmin bool `json:"isProviderAdmin"`
}

// getUser answers GET /api/v1/user: name, email and groups from the proxy
// headers, isProviderAdmin from a SelfSubjectAccessReview on the hub.
func (a *App) getUser(w http.ResponseWriter, r *http.Request) {
	id, _ := identity.FromContext(r.Context())
	groups := id.Groups
	if groups == nil {
		groups = []string{}
	}
	isAdmin, err := a.hub.CanI(r.Context(), id.Token(), hub.ProviderAdminCheck)
	if err != nil {
		if errors.Is(err, hub.ErrUnauthorized) {
			a.respondError(w, r, Errorf(http.StatusUnauthorized, "the hub rejected the credentials; log in again"))
			return
		}
		a.respondError(w, r, fmt.Errorf("%w: provider-admin check for %s: %w", errHub, id.Username, err))
		return
	}
	writeData(w, http.StatusOK, User{
		Username:        id.Username,
		Email:           id.Email,
		Groups:          groups,
		IsProviderAdmin: isAdmin,
	})
}
