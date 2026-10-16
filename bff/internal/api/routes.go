package api

import "net/http"

// registerRoutes attaches every authenticated endpoint. Keep this list in sync
// with docs/plan/bff-api.md.
func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET "+APIPrefix+"/user", a.getUser)
	mux.HandleFunc("GET "+APIPrefix+"/config", a.getConfig)

	mux.HandleFunc("GET "+APIPrefix+"/clusters", a.listClusters)
	mux.HandleFunc("GET "+APIPrefix+"/clusters/{name}", a.getCluster)
	mux.HandleFunc("PATCH "+APIPrefix+"/clusters/{name}", a.patchCluster)
	mux.HandleFunc("GET "+APIPrefix+"/tenants", a.listTenants)
	mux.HandleFunc("POST "+APIPrefix+"/tenants", a.createTenant)
	mux.HandleFunc("GET "+APIPrefix+"/tenants/{id}", a.getTenant)
	mux.HandleFunc("PATCH "+APIPrefix+"/tenants/{id}", a.patchTenant)
	mux.HandleFunc("DELETE "+APIPrefix+"/tenants/{id}", a.deleteTenant)
	mux.HandleFunc("GET "+APIPrefix+"/models", a.listModels)
	mux.HandleFunc("POST "+APIPrefix+"/models", a.createModel)
	mux.HandleFunc("GET "+APIPrefix+"/models/{namespace}/{name}", a.getModel)
	mux.HandleFunc("PATCH "+APIPrefix+"/models/{namespace}/{name}", a.patchModel)
	mux.HandleFunc("DELETE "+APIPrefix+"/models/{namespace}/{name}", a.deleteModel)
	mux.HandleFunc("GET "+APIPrefix+"/capabilities", a.getCapabilities)
	mux.HandleFunc("GET "+APIPrefix+"/locations", a.listLocations)
	mux.HandleFunc("GET "+APIPrefix+"/subscriptions", a.listSubscriptions)
	mux.HandleFunc("POST "+APIPrefix+"/subscriptions", a.createSubscription)
	mux.HandleFunc("GET "+APIPrefix+"/subscriptions/{name}", a.getSubscription)
	mux.HandleFunc("PUT "+APIPrefix+"/subscriptions/{name}", a.updateSubscription)
	mux.HandleFunc("DELETE "+APIPrefix+"/subscriptions/{name}", a.deleteSubscription)
	mux.HandleFunc("GET "+APIPrefix+"/grid/overview", a.getGridOverview)

	// Unknown API paths get a JSON 404 instead of the SPA fallback.
	mux.HandleFunc(APIPrefix+"/", a.notFound)
}

func (a *App) notFound(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotFound, "the requested resource could not be found")
}
