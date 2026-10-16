package api

import (
	"net/http"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// listLocations answers GET /api/v1/locations with where a model can be
// placed: Models/ListLocations (P7) passed through, in the backend's order.
func (a *App) listLocations(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Models.ListLocations(ctx, &aigridv1.ListLocationsRequest{})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out := resp.GetLocations()
	if out == nil {
		out = []string{}
	}
	writeData(w, http.StatusOK, out)
}
