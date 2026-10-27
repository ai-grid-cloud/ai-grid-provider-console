package api

import (
	"context"
	"net/http"
	"time"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

type healthStatus struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	Backend string `json:"backend,omitempty"`
}

// healthcheck says the process serves HTTP, and which build it is. It needs
// no identity and does not depend on the backend. No probe uses it (the
// deployment has no liveness probe, which would restart the BFF whenever the
// proxy is down); it is for a person or a script checking the BFF itself.
func (a *App) healthcheck(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthStatus{Status: "ok", Version: Version})
}

// readyz is the readiness probe: the backend answers Ping. A console without
// its backend should not receive traffic.
func (a *App) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if _, err := a.backend.Health.Ping(ctx, &aigridv1.PingRequest{Name: "bff"}); err != nil {
		a.log(r).Warn("backend not ready", "error", err)
		writeJSON(w, http.StatusServiceUnavailable, healthStatus{Status: "unavailable", Version: Version, Backend: "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, healthStatus{Status: "ok", Version: Version, Backend: "ok"})
}
