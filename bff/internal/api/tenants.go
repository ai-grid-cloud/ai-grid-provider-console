package api

import (
	"net/http"
	"sort"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Tenant is a consumer organisation. The backend reads them from Keycloak
// Organizations in the AI Grid realm.
type Tenant struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Domains []string `json:"domains"`
}

// listTenants answers GET /api/v1/tenants.
func (a *App) listTenants(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.ListTenants(ctx, &aigridv1.ListTenantsRequest{})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out := make([]Tenant, 0, len(resp.GetTenants()))
	for _, t := range resp.GetTenants() {
		domains := t.GetDomains()
		if domains == nil {
			domains = []string{}
		}
		out = append(out, Tenant{ID: t.GetId(), Name: t.GetName(), Domains: domains})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeData(w, http.StatusOK, out)
}
