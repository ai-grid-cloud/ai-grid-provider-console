// Package config holds the BFF runtime configuration, populated from flags with
// environment-variable fallbacks.
package config

import (
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Header names set by kube-auth-proxy (--pass-access-token, --pass-user-headers).
// The frontend dev proxy sets the same headers from `oc whoami`.
const (
	DefaultAuthTokenHeader  = "x-forwarded-access-token"
	DefaultAuthUserHeader   = "x-forwarded-user"
	DefaultAuthEmailHeader  = "x-forwarded-email"
	DefaultAuthGroupsHeader = "x-forwarded-groups"
	// DefaultBackendAddress is the backend container in the same pod.
	DefaultBackendAddress = "127.0.0.1:9090"
	// DefaultModelsNamespace is where the console creates models, the
	// namespace of PR 12's fixture models.
	DefaultModelsNamespace = "ai-grid-models"
	// DefaultBindAddress keeps the BFF off the pod network: only kube-auth-proxy
	// in the same pod (and the kubelet through it) can reach it.
	DefaultBindAddress = "127.0.0.1"
	// DefaultHubCAFile is the API server CA mounted into every pod.
	DefaultHubCAFile = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

// Config is the fully resolved BFF configuration.
type Config struct {
	// BindAddress is the host part of the listen address. Loopback by default;
	// "0.0.0.0" exposes the BFF without the proxy in front of it.
	BindAddress string
	Port        int
	// CertFile and KeyFile enable TLS when both are set.
	CertFile string
	KeyFile  string

	// Proxy headers carrying the caller's identity.
	AuthTokenHeader  string
	AuthTokenPrefix  string
	AuthUserHeader   string
	AuthEmailHeader  string
	AuthGroupsHeader string
	// HubAPIURL is the hub's Kubernetes API server, used for one call only: a
	// SelfSubjectAccessReview with the caller's own token that decides
	// isProviderAdmin. In a pod it defaults to the in-cluster address.
	HubAPIURL string
	// HubCAFile verifies the hub's serving certificate; empty uses system roots.
	HubCAFile string

	// Backend connection.
	BackendAddress    string
	BackendCAFile     string
	BackendServerName string
	BackendInsecure   bool
	BackendTimeout    time.Duration

	// StaticAssetsDir holds the built frontend. Empty disables static serving.
	StaticAssetsDir string

	// GridEndpoint is the consumer-facing inference URL shown to admins.
	GridEndpoint string
	// MapTileURL is the tile server for the fleet map; empty hides the map.
	MapTileURL string
	// BillingURL is an external billing UI link; empty hides the menu item.
	BillingURL string

	// ModelsNamespace is the namespace the console creates models in.
	ModelsNamespace string

	// FakeBackend says the backend is the fake from mock/fixtures, so the UI
	// shows a banner.
	FakeBackend bool

	LogLevel slog.Level
}

// Parse reads flags from args (without the program name) and environment variables.
func Parse(args []string, lookupEnv func(string) (string, bool)) (Config, error) {
	fs := flag.NewFlagSet("bff", flag.ContinueOnError)
	env := envReader{lookup: lookupEnv}

	var cfg Config
	var logLevel string

	fs.StringVar(&cfg.BindAddress, "bind-address", env.str("BIND_ADDRESS", DefaultBindAddress), "Interface to listen on; 0.0.0.0 for all")
	fs.IntVar(&cfg.Port, "port", env.int("PORT", 8080), "Listen port")
	fs.StringVar(&cfg.CertFile, "cert-file", env.str("CERT_FILE", ""), "TLS certificate file; enables TLS with key-file")
	fs.StringVar(&cfg.KeyFile, "key-file", env.str("KEY_FILE", ""), "TLS private key file")
	fs.StringVar(&cfg.AuthTokenHeader, "auth-token-header", env.str("AUTH_TOKEN_HEADER", DefaultAuthTokenHeader), "Header carrying the caller's bearer token")
	fs.StringVar(&cfg.AuthTokenPrefix, "auth-token-prefix", env.str("AUTH_TOKEN_PREFIX", ""), "Prefix to strip from the token header value")
	fs.StringVar(&cfg.AuthUserHeader, "auth-user-header", env.str("AUTH_USER_HEADER", DefaultAuthUserHeader), "Header carrying the caller's user name")
	fs.StringVar(&cfg.AuthEmailHeader, "auth-email-header", env.str("AUTH_EMAIL_HEADER", DefaultAuthEmailHeader), "Header carrying the caller's email")
	fs.StringVar(&cfg.AuthGroupsHeader, "auth-groups-header", env.str("AUTH_GROUPS_HEADER", DefaultAuthGroupsHeader), "Header carrying the caller's groups")
	fs.StringVar(&cfg.HubAPIURL, "hub-api-url", env.str("HUB_API_URL", inClusterAPIURL(env)), "Hub API server for the provider-admin access review; defaults to the in-cluster address in a pod")
	fs.StringVar(&cfg.HubCAFile, "hub-ca-file", env.str("HUB_CA_FILE", inClusterCAFile(env)), "CA for the hub API server; empty for system roots")
	fs.StringVar(&cfg.BackendAddress, "backend-address", env.str("BACKEND_ADDRESS", DefaultBackendAddress), "ai-grid-backend gRPC address")
	fs.StringVar(&cfg.BackendCAFile, "backend-ca-file", env.str("BACKEND_CA_FILE", ""), "CA for TLS to the backend; empty for plaintext")
	fs.StringVar(&cfg.BackendServerName, "backend-server-name", env.str("BACKEND_SERVER_NAME", ""), "Expected TLS server name of the backend")
	fs.BoolVar(&cfg.BackendInsecure, "backend-insecure", env.boolean("BACKEND_INSECURE", false), "Allow plaintext to a non-loopback backend (development only)")
	fs.DurationVar(&cfg.BackendTimeout, "backend-timeout", env.duration("BACKEND_TIMEOUT", 10*time.Second), "Per-RPC timeout towards the backend")
	fs.StringVar(&cfg.StaticAssetsDir, "static-assets-dir", env.str("STATIC_ASSETS_DIR", ""), "Directory with the built frontend; empty disables")
	fs.StringVar(&cfg.GridEndpoint, "grid-endpoint", env.str("GRID_CONSUMER_URL", ""), "Consumer-facing AI Grid inference URL")
	fs.StringVar(&cfg.MapTileURL, "map-tile-url", env.str("MAP_TILE_URL", ""), "Tile server URL template for the fleet map")
	fs.StringVar(&cfg.BillingURL, "billing-url", env.str("BILLING_URL", ""), "External billing UI URL")
	fs.StringVar(&cfg.ModelsNamespace, "models-namespace", env.str("MODELS_NAMESPACE", DefaultModelsNamespace), "Namespace the console creates models in")
	fs.BoolVar(&cfg.FakeBackend, "fake-backend", env.boolean("FAKE_BACKEND", false), "The backend is the fake from mock/fixtures; the UI shows a banner")
	fs.StringVar(&logLevel, "log-level", env.str("LOG_LEVEL", "info"), "Log level: debug, info, warn, error")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(logLevel)); err != nil {
		return Config{}, fmt.Errorf("invalid log level %q: %w", logLevel, err)
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return Config{}, fmt.Errorf("invalid port %d", cfg.Port)
	}
	if (cfg.CertFile == "") != (cfg.KeyFile == "") {
		return Config{}, fmt.Errorf("cert-file and key-file must be set together")
	}
	for name, v := range map[string]string{"auth-token-header": cfg.AuthTokenHeader, "auth-user-header": cfg.AuthUserHeader, "backend-address": cfg.BackendAddress, "hub-api-url": cfg.HubAPIURL} {
		if strings.TrimSpace(v) == "" {
			return Config{}, fmt.Errorf("%s must not be empty", name)
		}
	}
	if cfg.BackendTimeout <= 0 {
		return Config{}, fmt.Errorf("backend-timeout must be positive")
	}
	return cfg, nil
}

// TLSEnabled reports whether the server should terminate TLS itself.
func (c Config) TLSEnabled() bool { return c.CertFile != "" && c.KeyFile != "" }

// ListenAddr is the address passed to the HTTP server.
func (c Config) ListenAddr() string { return fmt.Sprintf("%s:%d", c.BindAddress, c.Port) }

// inClusterAPIURL mirrors client-go's in-cluster discovery: the kubelet injects
// KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT into every pod.
func inClusterAPIURL(env envReader) string {
	host, port := env.str("KUBERNETES_SERVICE_HOST", ""), env.str("KUBERNETES_SERVICE_PORT", "")
	if host == "" || port == "" {
		return ""
	}
	return "https://" + net.JoinHostPort(host, port)
}

func inClusterCAFile(env envReader) string {
	if inClusterAPIURL(env) == "" {
		return ""
	}
	return DefaultHubCAFile
}

type envReader struct {
	lookup func(string) (string, bool)
}

func (e envReader) str(key, fallback string) string {
	if v, ok := e.lookup(key); ok && v != "" {
		return v
	}
	return fallback
}

func (e envReader) int(key string, fallback int) int {
	if v, ok := e.lookup(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func (e envReader) boolean(key string, fallback bool) bool {
	if v, ok := e.lookup(key); ok && v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return fallback
}

func (e envReader) duration(key string, fallback time.Duration) time.Duration {
	if v, ok := e.lookup(key); ok && v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}

// OSLookupEnv adapts os.LookupEnv for Parse.
func OSLookupEnv(key string) (string, bool) { return os.LookupEnv(key) }
