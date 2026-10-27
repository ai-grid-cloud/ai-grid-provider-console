// Package perses relays the console's Monitoring page to the hub's Perses server, the way the
// OpenShift AI dashboard relays its Observability page (odh-dashboard packages/observability: the
// browser calls /perses/api only, and the dashboard's backend forwards it with the user's token).
//
// The relay decides nothing about the data: Perses authenticates the caller's token and authorizes
// each project, and its datasource proxy runs the PromQL. What the relay owns is the boundary: only
// the read-only dashboard, datasource and query paths the Perses React components call pass, only
// with GET (and POST for queries, which the Prometheus plugin sends as a form), and of the
// caller's request only their token goes on.
//
// That token does not stop at Perses. With Kubernetes authorization, as the Cluster Observability
// Operator runs it, Perses's datasource proxy sends the caller's Authorization header unchanged to
// the datasource's URL (perses internal/api/impl/proxy, forwardCallerAuthorization). So whoever
// can write a datasource the relay queries, or a dashboard whose own datasources it would query,
// would receive a provider admin's hub token. The relay therefore passes one configured project
// (its dashboards and datasources) and the global datasources only, and never a datasource a
// dashboard defines. The operator must make sure that only provider admins can write that
// project's dashboards and datasources, and that the global datasources point only at the hub's
// own Thanos and Loki.
package perses

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	neturl "net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

// Prefix is where the relay is mounted; the rest of the path is the Perses API path.
const Prefix = "/perses/api"

// MaxBodyBytes bounds a query form. PromQL in a form is a few kilobytes.
const MaxBodyBytes = 1 << 20

// Config locates the Perses server.
type Config struct {
	// URL is the Perses server, for example
	// https://perses.openshift-cluster-observability-operator.svc:8080.
	URL string
	// Project is the one Perses project the relay reads, its dashboards and datasources (with the
	// global datasources). Required: see the package comment for why no other project passes.
	Project string
	// CAFile verifies its certificate; empty uses the system roots.
	CAFile string
	// ServerName overrides the name its certificate must carry, for a port-forward to 127.0.0.1.
	ServerName string
	// Insecure allows plaintext to a non-loopback host. The caller's token travels with every
	// request, so this is for development only.
	Insecure bool
	// Timeout bounds the exchange with Perses, from connecting to the last byte of its answer:
	// past it the relay answers 504, or cuts an answer already started. A browser that stops
	// reading is the server's write timeout's to cut. Zero means 30 seconds.
	Timeout time.Duration
}

// Relay is an http.Handler for the paths under Prefix.
type Relay struct {
	target     *neturl.URL
	timeout    time.Duration
	proxy      *httputil.ReverseProxy
	readPaths  *regexp.Regexp
	queryPaths *regexp.Regexp
}

// New builds a relay. It fails when the URL or the project is not usable or the CA file cannot be
// read.
func New(cfg Config) (*Relay, error) {
	raw := strings.TrimRight(strings.TrimSpace(cfg.URL), "/")
	target, err := neturl.Parse(raw)
	if err != nil || target.Host == "" || (target.Scheme != "https" && target.Scheme != "http") {
		return nil, fmt.Errorf("perses URL %q must be http(s)://host[:port]", cfg.URL)
	}
	if target.Scheme == "http" && !cfg.Insecure && !isLoopbackHost(target.Hostname()) {
		return nil, fmt.Errorf("perses URL %q is plaintext; the caller's token travels with every request, so only https:// is accepted for non-loopback hosts (or allow insecure explicitly)", raw)
	}
	if cfg.Project == "" {
		return nil, errors.New("a Perses project is required: the relay reads one project's dashboards and datasources, and no other")
	}
	if !projectName.MatchString(cfg.Project) || cfg.Project == "." || cfg.Project == ".." {
		return nil, fmt.Errorf("perses project %q must be one path segment of letters, digits, '-', '_' and '.'", cfg.Project)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.ServerName}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read perses CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("perses CA file %s holds no PEM certificate", cfg.CAFile)
		}
		tlsCfg.RootCAs = pool
	}
	transport.TLSClientConfig = tlsCfg

	r := &Relay{target: target, timeout: timeout}
	r.readPaths, r.queryPaths = allowlist(cfg.Project)
	r.proxy = &httputil.ReverseProxy{
		Rewrite:        r.rewrite,
		Transport:      transport,
		ModifyResponse: modifyResponse,
		ErrorHandler:   errorHandler,
	}
	return r, nil
}

// URL is the Perses server the relay forwards to, for the startup log.
func (r *Relay) URL() string { return r.target.String() }

type tokenKey struct{}

// WithToken stores the caller's token for the relay to forward.
func WithToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, tokenKey{}, token)
}

// ServeHTTP relays an allowed request with the caller's token from the context.
func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	apiPath, ok := strings.CutPrefix(req.URL.Path, Prefix)
	if !ok {
		writeError(w, http.StatusNotFound, "the requested resource could not be found")
		return
	}
	if status, msg := r.Allowed(req.Method, apiPath, req.URL.RawPath); status != 0 {
		writeError(w, status, msg)
		return
	}
	if req.Method == http.MethodPost {
		if mt := strings.TrimSpace(strings.SplitN(req.Header.Get("Content-Type"), ";", 2)[0]); !strings.EqualFold(mt, "application/x-www-form-urlencoded") {
			writeError(w, http.StatusUnsupportedMediaType, "a Perses query must be sent as application/x-www-form-urlencoded")
			return
		}
		req.Body = http.MaxBytesReader(w, req.Body, MaxBodyBytes)
	}
	token, _ := req.Context().Value(tokenKey{}).(string)
	if token == "" {
		writeError(w, http.StatusUnauthorized, "missing caller token")
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), r.timeout)
	defer cancel()
	r.proxy.ServeHTTP(&relayWriter{ResponseWriter: w}, req.WithContext(ctx))
}

// relayWriter holds the line modifyResponse draws (only relayedHeaders reach the browser) where
// ReverseProxy writes around ModifyResponse: an informational (1xx) answer, which it forwards with
// Perses's headers (a 103's Link, say) before the final answer exists, and the trailers it copies
// after the body. The console reads neither, so the first is dropped and the second goes nowhere.
type relayWriter struct {
	http.ResponseWriter
	wrote    bool
	trailers http.Header
}

// Header is the response's own until the final status is written, and a map nobody reads after:
// ReverseProxy writes Perses's trailers there.
func (w *relayWriter) Header() http.Header {
	if !w.wrote {
		return w.ResponseWriter.Header()
	}
	if w.trailers == nil {
		w.trailers = http.Header{}
	}
	return w.trailers
}

// WriteHeader drops a 1xx (ReverseProxy clears the headers it set for one itself) and the Trailer
// announcement ReverseProxy adds to the final answer.
func (w *relayWriter) WriteHeader(code int) {
	if code < http.StatusOK || w.wrote {
		return
	}
	w.ResponseWriter.Header().Del("Trailer")
	w.wrote = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *relayWriter) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.ResponseWriter.Write(b)
}

// Unwrap lets ReverseProxy flush the response it streams (http.ResponseController).
func (w *relayWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// forwardedHeaders are the only request headers that reach Perses besides Authorization. Cookies,
// the proxy's identity headers and any client-sent Authorization stay behind. With the browser's
// Accept-Encoding set, Go's transport leaves a compressed answer compressed, so it passes through
// as Perses sent it; without one, the transport asks for gzip itself and decompresses.
var forwardedHeaders = []string{"Accept", "Accept-Encoding", "Accept-Language", "Content-Type"}

func (r *Relay) rewrite(pr *httputil.ProxyRequest) {
	apiPath := strings.TrimPrefix(pr.In.URL.Path, Prefix)
	pr.Out.URL.Scheme = r.target.Scheme
	pr.Out.URL.Host = r.target.Host
	pr.Out.URL.Path = r.target.Path + apiPath
	pr.Out.URL.RawPath = ""
	pr.Out.URL.RawQuery = pr.In.URL.RawQuery
	pr.Out.Host = r.target.Host

	h := http.Header{}
	for _, k := range forwardedHeaders {
		if v := pr.In.Header.Values(k); len(v) > 0 {
			h[http.CanonicalHeaderKey(k)] = v
		}
	}
	token, _ := pr.In.Context().Value(tokenKey{}).(string)
	h.Set("Authorization", "Bearer "+token)
	pr.Out.Header = h
}

// relayedHeaders are the only response headers that reach the browser; the relay adds its own two
// (modifyResponse). Anything else Perses or a datasource behind it sends stays behind: a cookie for
// the console's origin, a CORS grant (the console reads the relay from its own origin, so a grant
// would only open the answers to other sites), a WWW-Authenticate challenge (the browser would ask
// for a password on the console's origin), a Location or Refresh that would send the browser
// elsewhere, a Link to preload, or a header nobody here reads.
//
//   - Content-Type: the Perses client parses an answer by it (client/util/fetch.js).
//   - Content-Encoding and Content-Length: a gzip answer passes through as Perses sent it
//     (forwardedHeaders), and the browser must know to inflate it and how long it is.
//   - Vary: that encoding depends on Accept-Encoding, which the browser's cache must know.
//   - Cache-Control: Perses's and the datasource's own say on caching an answer that holds data,
//     with Date, Age and Expires, from which a cache works out how long that answer stays fresh
//     (RFC 9111, section 4.2): without Age, an answer already a minute old would count as new.
//
// ETag and Last-Modified are left out: the relay forwards no If-None-Match or If-Modified-Since,
// so they could never be used.
var relayedHeaders = []string{"Content-Type", "Content-Encoding", "Content-Length", "Vary", "Cache-Control", "Date", "Age", "Expires"}

// relayedCSP keeps a relayed answer inert if a browser opens it as a page: no script, no
// subresources, a unique origin. The console reads these answers with fetch, which it doesn't affect.
const relayedCSP = "sandbox; default-src 'none'"

// errRedirect is a 3xx from Perses. The relay never forwards one: a Location or Refresh would send
// the browser to wherever Perses or a datasource behind it points, and nothing the console calls
// redirects (the relay sends no conditional request, so not even 304 is expected).
var errRedirect = errors.New("perses answered with a redirect")

// modifyResponse passes only relayedHeaders, and keeps whatever Perses answers (a datasource's error
// page, a label value) from running on the console's origin as HTML or script.
func modifyResponse(resp *http.Response) error {
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return errRedirect
	}
	h := http.Header{}
	for _, k := range relayedHeaders {
		if v := resp.Header.Values(k); len(v) > 0 {
			h[k] = v
		}
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", relayedCSP)
	resp.Header = h
	return nil
}

func errorHandler(w http.ResponseWriter, req *http.Request, err error) {
	var maxBytes *http.MaxBytesError
	var netErr net.Error
	switch {
	case errors.Is(err, errRedirect):
		writeError(w, http.StatusBadGateway, "the hub's Perses answered with a redirect, which the console doesn't follow")
	case errors.As(err, &maxBytes):
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("a Perses query must be at most %d bytes", MaxBodyBytes))
	case errors.Is(err, context.Canceled):
		// The browser went away; nobody reads the answer.
		w.WriteHeader(499)
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		writeError(w, http.StatusGatewayTimeout, "the hub's Perses did not answer in time")
	default:
		writeError(w, http.StatusBadGateway, "the hub's Perses could not be reached; try again")
	}
}

// name is one path segment.
const name = `[^/]+`

// projectName is the shape of Project: one path segment of letters, digits, '-', '_' and '.',
// which Kubernetes namespace names (the Cluster Observability Operator's Perses projects) fit.
var projectName = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)

// allowlist returns the paths the relay passes for one project: readPaths, the Perses API reads
// the dashboard components make, and queryPaths, reads through a datasource's proxy (the
// Prometheus and Loki query APIs only). Both name the project's own dashboards and datasources and
// the global datasources; a datasource a dashboard defines is not among them.
func allowlist(project string) (readPaths, queryPaths *regexp.Regexp) {
	p := regexp.QuoteMeta(project)
	readPaths = regexp.MustCompile(`^/api/v1/(` +
		`projects/` + p + `/dashboards(/` + name + `)?` +
		`|projects/` + p + `/datasources(/` + name + `)?` +
		`|globaldatasources(/` + name + `)?` +
		`)$`)
	queryPaths = regexp.MustCompile(`^/proxy/(` +
		`projects/` + p + `/datasources/` + name +
		`|globaldatasources/` + name +
		`)/(` +
		`api/v1/(query|query_range|query_exemplars|series|labels|label/` + name + `/values|metadata|parse_query|format_query)` +
		`|loki/api/v1/(query|query_range|labels|label/` + name + `/values|series|index/stats|index/volume|index/volume_range|detected_labels|detected_fields|patterns)` +
		`)$`)
	return readPaths, queryPaths
}

// Allowed reports whether a request may be relayed: zero when it may, otherwise the status and
// message to answer with. apiPath is the decoded path after Prefix; rawPath is the request's
// escaped path when it differs from the decoded one.
func (r *Relay) Allowed(method, apiPath, rawPath string) (int, string) {
	// An encoded slash, a dot segment or a doubled slash could make Perses see another path than
	// the one checked here.
	if strings.Contains(strings.ToLower(rawPath), "%2f") || apiPath == "" || path.Clean(apiPath) != apiPath {
		return http.StatusNotFound, "the requested resource could not be found"
	}
	isQuery := r.queryPaths.MatchString(apiPath)
	if !isQuery && !r.readPaths.MatchString(apiPath) {
		return http.StatusNotFound, "the requested resource could not be found"
	}
	switch {
	case method == http.MethodGet:
		return 0, ""
	case method == http.MethodPost && isQuery:
		return 0, ""
	default:
		return http.StatusMethodNotAllowed, "the console reads Perses only"
	}
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// writeError answers in the console's error envelope.
func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	body := map[string]map[string]string{"error": {"code": fmt.Sprint(status), "message": message}}
	_ = json.NewEncoder(w).Encode(body)
}
