// Package users resolves who the caller is and what they may administer.
package users

import (
	"context"
	"fmt"
	"strings"

	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube"
)

// User is the identity shown in the console masthead and used to enable or
// disable administrative actions.
type User struct {
	Username string   `json:"username"`
	Groups   []string `json:"groups"`
	// IsProviderAdmin is true when the caller may patch ManagedClusters, the
	// smallest right that every provider-admin action in the console needs.
	IsProviderAdmin bool `json:"isProviderAdmin"`
}

// ProviderAdminCheck is the access review that defines a provider admin.
var ProviderAdminCheck = authzv1.ResourceAttributes{
	Group:    "cluster.open-cluster-management.io",
	Resource: "managedclusters",
	Verb:     "patch",
}

const serviceAccountPrefix = "system:serviceaccount:"

// Current returns the caller behind the client's token.
func Current(ctx context.Context, c *kube.Client) (*User, error) {
	review, err := c.Kube.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authnv1.SelfSubjectReview{}, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("resolve caller identity: %w", err)
	}
	username := review.Status.UserInfo.Username
	if username == "" {
		return nil, fmt.Errorf("the cluster returned no username for the token")
	}

	isAdmin, err := CanProviderAdmin(ctx, c)
	if err != nil {
		return nil, err
	}

	groups := review.Status.UserInfo.Groups
	if groups == nil {
		groups = []string{}
	}
	return &User{Username: displayName(username), Groups: groups, IsProviderAdmin: isAdmin}, nil
}

// CanProviderAdmin runs the provider-admin access review for the caller.
func CanProviderAdmin(ctx context.Context, c *kube.Client) (bool, error) {
	attrs := ProviderAdminCheck
	sar := &authzv1.SelfSubjectAccessReview{Spec: authzv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &attrs}}
	resp, err := c.Kube.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, sar, metav1.CreateOptions{})
	if err != nil {
		return false, fmt.Errorf("check provider admin access: %w", err)
	}
	return resp.Status.Allowed, nil
}

// displayName shortens service account names to <namespace>/<name>.
func displayName(username string) string {
	if rest, ok := strings.CutPrefix(username, serviceAccountPrefix); ok {
		return strings.Replace(rest, ":", "/", 1)
	}
	return username
}
