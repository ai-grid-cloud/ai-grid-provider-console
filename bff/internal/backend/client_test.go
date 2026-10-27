package backend_test

import (
	"context"
	"net/url"
	"strings"
	"testing"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
)

func TestDialValidation(t *testing.T) {
	if _, err := backend.Dial(backend.Config{}); err == nil {
		t.Fatal("empty address accepted")
	}
	if _, err := backend.Dial(backend.Config{Address: "127.0.0.1:9090", CAFile: "/nonexistent/ca.crt"}); err == nil || !strings.Contains(err.Error(), "backend CA") {
		t.Fatalf("missing CA file not reported: %v", err)
	}
	if _, err := backend.Dial(backend.Config{Address: "ai-grid-backend.ai-grid.svc:8080"}); err == nil || !strings.Contains(err.Error(), "not loopback") {
		t.Fatalf("plaintext to a remote host accepted: %v", err)
	}
	for _, addr := range []string{"127.0.0.1:9090", "localhost:9090", "[::1]:9090"} {
		c, err := backend.Dial(backend.Config{Address: addr})
		if err != nil {
			t.Fatalf("loopback %s rejected: %v", addr, err)
		}
		_ = c.Close()
	}
	c, err := backend.Dial(backend.Config{Address: "ai-grid-backend.ai-grid.svc:8080", Insecure: true})
	if err != nil {
		t.Fatalf("explicit insecure rejected: %v", err)
	}
	_ = c.Close()
}

func TestForwardsIdentity(t *testing.T) {
	fake := &backendtest.Fake{}
	client := backendtest.Start(t, fake)

	h := identity.Headers{User: "u", Email: "e", Groups: "g", Token: "t"}
	id, err := h.Extract(map[string][]string{"U": {"alice"}, "E": {"a@x"}, "G": {"one,two"}, "T": {"tok"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := client.Context(identity.WithIdentity(context.Background(), id))
	defer cancel()
	if _, err := client.Health.Ping(ctx, &aigridv1.PingRequest{Name: "bff"}); err != nil {
		t.Fatal(err)
	}
	got := func(k string) string { return strings.Join(fake.Metadata.Get(k), "|") }
	if got(backend.MetaAuthorization) != "Bearer tok" || got(backend.MetaUser) != "alice" || got(backend.MetaEmail) != "a@x" || got(backend.MetaGroups) != "one,two" {
		t.Fatalf("metadata = %v", fake.Metadata)
	}

	// No identity: nothing forwarded.
	ctx2, cancel2 := client.Context(context.Background())
	defer cancel2()
	if _, err := client.Health.Ping(ctx2, &aigridv1.PingRequest{}); err != nil {
		t.Fatal(err)
	}
	if got(backend.MetaAuthorization) != "" {
		t.Fatalf("authorization forwarded without identity: %v", fake.Metadata)
	}
}

// grpc-go refuses a metadata value that is not printable ASCII, so a proxy
// header with an accented name used to fail every RPC. The BFF percent-encodes
// the identity values, and plain percent-decoding gives them back.
func TestForwardsNonASCIIIdentity(t *testing.T) {
	fake := &backendtest.Fake{}
	client := backendtest.Start(t, fake)

	h := identity.Headers{User: "u", Email: "e", Groups: "g", Token: "t"}
	id, err := h.Extract(map[string][]string{"U": {"rené"}, "E": {"rené@exämple.com"}, "G": {"équipe-ops,100%-admins,plain"}, "T": {"tok"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := client.Context(identity.WithIdentity(context.Background(), id))
	defer cancel()
	if _, err := client.Health.Ping(ctx, &aigridv1.PingRequest{Name: "bff"}); err != nil {
		t.Fatalf("an accented identity must reach the backend: %v", err)
	}
	decoded := func(k string) string {
		t.Helper()
		values := fake.Metadata.Get(k)
		if len(values) != 1 {
			t.Fatalf("%s = %q, want one value", k, values)
		}
		var parts []string
		for p := range strings.SplitSeq(values[0], ",") {
			v, err := url.PathUnescape(p)
			if err != nil {
				t.Fatalf("%s value %q does not percent-decode: %v", k, values[0], err)
			}
			parts = append(parts, v)
		}
		return strings.Join(parts, ",")
	}
	if got := decoded(backend.MetaUser); got != "rené" {
		t.Errorf("user = %q", got)
	}
	if got := decoded(backend.MetaEmail); got != "rené@exämple.com" {
		t.Errorf("email = %q", got)
	}
	if got := decoded(backend.MetaGroups); got != "équipe-ops,100%-admins,plain" {
		t.Errorf("groups = %q", got)
	}
	if raw := fake.Metadata.Get(backend.MetaGroups)[0]; raw != "%C3%A9quipe-ops,100%25-admins,plain" {
		t.Errorf("raw groups = %q, want each group percent-encoded and ASCII left alone", raw)
	}
}

func TestEncodeMetadataValue(t *testing.T) {
	cases := map[string]string{
		"":                       "",
		"alice":                  "alice",
		"system:authenticated":   "system:authenticated",
		"a b~!*'()+=&?/":         "a b~!*'()+=&?/",
		"rené":                   "ren%C3%A9",
		"100%":                   "100%25",
		"tab\there":              "tab%09here",
		"del\x7f":                "del%7F",
		"\xff":                   "%FF",
		"日本":                     "%E6%97%A5%E6%9C%AC",
		"already%C3%A9-escaped?": "already%25C3%25A9-escaped?",
	}
	for in, want := range cases {
		got := backend.EncodeMetadataValue(in)
		if got != want {
			t.Errorf("EncodeMetadataValue(%q) = %q, want %q", in, got, want)
		}
		if back, err := url.PathUnescape(got); err != nil || back != in {
			t.Errorf("PathUnescape(%q) = %q, %v; want %q", got, back, err, in)
		}
	}
}
