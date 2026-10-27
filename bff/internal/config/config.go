// Package config holds the BFF runtime configuration, populated from flags with
// environment-variable fallbacks.
package config

import (
	"errors"
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
	// DefaultModelsNamespace is where the console creates models: the
	// backend's subscription namespace, where git mode lists models and where
	// subscriptions reference them. The fake backend's fixtures use
	// ai-grid-models, which `make run-fake` passes.
	DefaultModelsNamespace = "models-as-a-service"
	// DefaultBindAddress keeps the BFF off the pod network: only kube-auth-proxy
	// in the same pod (and the kubelet through it) can reach it.
	DefaultBindAddress = "127.0.0.1"
	// DefaultHubCAFile is the API server CA mounted into every pod.
	DefaultHubCAFile = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	// WriteTimeout is the server's write timeout: a response not written by then
	// (for example to a browser that stopped reading) has its connection cut.
	WriteTimeout = 60 * time.Second
	// MaxPersesTimeout keeps the exchange with Perses, with the provider-admin
	// check before it (at most 5 seconds, hub.Config's default), inside
	// WriteTimeout, so the relay can still answer 504.
	MaxPersesTimeout = WriteTimeout - 10*time.Second
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
	// MapTileURL is the tile server for the fleet map; empty draws a bundled
	// land outline.
	MapTileURL string
	// MapTileAttribution is the attribution shown with MapTileURL's tiles;
	// unused when MapTileURL is empty.
	MapTileAttribution string
	// BillingURL is an external billing UI link; empty hides the menu item.
	BillingURL string

	// ModelsNamespace is the namespace the console creates models in.
	ModelsNamespace string

	// FakeBackend says the backend is the fake from mock/fixtures, so the UI
	// shows a banner.
	FakeBackend bool

	// Perses is the hub's Perses server the Monitoring page reads through
	// /perses/api; an empty URL turns Monitoring off.
	PersesURL        string
	PersesCAFile     string
	PersesServerName string
	PersesInsecure   bool
	PersesTimeout    time.Duration
	// PersesProject is the one Perses project the relay reads (with the global
	// datasources); its dashboard- objects are the Monitoring tabs. Required
	// with PersesURL (bff/internal/perses says why).
	PersesProject string

	LogLevel slog.Level
}

// Parse reads flags from args (without the program name) and environment variables.
func Parse(args []string, lookupEnv func(string) (string, bool)) (Config, error) {
	fs := flag.NewFlagSet("bff", flag.ContinueOnError)
	env := envReader{lookup: lookupEnv}

	var cfg Config
	var logLevel string

	fs.StringVar(&cfg.BindAddress, "bind-address", env.str("BIND_ADDRESS", DefaultBindAddress), "Interface to listen on; 0.0.0.0 for all")
	fs.IntVar(&cfg.Port, "port", env.int("port", "PORT", 8080), "Listen port")
	fs.StringVar(&cfg.CertFile, "cert-file", env.str("CERT_FILE", ""), "TLS certificate file; enables TLS with key-file")
	fs.StringVar(&cfg.KeyFile, "key-file", env.str("KEY_FILE", ""), "TLS private key file")
	fs.StringVar(&cfg.AuthTokenHeader, "auth-token-header", env.str("AUTH_TOKEN_HEADER", DefaultAuthTokenHeader), "Header carrying the caller's bearer token")
	fs.StringVar(&cfg.AuthTokenPrefix, "auth-token-prefix", env.str("AUTH_TOKEN_PREFIX", ""), "Prefix to strip from the token header value")
	fs.StringVar(&cfg.AuthUserHeader, "auth-user-header", env.str("AUTH_USER_HEADER", DefaultAuthUserHeader), "Header carrying the caller's user name")
	fs.StringVar(&cfg.AuthEmailHeader, "auth-email-header", env.str("AUTH_EMAIL_HEADER", DefaultAuthEmailHeader), "Header carrying the caller's email")
	fs.StringVar(&cfg.AuthGroupsHeader, "auth-groups-header", env.str("AUTH_GROUPS_HEADER", DefaultAuthGroupsHeader), "Header carrying the caller's groups")
	fs.StringVar(&cfg.HubAPIURL, "hub-api-url", env.str("HUB_API_URL", inClusterAPIURL(&env)), "Hub API server for the provider-admin access review; defaults to the in-cluster address in a pod")
	fs.StringVar(&cfg.HubCAFile, "hub-ca-file", env.str("HUB_CA_FILE", inClusterCAFile(&env)), "CA for the hub API server; empty for system roots")
	fs.StringVar(&cfg.BackendAddress, "backend-address", env.str("BACKEND_ADDRESS", DefaultBackendAddress), "ai-grid-backend gRPC address")
	fs.StringVar(&cfg.BackendCAFile, "backend-ca-file", env.str("BACKEND_CA_FILE", ""), "CA for TLS to the backend; empty for plaintext")
	fs.StringVar(&cfg.BackendServerName, "backend-server-name", env.str("BACKEND_SERVER_NAME", ""), "Expected TLS server name of the backend")
	fs.BoolVar(&cfg.BackendInsecure, "backend-insecure", env.boolean("backend-insecure", "BACKEND_INSECURE", false), "Allow plaintext to a non-loopback backend (development only)")
	fs.DurationVar(&cfg.BackendTimeout, "backend-timeout", env.duration("backend-timeout", "BACKEND_TIMEOUT", 10*time.Second), "Per-RPC timeout towards the backend")
	fs.StringVar(&cfg.StaticAssetsDir, "static-assets-dir", env.str("STATIC_ASSETS_DIR", ""), "Directory with the built frontend; empty disables")
	fs.StringVar(&cfg.GridEndpoint, "grid-endpoint", env.str("GRID_CONSUMER_URL", ""), "Consumer-facing AI Grid inference URL")
	fs.StringVar(&cfg.MapTileURL, "map-tile-url", env.str("MAP_TILE_URL", ""), "Tile server URL template for the fleet map; empty draws a bundled land outline")
	fs.StringVar(&cfg.MapTileAttribution, "map-tile-attribution", env.str("MAP_TILE_ATTRIBUTION", ""), "Attribution shown with the map-tile-url tiles")
	fs.StringVar(&cfg.BillingURL, "billing-url", env.str("BILLING_URL", ""), "External billing UI URL")
	fs.StringVar(&cfg.ModelsNamespace, "models-namespace", env.str("MODELS_NAMESPACE", DefaultModelsNamespace), "Namespace the console creates models in")
	fs.BoolVar(&cfg.FakeBackend, "fake-backend", env.boolean("fake-backend", "FAKE_BACKEND", false), "The backend is the fake from mock/fixtures; the UI shows a banner")
	fs.StringVar(&cfg.PersesURL, "perses-url", env.str("PERSES_URL", ""), "The hub's Perses server for the Monitoring page; empty turns Monitoring off")
	fs.StringVar(&cfg.PersesCAFile, "perses-ca-file", env.str("PERSES_CA_FILE", ""), "CA for the Perses server's certificate; empty for system roots")
	fs.StringVar(&cfg.PersesServerName, "perses-server-name", env.str("PERSES_SERVER_NAME", ""), "Expected TLS server name of the Perses server (for a port-forward)")
	fs.BoolVar(&cfg.PersesInsecure, "perses-insecure", env.boolean("perses-insecure", "PERSES_INSECURE", false), "Allow plaintext to a non-loopback Perses server (development only)")
	fs.DurationVar(&cfg.PersesTimeout, "perses-timeout", env.duration("perses-timeout", "PERSES_TIMEOUT", 30*time.Second), "Bound on the exchange with the Perses server, from connecting to the last byte of its answer; at most 50s")
	fs.StringVar(&cfg.PersesProject, "perses-project", env.str("PERSES_PROJECT", ""), "Perses project the Monitoring page reads, whose dashboard- objects are its tabs; required with perses-url")
	fs.StringVar(&logLevel, "log-level", env.str("LOG_LEVEL", "info"), "Log level: debug, info, warn, error")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	// A flag given on the command line wins over its variable, so a variable
	// that does not parse is only an error when its value would be used.
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	var envErrs []error
	for _, e := range env.errs {
		if !given[e.flag] {
			envErrs = append(envErrs, e.err)
		}
	}
	if err := errors.Join(envErrs...); err != nil {
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
	if cfg.PersesURL != "" && strings.TrimSpace(cfg.PersesProject) == "" {
		return Config{}, fmt.Errorf("perses-project must be set with perses-url: Perses sends the caller's token on to the datasources it queries, so the relay reads one project, whose dashboards and datasources only provider admins may write")
	}
	if cfg.PersesTimeout <= 0 || cfg.PersesTimeout > MaxPersesTimeout {
		return Config{}, fmt.Errorf("perses-timeout must be positive and at most %s, to stay inside the server's %s write timeout", MaxPersesTimeout, WriteTimeout)
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
func inClusterAPIURL(env *envReader) string {
	host, port := env.str("KUBERNETES_SERVICE_HOST", ""), env.str("KUBERNETES_SERVICE_PORT", "")
	if host == "" || port == "" {
		return ""
	}
	return "https://" + net.JoinHostPort(host, port)
}

func inClusterCAFile(env *envReader) string {
	if inClusterAPIURL(env) == "" {
		return ""
	}
	return DefaultHubCAFile
}

// envReader reads the environment fallbacks of the flags. A value that does
// not parse is an error, as the same value given as a flag is, rather than
// silently the default (PORT=8o80 serving on 8080); Parse reports them all,
// except those whose flag was given. Each typed reader takes the name of the
// flag the variable is the fallback of, for that.
type envReader struct {
	lookup func(string) (string, bool)
	errs   []envError
}

type envError struct {
	flag string
	err  error
}

func (e *envReader) str(key, fallback string) string {
	if v, ok := e.lookup(key); ok && v != "" {
		return v
	}
	return fallback
}

func (e *envReader) invalid(flagName, key, value string, err error) {
	e.errs = append(e.errs, envError{flagName, fmt.Errorf("environment variable %s=%q: %w", key, value, err)})
}

func (e *envReader) int(flagName, key string, fallback int) int {
	if v, ok := e.lookup(key); ok && v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			e.invalid(flagName, key, v, errors.New("not a whole number"))
			return fallback
		}
		return n
	}
	return fallback
}

func (e *envReader) boolean(flagName, key string, fallback bool) bool {
	if v, ok := e.lookup(key); ok && v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			e.invalid(flagName, key, v, errors.New("not a boolean (true, false, 1 or 0)"))
			return fallback
		}
		return b
	}
	return fallback
}

func (e *envReader) duration(flagName, key string, fallback time.Duration) time.Duration {
	if v, ok := e.lookup(key); ok && v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			e.invalid(flagName, key, v, errors.New("not a duration with a unit, such as 30s"))
			return fallback
		}
		return d
	}
	return fallback
}

// OSLookupEnv adapts os.LookupEnv for Parse.
func OSLookupEnv(key string) (string, bool) { return os.LookupEnv(key) }
