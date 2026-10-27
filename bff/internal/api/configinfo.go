package api

import "net/http"

// ConsoleConfig is the deployment configuration the frontend needs at startup.
type ConsoleConfig struct {
	GridEndpoint       string `json:"gridEndpoint"`
	MapTileURL         string `json:"mapTileUrl"`
	MapTileAttribution string `json:"mapTileAttribution"`
	BillingURL         string `json:"billingUrl"`
	Version            string `json:"version"`
	// ModelsNamespace is the namespace the console creates models in.
	ModelsNamespace string `json:"modelsNamespace"`
	// FakeBackend tells the UI to show its fake-backend banner.
	FakeBackend bool `json:"fakeBackend"`
	// Monitoring says whether /perses/api reaches a Perses server, and the one project it
	// reads, whose dashboard- objects are the Monitoring tabs (always set when enabled).
	Monitoring MonitoringConfig `json:"monitoring"`
}

// MonitoringConfig is the Monitoring page's part of ConsoleConfig.
type MonitoringConfig struct {
	Enabled       bool   `json:"enabled"`
	PersesProject string `json:"persesProject"`
}

// getConfig answers GET /api/v1/config.
func (a *App) getConfig(w http.ResponseWriter, _ *http.Request) {
	writeData(w, http.StatusOK, ConsoleConfig{
		GridEndpoint:       a.cfg.GridEndpoint,
		MapTileURL:         a.cfg.MapTileURL,
		MapTileAttribution: a.cfg.MapTileAttribution,
		BillingURL:         a.cfg.BillingURL,
		Version:            Version,
		ModelsNamespace:    a.cfg.ModelsNamespace,
		FakeBackend:        a.cfg.FakeBackend,
		Monitoring:         MonitoringConfig{Enabled: a.perses != nil, PersesProject: a.cfg.PersesProject},
	})
}
