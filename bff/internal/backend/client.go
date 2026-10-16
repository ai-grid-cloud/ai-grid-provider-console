// Package backend holds the gRPC connection to ai-grid-backend.
//
// The backend owns every interaction with the hub, Keycloak and metrics. The
// BFF only translates its RPCs into the JSON the frontend uses and forwards the
// caller's identity in request metadata so the backend can authorize.
package backend

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
)

// Metadata keys the BFF sets on every outgoing RPC.
const (
	MetaAuthorization = "authorization"
	MetaUser          = "x-forwarded-user"
	MetaEmail         = "x-forwarded-email"
	MetaGroups        = "x-forwarded-groups"
)

// Config describes how to reach the backend.
type Config struct {
	// Address is host:port. In the single-pod deployment it is the loopback
	// address of the backend container.
	Address string
	// CAFile enables TLS with this CA. Empty means plaintext, which Dial only
	// accepts for loopback addresses unless Insecure is set.
	CAFile string
	// Insecure allows plaintext to a non-loopback address (development only).
	Insecure bool
	// ServerName overrides the expected TLS server name.
	ServerName string
	// Timeout bounds every RPC.
	Timeout time.Duration
}

// Client wraps the generated service clients.
type Client struct {
	conn          *grpc.ClientConn
	timeout       time.Duration
	Health        aigridv1.AiGridClient
	Clusters      aigridv1.ManagedClustersClient
	Tenants       aigridv1.TenantsClient
	Models        aigridv1.ModelsClient
	Subscriptions aigridv1.SubscriptionsClient
}

// Dial creates the connection. It does not connect until the first RPC, so a
// backend that starts later than the BFF is fine. Extra options are for tests.
func Dial(cfg Config, extra ...grpc.DialOption) (*Client, error) {
	if strings.TrimSpace(cfg.Address) == "" {
		return nil, fmt.Errorf("backend address must not be empty")
	}
	creds := insecure.NewCredentials()
	if cfg.CAFile == "" && !cfg.Insecure && !isLoopback(cfg.Address) {
		return nil, fmt.Errorf("backend address %s is not loopback: set a CA file for TLS or allow insecure explicitly", cfg.Address)
	}
	if cfg.CAFile != "" {
		tls, err := credentials.NewClientTLSFromFile(cfg.CAFile, cfg.ServerName)
		if err != nil {
			return nil, fmt.Errorf("load backend CA: %w", err)
		}
		creds = tls
	}
	opts := append([]grpc.DialOption{
		grpc.WithTransportCredentials(creds),
		grpc.WithUnaryInterceptor(forwardIdentity),
	}, extra...)
	conn, err := grpc.NewClient(cfg.Address, opts...)
	if err != nil {
		return nil, fmt.Errorf("connect to backend %s: %w", cfg.Address, err)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{
		conn:          conn,
		timeout:       timeout,
		Health:        aigridv1.NewAiGridClient(conn),
		Clusters:      aigridv1.NewManagedClustersClient(conn),
		Tenants:       aigridv1.NewTenantsClient(conn),
		Models:        aigridv1.NewModelsClient(conn),
		Subscriptions: aigridv1.NewSubscriptionsClient(conn),
	}, nil
}

// isLoopback reports whether a host:port target names the local machine.
func isLoopback(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// Close releases the connection.
func (c *Client) Close() error { return c.conn.Close() }

// Context bounds an RPC with the configured timeout.
func (c *Client) Context(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, c.timeout)
}

// forwardIdentity copies the caller's identity from the context into gRPC
// metadata. Requests without an identity (the readiness probe) carry none.
func forwardIdentity(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	if id, ok := identity.FromContext(ctx); ok {
		pairs := []string{MetaAuthorization, "Bearer " + id.Token()}
		if id.Username != "" {
			pairs = append(pairs, MetaUser, id.Username)
		}
		if id.Email != "" {
			pairs = append(pairs, MetaEmail, id.Email)
		}
		if len(id.Groups) > 0 {
			pairs = append(pairs, MetaGroups, strings.Join(id.Groups, ","))
		}
		ctx = metadata.AppendToOutgoingContext(ctx, pairs...)
	}
	return invoker(ctx, method, req, reply, cc, opts...)
}
