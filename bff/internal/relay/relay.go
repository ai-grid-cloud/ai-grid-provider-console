// Package relay terminates the Connect protocol from the browser and forwards each call to
// the backend over gRPC.
//
// The browser cannot speak gRPC (no HTTP/2 trailers), so something has to translate. The BFF
// is where that happens: it already holds the caller's identity from the proxy headers and
// already dials the backend over loopback, and keeping the translation here means the console
// does not wait for the backend to serve Connect itself
// (docs/adr/0002-connect-end-to-end-with-vanguard-for-rest.md,
// docs/adr/0004-the-bff-is-a-thin-relay.md).
//
// The relay decides nothing. It copies the caller's identity onto the outgoing call and
// returns whatever the backend answered, errors included: a connect.Error carries the
// backend's code and message through unchanged.
//
// One type per service, because the services share method names (both Clusters and Tenants
// have List) and one struct cannot implement both handler interfaces.
package relay

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/contract/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/contract/ai_grid/v1/ai_gridv1connect"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
)

// Header names the backend reads the caller's identity from. They match the gRPC metadata
// keys internal/backend sends, because Connect carries headers as metadata over gRPC.
const (
	headerAuthorization = "Authorization"
	headerUser          = "X-Forwarded-User"
	headerEmail         = "X-Forwarded-Email"
	headerGroups        = "X-Forwarded-Groups"
)

// Relay serves the Connect handlers for every service the backend provides.
type Relay struct {
	aiGrid   *aiGridRelay
	clusters *clustersRelay
	tenants  *tenantsRelay
}

// New builds a relay that forwards to the backend's gRPC endpoint at address. The default
// client speaks plaintext HTTP/2, which is what the backend on the pod's loopback speaks; a
// caller that needs TLS passes its own.
func New(address string, httpClient connect.HTTPClient) *Relay {
	if httpClient == nil {
		httpClient = h2cClient()
	}
	url := "http://" + address
	// WithGRPC: the backend speaks gRPC. The browser speaks Connect to us.
	opts := []connect.ClientOption{connect.WithGRPC(), connect.WithInterceptors(forwardIdentity())}
	return &Relay{
		aiGrid:   &aiGridRelay{client: ai_gridv1connect.NewAiGridClient(httpClient, url, opts...)},
		clusters: &clustersRelay{client: ai_gridv1connect.NewClustersClient(httpClient, url, opts...)},
		tenants:  &tenantsRelay{client: ai_gridv1connect.NewTenantsClient(httpClient, url, opts...)},
	}
}

// Handlers returns one path and handler per service, ready to mount on a ServeMux. Each path
// is the Connect convention, "/<package>.<Service>/".
func (r *Relay) Handlers(opts ...connect.HandlerOption) map[string]http.Handler {
	out := make(map[string]http.Handler, 3)
	for _, reg := range []func() (string, http.Handler){
		func() (string, http.Handler) { return ai_gridv1connect.NewAiGridHandler(r.aiGrid, opts...) },
		func() (string, http.Handler) { return ai_gridv1connect.NewClustersHandler(r.clusters, opts...) },
		func() (string, http.Handler) { return ai_gridv1connect.NewTenantsHandler(r.tenants, opts...) },
	} {
		path, handler := reg()
		out[path] = handler
	}
	return out
}

// forwardIdentity copies the caller's identity from the context onto the outgoing request, as
// internal/backend does for gRPC. A request without an identity carries none, which is what
// the readiness probe sends.
func forwardIdentity() connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			id, ok := identity.FromContext(ctx)
			if !ok {
				return next(ctx, req)
			}
			h := req.Header()
			h.Set(headerAuthorization, "Bearer "+id.Token())
			if id.Username != "" {
				h.Set(headerUser, id.Username)
			}
			if id.Email != "" {
				h.Set(headerEmail, id.Email)
			}
			if len(id.Groups) > 0 {
				h.Set(headerGroups, strings.Join(id.Groups, ","))
			}
			return next(ctx, req)
		}
	}
}

// h2cClient dials plaintext HTTP/2, which is what a gRPC server on loopback speaks.
func h2cClient() *http.Client {
	return &http.Client{Transport: &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, addr)
		},
	}}
}

type aiGridRelay struct{ client ai_gridv1connect.AiGridClient }

func (s *aiGridRelay) Ping(ctx context.Context, req *connect.Request[aigridv1.AiGridPingRequest]) (*connect.Response[aigridv1.AiGridPingResponse], error) {
	return s.client.Ping(ctx, connect.NewRequest(req.Msg))
}

type clustersRelay struct{ client ai_gridv1connect.ClustersClient }

func (s *clustersRelay) List(ctx context.Context, req *connect.Request[aigridv1.ClustersListRequest]) (*connect.Response[aigridv1.ClustersListResponse], error) {
	return s.client.List(ctx, connect.NewRequest(req.Msg))
}

func (s *clustersRelay) Get(ctx context.Context, req *connect.Request[aigridv1.ClustersGetRequest]) (*connect.Response[aigridv1.ClustersGetResponse], error) {
	return s.client.Get(ctx, connect.NewRequest(req.Msg))
}

func (s *clustersRelay) Create(ctx context.Context, req *connect.Request[aigridv1.ClustersCreateRequest]) (*connect.Response[aigridv1.ClustersCreateResponse], error) {
	return s.client.Create(ctx, connect.NewRequest(req.Msg))
}

func (s *clustersRelay) Update(ctx context.Context, req *connect.Request[aigridv1.ClustersUpdateRequest]) (*connect.Response[aigridv1.ClustersUpdateResponse], error) {
	return s.client.Update(ctx, connect.NewRequest(req.Msg))
}

func (s *clustersRelay) Delete(ctx context.Context, req *connect.Request[aigridv1.ClustersDeleteRequest]) (*connect.Response[aigridv1.ClustersDeleteResponse], error) {
	return s.client.Delete(ctx, connect.NewRequest(req.Msg))
}

type tenantsRelay struct{ client ai_gridv1connect.TenantsClient }

func (s *tenantsRelay) List(ctx context.Context, req *connect.Request[aigridv1.TenantsListRequest]) (*connect.Response[aigridv1.TenantsListResponse], error) {
	return s.client.List(ctx, connect.NewRequest(req.Msg))
}

var (
	_ ai_gridv1connect.AiGridHandler   = (*aiGridRelay)(nil)
	_ ai_gridv1connect.ClustersHandler = (*clustersRelay)(nil)
	_ ai_gridv1connect.TenantsHandler  = (*tenantsRelay)(nil)
)
