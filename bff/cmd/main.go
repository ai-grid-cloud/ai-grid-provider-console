// Command bff serves the AI Grid provider console API and, when configured, the
// built frontend. Every API call is translated into an RPC on ai-grid-backend.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/api"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/hub"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/perses"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Parse(os.Args[1:], config.OSLookupEnv)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	client, err := backend.Dial(backend.Config{
		Address:         cfg.BackendAddress,
		CAFile:          cfg.BackendCAFile,
		ServerName:      cfg.BackendServerName,
		Insecure:        cfg.BackendInsecure,
		Timeout:         cfg.BackendTimeout,
		DraftAPI:        cfg.FakeBackend,
		ModelsNamespace: cfg.ModelsNamespace,
	})
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()

	hubClient, err := hub.New(hub.Config{URL: cfg.HubAPIURL, CAFile: cfg.HubCAFile})
	if err != nil {
		return err
	}

	app := api.NewApp(cfg, logger, client, hubClient)
	persesURL := "off"
	if cfg.PersesURL != "" {
		relay, err := perses.New(perses.Config{
			URL:        cfg.PersesURL,
			Project:    cfg.PersesProject,
			CAFile:     cfg.PersesCAFile,
			ServerName: cfg.PersesServerName,
			Insecure:   cfg.PersesInsecure,
			Timeout:    cfg.PersesTimeout,
		})
		if err != nil {
			return err
		}
		app.WithPerses(relay)
		persesURL = relay.URL()
	}
	srv := &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      config.WriteTimeout,
		IdleTimeout:       time.Minute,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("starting server", "addr", srv.Addr, "tls", cfg.TLSEnabled(), "version", api.Version, "backend", cfg.BackendAddress, "backendTLS", cfg.BackendCAFile != "", "hub", hubClient.URL(), "perses", persesURL)
		var serveErr error
		if cfg.TLSEnabled() {
			serveErr = srv.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile)
		} else {
			serveErr = srv.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-errCh:
		return err
	case sig := <-stop:
		logger.Info("shutting down", "signal", sig.String())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	logger.Info("server stopped")
	return nil
}
