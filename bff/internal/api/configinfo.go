package api

import (
	"net/http"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
)

// ConsoleConfig is the deployment configuration the frontend needs at startup.
type ConsoleConfig struct {
	GridEndpoint       string `json:"gridEndpoint"`
	MapTileURL         string `json:"mapTileUrl"`
	MapTileAttribution string `json:"mapTileAttribution"`
	BillingURL         string `json:"billingUrl"`
	Version            string `json:"version"`
	// FakeBackend tells the UI the backend runs on fake infrastructure: it
	// shows its fake-backend banner, and no login proxy runs.
	FakeBackend bool `json:"fakeBackend"`
	// Monitoring says whether /perses/api reaches a Perses server, and the one project it
	// reads, whose dashboard-*-admin objects are the Monitoring tabs (always set when enabled).
	Monitoring MonitoringConfig `json:"monitoring"`
	// Models holds the Deploy model wizard's settings.
	Models ModelsConfig `json:"models"`
}

// MonitoringConfig is the Monitoring page's part of ConsoleConfig.
type MonitoringConfig struct {
	Enabled       bool   `json:"enabled"`
	PersesProject string `json:"persesProject"`
}

// ModelsConfig is the Models pages' part of ConsoleConfig.
type ModelsConfig struct {
	// Hardware is the wizard's Hardware list, MODEL_HARDWARE or the built-in one; never empty.
	Hardware []config.ModelHardware `json:"hardware"`
}

// getConfig answers GET /api/v1/config.
func (a *App) getConfig(w http.ResponseWriter, _ *http.Request) {
	writeData(w, http.StatusOK, ConsoleConfig{
		GridEndpoint:       a.cfg.GridEndpoint,
		MapTileURL:         a.cfg.MapTileURL,
		MapTileAttribution: a.cfg.MapTileAttribution,
		BillingURL:         a.cfg.BillingURL,
		Version:            Version,
		FakeBackend:        a.cfg.FakeBackend,
		Monitoring:         MonitoringConfig{Enabled: a.perses != nil, PersesProject: a.cfg.PersesProject},
		Models:             ModelsConfig{Hardware: a.cfg.ModelHardware},
	})
}
