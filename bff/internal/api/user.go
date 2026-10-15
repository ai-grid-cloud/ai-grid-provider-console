package api

import (
	"net/http"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/users"
)

// getUser answers GET /api/v1/user.
func (a *App) getUser(w http.ResponseWriter, r *http.Request) {
	c, err := a.clients.ClientFor(r.Context())
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	u, err := users.Current(r.Context(), c)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, u)
}
