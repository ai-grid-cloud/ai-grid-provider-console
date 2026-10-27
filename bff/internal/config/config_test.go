package config

import (
	"strings"
	"testing"
	"time"
)

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		v, ok := values[key]
		return v, ok
	}
}

func TestParseDefaults(t *testing.T) {
	cfg, err := Parse([]string{"--hub-api-url=https://hub.example:6443"}, lookup(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 8080 || cfg.AuthTokenHeader != DefaultAuthTokenHeader || cfg.AuthUserHeader != DefaultAuthUserHeader || cfg.BackendAddress != DefaultBackendAddress {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.BackendTimeout != 10*time.Second || cfg.BindAddress != DefaultBindAddress || cfg.HubCAFile != "" || cfg.ModelsNamespace != DefaultModelsNamespace || DefaultModelsNamespace != "models-as-a-service" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.TLSEnabled() {
		t.Fatal("TLS should be disabled by default")
	}
	if got := cfg.ListenAddr(); got != "127.0.0.1:8080" {
		t.Fatalf("ListenAddr = %q, the BFF must stay on loopback by default", got)
	}
}

func TestParseInClusterDefaults(t *testing.T) {
	env := map[string]string{"KUBERNETES_SERVICE_HOST": "10.0.0.1", "KUBERNETES_SERVICE_PORT": "443"}
	cfg, err := Parse(nil, lookup(env))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.HubAPIURL != "https://10.0.0.1:443" || cfg.HubCAFile != DefaultHubCAFile {
		t.Fatalf("in-cluster hub defaults: %+v", cfg)
	}
	env["HUB_API_URL"] = "https://hub.example"
	env["HUB_CA_FILE"] = ""
	cfg, err = Parse([]string{"--hub-ca-file=/tmp/ca.crt"}, lookup(env))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.HubAPIURL != "https://hub.example" || cfg.HubCAFile != "/tmp/ca.crt" {
		t.Fatalf("overrides should win: %+v", cfg)
	}
}

func TestParseEnvThenFlags(t *testing.T) {
	env := map[string]string{"PORT": "9000", "BACKEND_ADDRESS": "from-env:1", "LOG_LEVEL": "debug", "BACKEND_TIMEOUT": "3s", "HUB_API_URL": "https://hub.example", "BIND_ADDRESS": "0.0.0.0", "MODELS_NAMESPACE": "team-models"}
	cfg, err := Parse([]string{"--backend-address=from-flag:2"}, lookup(env))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 9000 {
		t.Errorf("Port = %d, want 9000 from env", cfg.Port)
	}
	if cfg.BackendAddress != "from-flag:2" {
		t.Errorf("BackendAddress = %q, flag should win over env", cfg.BackendAddress)
	}
	if cfg.BackendTimeout != 3*time.Second {
		t.Errorf("BackendTimeout = %s", cfg.BackendTimeout)
	}
	if cfg.ListenAddr() != "0.0.0.0:9000" {
		t.Errorf("ListenAddr = %q", cfg.ListenAddr())
	}
	if cfg.ModelsNamespace != "team-models" {
		t.Errorf("ModelsNamespace = %q", cfg.ModelsNamespace)
	}
	if cfg.LogLevel.String() != "DEBUG" {
		t.Errorf("LogLevel = %s", cfg.LogLevel)
	}
}

func TestParsePerses(t *testing.T) {
	hub := "--hub-api-url=https://hub.example"
	cfg, err := Parse([]string{hub}, lookup(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.PersesURL != "" || cfg.PersesTimeout != 30*time.Second {
		t.Fatalf("Monitoring should be off by default with a 30s timeout: %+v", cfg)
	}
	env := map[string]string{
		"PERSES_URL": "https://perses.example:8080", "PERSES_CA_FILE": "/ca.crt", "PERSES_SERVER_NAME": "perses.ns.svc",
		"PERSES_INSECURE": "true", "PERSES_TIMEOUT": "5s", "PERSES_PROJECT": "ai-grid",
	}
	cfg, err = Parse([]string{hub, "--perses-project=from-flag"}, lookup(env))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.PersesURL != "https://perses.example:8080" || cfg.PersesCAFile != "/ca.crt" || cfg.PersesServerName != "perses.ns.svc" ||
		!cfg.PersesInsecure || cfg.PersesTimeout != 5*time.Second || cfg.PersesProject != "from-flag" {
		t.Fatalf("Perses settings from env, flag winning: %+v", cfg)
	}
	if cfg, err := Parse([]string{hub, "--perses-timeout=50s"}, lookup(nil)); err != nil || cfg.PersesTimeout != MaxPersesTimeout {
		t.Fatalf("the longest Perses timeout: %+v, %v", cfg, err)
	}
	if _, err := Parse([]string{hub}, lookup(map[string]string{"PERSES_TIMEOUT": "2m"})); err == nil {
		t.Fatal("PERSES_TIMEOUT past the write timeout should fail")
	}
	// The relay reads one project: a Perses server without one is a configuration error.
	for _, env := range []map[string]string{
		{"PERSES_URL": "https://perses.example:8080"},
		{"PERSES_URL": "https://perses.example:8080", "PERSES_PROJECT": " "},
	} {
		if _, err := Parse([]string{hub}, lookup(env)); err == nil || !strings.Contains(err.Error(), "perses-project") {
			t.Errorf("Parse(%v) = %v, want an error naming perses-project", env, err)
		}
	}
}

// An environment value that doesn't parse fails like the same flag value,
// instead of leaving the default in place (PORT=8o80 used to serve on 8080).
func TestParseRejectsBadEnvValues(t *testing.T) {
	hub := "--hub-api-url=https://hub.example"
	cases := []struct {
		key, value string
	}{
		{"PORT", "8o80"},
		{"PORT", "80.5"},
		{"BACKEND_INSECURE", "yes"},
		{"FAKE_BACKEND", "on"},
		{"PERSES_INSECURE", "maybe"},
		{"BACKEND_TIMEOUT", "10"},
		{"PERSES_TIMEOUT", "90"},
		{"PERSES_TIMEOUT", "thirty seconds"},
	}
	for _, tc := range cases {
		_, err := Parse([]string{hub}, lookup(map[string]string{tc.key: tc.value}))
		if err == nil || !strings.Contains(err.Error(), tc.key) || !strings.Contains(err.Error(), tc.value) {
			t.Errorf("%s=%q: err = %v, want an error naming the variable and its value", tc.key, tc.value, err)
		}
	}
	// Good values of each type still parse.
	cfg, err := Parse([]string{hub}, lookup(map[string]string{"PORT": "9000", "FAKE_BACKEND": "true", "BACKEND_INSECURE": "0", "PERSES_TIMEOUT": "45s"}))
	if err != nil || cfg.Port != 9000 || !cfg.FakeBackend || cfg.BackendInsecure || cfg.PersesTimeout != 45*time.Second {
		t.Fatalf("good env values: %+v, %v", cfg, err)
	}
	// Every bad value is reported, not only the first.
	_, err = Parse([]string{hub}, lookup(map[string]string{"PORT": "x", "FAKE_BACKEND": "y"}))
	if err == nil || !strings.Contains(err.Error(), "PORT") || !strings.Contains(err.Error(), "FAKE_BACKEND") {
		t.Errorf("two bad values: %v", err)
	}
}

// A flag on the command line wins over its environment variable, even one that
// does not parse: only a bad value that would be used is an error.
func TestParseFlagOverridesBadEnvValue(t *testing.T) {
	hub := "--hub-api-url=https://hub.example"
	cases := []struct {
		key, value, flag string
		check            func(Config) bool
	}{
		{"PORT", "invalid", "--port=9000", func(c Config) bool { return c.Port == 9000 }},
		{"BACKEND_INSECURE", "yes", "--backend-insecure=true", func(c Config) bool { return c.BackendInsecure }},
		{"FAKE_BACKEND", "on", "--fake-backend", func(c Config) bool { return c.FakeBackend }},
		{"PERSES_INSECURE", "maybe", "--perses-insecure=false", func(c Config) bool { return !c.PersesInsecure }},
		{"BACKEND_TIMEOUT", "10", "--backend-timeout=3s", func(c Config) bool { return c.BackendTimeout == 3*time.Second }},
		{"PERSES_TIMEOUT", "soon", "--perses-timeout=20s", func(c Config) bool { return c.PersesTimeout == 20*time.Second }},
	}
	for _, tc := range cases {
		env := lookup(map[string]string{tc.key: tc.value})
		cfg, err := Parse([]string{hub, tc.flag}, env)
		if err != nil || !tc.check(cfg) {
			t.Errorf("%s=%q with %s: %+v, %v; want the flag's value", tc.key, tc.value, tc.flag, cfg, err)
		}
		if _, err := Parse([]string{hub}, env); err == nil || !strings.Contains(err.Error(), tc.key) {
			t.Errorf("%s=%q alone: err = %v, want an error naming the variable", tc.key, tc.value, err)
		}
	}
	// A flag hides only its own variable's error.
	_, err := Parse([]string{hub, "--port=9000"}, lookup(map[string]string{"PORT": "x", "FAKE_BACKEND": "y"}))
	if err == nil || strings.Contains(err.Error(), "PORT") || !strings.Contains(err.Error(), "FAKE_BACKEND") {
		t.Errorf("--port with bad PORT and FAKE_BACKEND: %v, want only FAKE_BACKEND's error", err)
	}
}

func TestParseRejectsBadInput(t *testing.T) {
	hub := "--hub-api-url=https://hub.example"
	cases := [][]string{
		{"--port=0", hub},
		{"--cert-file=only-cert", hub},
		{"--auth-token-header=", hub},
		{"--auth-user-header= ", hub},
		{"--backend-address=", hub},
		{"--backend-timeout=0", hub},
		{"--perses-timeout=0", hub},
		{"--perses-timeout=51s", hub},
		{"--log-level=loud", hub},
		{}, // no hub API URL outside a pod
	}
	for _, args := range cases {
		if _, err := Parse(args, lookup(nil)); err == nil {
			t.Errorf("Parse(%v) should fail", args)
		}
	}
}
