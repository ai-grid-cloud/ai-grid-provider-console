package api

import (
	"math"
	"net/http"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// GridOverview is the PoC's GridOverview (shared/grid-monitoring.mjs
// gridOverviewSchema at 62319b8). Demo is always false: the PoC sets it only
// in its browser mock, and the console's fake reports real-shaped inventory
// (the fake-backend banner says the inventory is fixtures).
type GridOverview struct {
	// UpdatedAt is omitted when the backend sends no time; the BFF doesn't
	// invent one.
	UpdatedAt string `json:"updatedAt,omitempty"`
	// InventorySource is "acm" or "git"; omitted when the backend doesn't say.
	InventorySource string `json:"inventorySource,omitempty"`
	Demo            bool   `json:"demo"`
	// MetricsSource is "thanos" or "demo" (simulated, Thanos not configured);
	// omitted when the backend doesn't say.
	MetricsSource string        `json:"metricsSource,omitempty"`
	Clusters      []GridCluster `json:"clusters"`
	Metrics       []GridMetric  `json:"metrics"`
}

// GridMetric is one fleet-wide series of the overview.
type GridMetric struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Unit  string `json:"unit"`
	// Status is "ok", "unavailable", "not-configured" or "no-data"; omitted
	// when the backend doesn't say.
	Status  string        `json:"status,omitempty"`
	Message string        `json:"message,omitempty"`
	Points  []MetricPoint `json:"points"`
}

// MetricPoint is a sample at a Unix time in seconds.
type MetricPoint struct {
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
}

var inventorySources = map[aigridv1.InventorySource]string{
	aigridv1.InventorySource_INVENTORY_SOURCE_ACM: "acm",
	aigridv1.InventorySource_INVENTORY_SOURCE_GIT: "git",
}

var metricsSources = map[aigridv1.MetricsSource]string{
	aigridv1.MetricsSource_METRICS_SOURCE_THANOS: "thanos",
	aigridv1.MetricsSource_METRICS_SOURCE_DEMO:   "demo",
}

var metricStatuses = map[aigridv1.MetricStatus]string{
	aigridv1.MetricStatus_METRIC_STATUS_OK:             "ok",
	aigridv1.MetricStatus_METRIC_STATUS_UNAVAILABLE:    "unavailable",
	aigridv1.MetricStatus_METRIC_STATUS_NOT_CONFIGURED: "not-configured",
	aigridv1.MetricStatus_METRIC_STATUS_NO_DATA:        "no-data",
}

// getGridOverview answers GET /api/v1/grid/overview?range=&site=&metrics=false
// as the PoC's backend does (backend/grid-monitoring.mjs): the range is
// forwarded as given (the backend defaults it to 1h and rejects anything but
// 1h, 6h and 24h), an empty site selects every site, and only metrics=false
// leaves the metrics out.
func (a *App) getGridOverview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	req := &aigridv1.GetOverviewRequest{Range: q.Get("range"), IncludeMetrics: q.Get("metrics") != "false"}
	if site := q.Get("site"); site != "" {
		req.Site = &site
	}

	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Grid.GetOverview(ctx, req)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, toGridOverview(resp))
}

// toGridOverview maps the response to the PoC's JSON, clusters in the
// backend's order. The enums map one to one, and an unspecified one leaves
// its key out. Non-finite values are dropped, because JSON can't encode them
// (the PoC drops them from Thanos results too).
func toGridOverview(resp *aigridv1.GetOverviewResponse) GridOverview {
	out := GridOverview{
		InventorySource: inventorySources[resp.GetInventorySource()],
		MetricsSource:   metricsSources[resp.GetMetricsSource()],
		Clusters:        make([]GridCluster, 0, len(resp.GetClusters())),
		Metrics:         make([]GridMetric, 0, len(resp.GetMetrics())),
	}
	if resp.GetUpdatedAt() != nil {
		out.UpdatedAt = resp.GetUpdatedAt().AsTime().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	for _, mc := range resp.GetClusters() {
		out.Clusters = append(out.Clusters, toGridCluster(mc))
	}
	for _, m := range resp.GetMetrics() {
		gm := GridMetric{Key: m.GetKey(), Label: m.GetLabel(), Unit: m.GetUnit(), Status: metricStatuses[m.GetStatus()],
			Message: m.GetMessage(), Points: make([]MetricPoint, 0, len(m.GetPoints()))}
		for _, p := range m.GetPoints() {
			if v := p.GetValue(); !math.IsNaN(v) && !math.IsInf(v, 0) {
				gm.Points = append(gm.Points, MetricPoint{Timestamp: p.GetTimestamp(), Value: v})
			}
		}
		out.Metrics = append(out.Metrics, gm)
	}
	return out
}
