package api

import (
	"fmt"
	"net/http"
	"sort"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Labels on a ManagedCluster that the console reads. They are the conventions
// from the provider portal POC: `ai-grid/*` marks grid membership and site
// identity, `location` drives model placement.
const (
	LabelEnabled     = "ai-grid/enabled"
	LabelProvisioned = "ai-grid/provisioned"
	LabelLocation    = "location"
	LabelSite        = "ai-grid/site"
	LabelRegion      = "ai-grid/region"
	// LabelOpenShiftVersion is set by ACM on every ManagedCluster.
	LabelOpenShiftVersion = "openshiftVersion"
)

// GridCluster is a ManagedCluster as the console shows it.
type GridCluster struct {
	Name             string            `json:"name"`
	AIGridEnabled    bool              `json:"aiGridEnabled"`
	Provisioned      bool              `json:"provisioned"`
	HubAcceptsClient bool              `json:"hubAcceptsClient"`
	Location         string            `json:"location,omitempty"`
	Site             string            `json:"site,omitempty"`
	Region           string            `json:"region,omitempty"`
	OpenShiftVersion string            `json:"openshiftVersion,omitempty"`
	Labels           map[string]string `json:"labels"`
}

func toGridCluster(mc *aigridv1.ManagedCluster) GridCluster {
	labels := mc.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	return GridCluster{
		Name:             mc.GetName(),
		AIGridEnabled:    labels[LabelEnabled] == "true",
		Provisioned:      labels[LabelProvisioned] == "true",
		HubAcceptsClient: mc.GetHubAcceptsClient(),
		Location:         labels[LabelLocation],
		Site:             labels[LabelSite],
		Region:           labels[LabelRegion],
		OpenShiftVersion: labels[LabelOpenShiftVersion],
		Labels:           labels,
	}
}

func (a *App) fetchClusters(r *http.Request) ([]GridCluster, error) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Clusters.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]GridCluster, 0, len(resp.GetClusters()))
	for _, mc := range resp.GetClusters() {
		out = append(out, toGridCluster(mc))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// listClusters answers GET /api/v1/clusters.
func (a *App) listClusters(w http.ResponseWriter, r *http.Request) {
	out, err := a.fetchClusters(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, out)
}

// getCluster answers GET /api/v1/clusters/{name}. The backend has no Get RPC
// yet, so this filters the list.
func (a *App) getCluster(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	out, err := a.fetchClusters(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	for _, c := range out {
		if c.Name == name {
			writeData(w, http.StatusOK, c)
			return
		}
	}
	a.respondError(w, r, Errorf(http.StatusNotFound, fmt.Sprintf("cluster %q not found", name)))
}
