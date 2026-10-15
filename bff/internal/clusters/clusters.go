// Package clusters projects ACM ManagedClusters into the console's GridCluster
// view and manages the AI Grid labels on them.
package clusters

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/kube"
)

// ManagedClusterGVR is the ACM ManagedCluster resource (cluster-scoped).
var ManagedClusterGVR = schema.GroupVersionResource{
	Group:    "cluster.open-cluster-management.io",
	Version:  "v1",
	Resource: "managedclusters",
}

// Labels and claims shared with Kris Verlaenen's POC and its Placements.
const (
	LabelEnabled     = "ai-grid/enabled"
	LabelProvisioned = "ai-grid/provisioned"
	LabelLocation    = "location"
	// labelOpenShiftVersion is set by ACM on every OpenShift ManagedCluster.
	labelOpenShiftVersion = "openshiftVersion"

	conditionAvailable = "ManagedClusterConditionAvailable"
	consoleURLClaim    = "consoleurl.cluster.open-cluster-management.io"

	listPageSize = 500
)

// Status values of a GridCluster.
const (
	StatusReady   = "Ready"
	StatusOffline = "Offline"
	StatusUnknown = "Unknown"
)

// Provisioning states of a GridCluster.
const (
	Provisioned    = "Provisioned"
	Provisioning   = "Provisioning"
	NotProvisioned = "Not provisioned"
)

// GridCluster is a ManagedCluster seen through the AI Grid labels.
type GridCluster struct {
	Name               string `json:"name"`
	Status             string `json:"status"`
	AIGridEnabled      bool   `json:"aiGridEnabled"`
	Provisioned        bool   `json:"provisioned"`
	ProvisioningStatus string `json:"provisioningStatus"`
	Location           string `json:"location,omitempty"`
	ConsoleURL         string `json:"consoleUrl,omitempty"`
	OpenShiftVersion   string `json:"openshiftVersion,omitempty"`
	// ResourceVersion lets the frontend send If-Match on later mutations.
	ResourceVersion string `json:"resourceVersion"`
}

// FromUnstructured projects a ManagedCluster.
func FromUnstructured(u *unstructured.Unstructured) GridCluster {
	labels := u.GetLabels()
	enabled := labels[LabelEnabled] == "true"
	provisioned := labels[LabelProvisioned] == "true"

	gc := GridCluster{
		Name:             u.GetName(),
		Status:           StatusUnknown,
		AIGridEnabled:    enabled,
		Provisioned:      provisioned,
		Location:         labels[LabelLocation],
		OpenShiftVersion: labels[labelOpenShiftVersion],
		ResourceVersion:  u.GetResourceVersion(),
	}
	switch {
	case provisioned:
		gc.ProvisioningStatus = Provisioned
	case enabled:
		gc.ProvisioningStatus = Provisioning
	default:
		gc.ProvisioningStatus = NotProvisioned
	}

	conditions, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	for _, raw := range conditions {
		cond, ok := raw.(map[string]any)
		if !ok || cond["type"] != conditionAvailable {
			continue
		}
		switch cond["status"] {
		case "True":
			gc.Status = StatusReady
		case "False":
			gc.Status = StatusOffline
		}
	}

	claims, _, _ := unstructured.NestedSlice(u.Object, "status", "clusterClaims")
	for _, raw := range claims {
		claim, ok := raw.(map[string]any)
		if !ok || claim["name"] != consoleURLClaim {
			continue
		}
		if v, ok := claim["value"].(string); ok {
			gc.ConsoleURL = v
		}
	}
	return gc
}

// EligibleLocation reports whether the cluster can receive model placements.
func (g GridCluster) EligibleLocation() bool {
	return g.Status == StatusReady && g.AIGridEnabled && g.Provisioned && g.Location != "" && len(validation.IsValidLabelValue(g.Location)) == 0
}

// List returns every ManagedCluster the caller may see, sorted by name.
func List(ctx context.Context, c *kube.Client) ([]GridCluster, error) {
	var out []GridCluster
	opts := metav1.ListOptions{Limit: listPageSize}
	for {
		list, err := c.Dynamic.Resource(ManagedClusterGVR).List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list managed clusters: %w", err)
		}
		for i := range list.Items {
			out = append(out, FromUnstructured(&list.Items[i]))
		}
		if list.GetContinue() == "" {
			break
		}
		opts.Continue = list.GetContinue()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if out == nil {
		out = []GridCluster{}
	}
	return out, nil
}

// Get returns one ManagedCluster.
func Get(ctx context.Context, c *kube.Client, name string) (*GridCluster, error) {
	if err := ValidateName(name); err != nil {
		return nil, err
	}
	u, err := c.Dynamic.Resource(ManagedClusterGVR).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get managed cluster %q: %w", name, err)
	}
	gc := FromUnstructured(u)
	return &gc, nil
}

// Update is the PATCH body for a cluster. Absent fields are left untouched.
type Update struct {
	// AIGridEnabled enrols (true) or withdraws (false) the cluster from the grid.
	AIGridEnabled *bool `json:"aiGridEnabled,omitempty"`
	// Location sets the location label; an empty string removes it.
	Location *string `json:"location,omitempty"`
}

// Validate checks the update carries at least one change with valid values.
func (u Update) Validate() error {
	if u.AIGridEnabled == nil && u.Location == nil {
		return &ValidationError{"the request must set aiGridEnabled or location"}
	}
	if u.Location != nil && *u.Location != "" {
		if errs := validation.IsValidLabelValue(*u.Location); len(errs) > 0 {
			return &ValidationError{"location must be a Kubernetes label value: " + strings.Join(errs, "; ")}
		}
	}
	return nil
}

// Patch applies the update as a merge patch on the ManagedCluster labels.
func Patch(ctx context.Context, c *kube.Client, name string, update Update) (*GridCluster, error) {
	if err := ValidateName(name); err != nil {
		return nil, err
	}
	if err := update.Validate(); err != nil {
		return nil, err
	}
	labels := map[string]any{}
	if update.AIGridEnabled != nil {
		labels[LabelEnabled] = fmt.Sprintf("%t", *update.AIGridEnabled)
	}
	if update.Location != nil {
		if *update.Location == "" {
			labels[LabelLocation] = nil
		} else {
			labels[LabelLocation] = *update.Location
		}
	}
	body, err := json.Marshal(map[string]any{"metadata": map[string]any{"labels": labels}})
	if err != nil {
		return nil, fmt.Errorf("encode patch: %w", err)
	}
	u, err := c.Dynamic.Resource(ManagedClusterGVR).Patch(ctx, name, types.MergePatchType, body, metav1.PatchOptions{FieldManager: "ai-grid-provider-console"})
	if err != nil {
		return nil, fmt.Errorf("patch managed cluster %q: %w", name, err)
	}
	gc := FromUnstructured(u)
	return &gc, nil
}

// Locations returns the distinct locations that can receive placements.
func Locations(ctx context.Context, c *kube.Client) ([]string, error) {
	clusters, err := List(ctx, c)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []string{}
	for _, gc := range clusters {
		if gc.EligibleLocation() && !seen[gc.Location] {
			seen[gc.Location] = true
			out = append(out, gc.Location)
		}
	}
	sort.Strings(out)
	return out, nil
}

// ValidateName rejects names that cannot be a ManagedCluster.
func ValidateName(name string) error {
	if errs := validation.IsDNS1123Subdomain(name); len(errs) > 0 {
		return &ValidationError{"invalid cluster name: " + strings.Join(errs, "; ")}
	}
	return nil
}

// ValidationError is a client error that maps to 422.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// HTTPStatus implements the status hint used by the API layer.
func (e *ValidationError) HTTPStatus() int { return http.StatusUnprocessableEntity }
