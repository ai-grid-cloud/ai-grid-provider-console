// Package hub asks the hub's Kubernetes API one question on the caller's
// behalf: may this user do X? It is the only place the BFF talks to the hub,
// and it does so with the caller's own token, so the hub's RBAC answers, not a
// credential of the console. Everything else on the hub is the backend's job.
package hub

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"strings"
	"time"
)

// NonResourceAttributes names the action an access review asks about: a verb
// on a path that is no API resource.
type NonResourceAttributes struct {
	Path string `json:"path"`
	Verb string `json:"verb"`
}

// ProviderAdminCheck defines a provider admin: someone the hub's RBAC lets
// post to /ai-grid/provider-console, a non-resource URL that exists only to
// say so. No server serves that path; RBAC grants it anyway, and `oc auth
// can-i post /ai-grid/provider-console` asks the same question. The chart's
// ai-grid-provider-admin ClusterRole holds exactly this rule; so does any role
// with a `*` nonResourceURLs rule for post or every verb, such as
// cluster-admin. The verb is post, not get: OpenShift's cluster-reader grants
// get on every non-resource URL. It must be the console's own right, not one
// borrowed from ACM: ACM binds patch on ManagedClusters to every authenticated
// user (the open-cluster-management:hypershift-addon:agent
// ClusterRoleBinding), so that question admitted anyone who could log in.
var ProviderAdminCheck = NonResourceAttributes{
	Path: "/ai-grid/provider-console",
	Verb: "post",
}

// ErrUnauthorized reports that the hub rejected the caller's token.
var ErrUnauthorized = errors.New("the hub rejected the token")

// Client posts SelfSubjectAccessReviews to one API server.
type Client struct {
	baseURL string
	http    *http.Client
}

// maxIdleConnsPerHost is how many connections to the hub stay open for reuse.
const maxIdleConnsPerHost = 16

// Config locates the API server.
type Config struct {
	// URL is the API server, for example https://10.0.0.1:443.
	URL string
	// CAFile verifies its certificate; empty uses the system roots.
	CAFile string
	// Timeout bounds one review. Zero means 5 seconds.
	Timeout time.Duration
}

// New builds a client. It fails when the CA file cannot be read.
func New(cfg Config) (*Client, error) {
	url := strings.TrimRight(strings.TrimSpace(cfg.URL), "/")
	if url == "" {
		return nil, errors.New("hub API URL must not be empty")
	}
	// The caller's token travels with every review, so plaintext is only
	// acceptable to loopback (a local proxy or a test server).
	if !strings.HasPrefix(url, "https://") {
		if !strings.HasPrefix(url, "http://") {
			return nil, fmt.Errorf("hub API URL %q must start with https://", url)
		}
		if !isLoopback(url) {
			return nil, fmt.Errorf("hub API URL %q is plaintext; only https:// is accepted for non-loopback hosts", url)
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// One page fires 3 to 7 API calls at once, each with its own access review
	// to the one hub; the default 2 idle connections per host would make most
	// of them open a new TLS connection every time.
	transport.MaxIdleConnsPerHost = maxIdleConnsPerHost
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read hub CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("hub CA %s holds no certificates", cfg.CAFile)
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Client{baseURL: url, http: &http.Client{Transport: transport, Timeout: timeout}}, nil
}

// isLoopback reports whether an http:// URL points at the local machine.
func isLoopback(rawURL string) bool {
	u, err := neturl.Parse(rawURL)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// URL returns the API server the client talks to.
func (c *Client) URL() string { return c.baseURL }

type accessReview struct {
	APIVersion string           `json:"apiVersion"`
	Kind       string           `json:"kind"`
	Spec       accessReviewSpec `json:"spec"`
	Status     struct {
		Allowed bool   `json:"allowed"`
		Reason  string `json:"reason"`
	} `json:"status"`
}

type accessReviewSpec struct {
	NonResourceAttributes NonResourceAttributes `json:"nonResourceAttributes"`
}

// CanI runs a SelfSubjectAccessReview with the caller's token. The token is
// sent to the hub only; it never appears in errors or logs.
func (c *Client) CanI(ctx context.Context, token string, attrs NonResourceAttributes) (bool, error) {
	if token == "" {
		return false, ErrUnauthorized
	}
	body, err := json.Marshal(accessReview{
		APIVersion: "authorization.k8s.io/v1",
		Kind:       "SelfSubjectAccessReview",
		Spec:       accessReviewSpec{NonResourceAttributes: attrs},
	})
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return false, fmt.Errorf("access review: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return false, ErrUnauthorized
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return false, fmt.Errorf("access review: hub answered %s", resp.Status)
	}
	var out accessReview
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return false, fmt.Errorf("access review: decode response: %w", err)
	}
	return out.Status.Allowed, nil
}
