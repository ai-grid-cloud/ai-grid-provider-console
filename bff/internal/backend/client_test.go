package backend_test

import (
	"context"
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
