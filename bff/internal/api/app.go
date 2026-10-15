// Package api wires HTTP routes, middleware and handlers.
package api

import (
	"log/slog"
	"net/http"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube"
)

// Version is set at build time with -ldflags "-X ...api.Version=<v>".
var Version = "dev"

// APIPrefix is the path prefix for JSON endpoints.
const APIPrefix = "/api/v1"

// App holds the dependencies shared by all handlers.
type App struct {
	cfg       config.Config
	logger    *slog.Logger
	clients   kube.ClientFactory
	extractor kube.HeaderExtractor
}

// NewApp assembles the application.
func NewApp(cfg config.Config, logger *slog.Logger, clients kube.ClientFactory) *App {
	return &App{
		cfg:       cfg,
		logger:    logger,
		clients:   clients,
		extractor: kube.HeaderExtractor{Header: cfg.AuthTokenHeader, Prefix: cfg.AuthTokenPrefix},
	}
}

// Handler returns the root HTTP handler.
func (a *App) Handler() http.Handler {
	api := http.NewServeMux()
	a.registerRoutes(api)

	root := http.NewServeMux()
	root.HandleFunc("GET /healthcheck", a.healthcheck)
	root.Handle(APIPrefix+"/", a.requireIdentity(api))
	if a.cfg.StaticAssetsDir != "" {
		root.Handle("/", newSPAHandler(a.cfg.StaticAssetsDir))
	}

	return a.recoverPanic(a.logRequests(root))
}
