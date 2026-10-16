package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

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
	// LabelAddonPrefix is the prefix of the labels ACM writes per add-on,
	// valued available|unhealthy|unreachable.
	LabelAddonPrefix = "feature.open-cluster-management.io/addon-"
)

// Annotations the console writes for the map.
const (
	AnnotationSiteName  = "ai-grid/site-name"
	AnnotationLatitude  = "ai-grid/latitude"
	AnnotationLongitude = "ai-grid/longitude"
)

// Cluster claims the console reads (`status.clusterClaims[]`).
const (
	ClaimConsoleURL = "consoleurl.cluster.open-cluster-management.io"
	ClaimPlatform   = "platform.open-cluster-management.io"
	ClaimProduct    = "product.open-cluster-management.io"
	// CapacityGPU is the resource name the NVIDIA device plugin advertises.
	CapacityGPU = "nvidia.com/gpu"
)

// Cluster status strings, lowercase like the ACM console shows them.
const (
	StatusReady         = "ready"
	StatusOffline       = "offline"
	StatusUnknown       = "unknown"
	StatusPendingImport = "pendingimport"
	StatusImporting     = "importing"
	StatusImportFailed  = "importfailed"
	StatusDetaching     = "detaching"
	StatusNotAccepted   = "notaccepted"
)

// GridCluster is a ManagedCluster as the console shows it.
type GridCluster struct {
	Name             string `json:"name"`
	AIGridEnabled    bool   `json:"aiGridEnabled"`
	Provisioned      bool   `json:"provisioned"`
	HubAcceptsClient bool   `json:"hubAcceptsClient"`
	Location         string `json:"location,omitempty"`
	Site             string `json:"site,omitempty"`
	Region           string `json:"region,omitempty"`
	OpenShiftVersion string `json:"openshiftVersion,omitempty"`
	// Status is the lifecycle state the backend derived from the conditions,
	// one of ready|offline|unknown|pendingimport|importing|importfailed|
	// detaching|notaccepted; empty when the backend reports none.
	Status        string `json:"status,omitempty"`
	StatusMessage string `json:"statusMessage,omitempty"`
	// ConsoleURL, KubernetesVersion, Platform and Product come from the
	// claims and the status the agent reports.
	ConsoleURL        string `json:"consoleUrl,omitempty"`
	KubernetesVersion string `json:"kubernetesVersion,omitempty"`
	Platform          string `json:"platform,omitempty"`
	Product           string `json:"product,omitempty"`
	// GPUCapacity is `status.capacity["nvidia.com/gpu"]`, zero when absent.
	// Device plugins advertise GPUs as plain integers; other Kubernetes
	// quantity spellings ("8k", "1e1") are not parsed and read as zero.
	GPUCapacity int `json:"gpuCapacity"`
	// SiteName, Latitude and Longitude come from the `ai-grid/*` annotations.
	SiteName  string   `json:"siteName,omitempty"`
	Latitude  *float64 `json:"latitude,omitempty"`
	Longitude *float64 `json:"longitude,omitempty"`
	// Addons maps an add-on name to available|unhealthy|unreachable.
	Addons          map[string]string  `json:"addons"`
	Conditions      []ClusterCondition `json:"conditions"`
	ResourceVersion string             `json:"resourceVersion,omitempty"`
	Labels          map[string]string  `json:"labels"`
	Annotations     map[string]string  `json:"annotations"`
}

// ClusterCondition is one `status.conditions[]` entry with the Kubernetes
// status spelling (True, False, Unknown). LastTransitionTime is omitted when
// the hub recorded none, rather than shown as the Unix epoch.
type ClusterCondition struct {
	Type               string     `json:"type"`
	Status             string     `json:"status"`
	Reason             string     `json:"reason,omitempty"`
	Message            string     `json:"message,omitempty"`
	LastTransitionTime *time.Time `json:"lastTransitionTime,omitempty"`
}

// stateStrings maps the backend's enum to the ACM console's words.
var stateStrings = map[aigridv1.ManagedClusterState]string{
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE:      StatusReady,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE:    StatusOffline,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN:        StatusUnknown,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING:        StatusPendingImport,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT: StatusPendingImport,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING:      StatusImporting,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORT_FAILED:  StatusImportFailed,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING:      StatusDetaching,
	aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED:   StatusNotAccepted,
}

var conditionStatusStrings = map[aigridv1.ConditionStatus]string{
	aigridv1.ConditionStatus_CONDITION_STATUS_TRUE:        "True",
	aigridv1.ConditionStatus_CONDITION_STATUS_FALSE:       "False",
	aigridv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED: "Unknown",
}

func toGridCluster(mc *aigridv1.ManagedCluster) GridCluster {
	labels := mc.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	annotations := mc.GetAnnotations()
	if annotations == nil {
		annotations = map[string]string{}
	}
	st := mc.GetStatus()
	claims := map[string]string{}
	for _, c := range st.GetClusterClaims() {
		claims[c.GetName()] = c.GetValue()
	}
	addons := map[string]string{}
	for k, v := range labels {
		if name, ok := strings.CutPrefix(k, LabelAddonPrefix); ok && name != "" {
			addons[name] = v
		}
	}
	conditions := make([]ClusterCondition, 0, len(st.GetConditions()))
	for _, c := range st.GetConditions() {
		cond := ClusterCondition{
			Type:    c.GetType(),
			Status:  conditionStatusStrings[c.GetStatus()],
			Reason:  c.GetReason(),
			Message: c.GetMessage(),
		}
		if ts := c.GetLastTransitionTime(); ts != nil {
			t := ts.AsTime().UTC()
			cond.LastTransitionTime = &t
		}
		conditions = append(conditions, cond)
	}
	gpu, _ := strconv.Atoi(st.GetCapacity()[CapacityGPU])
	return GridCluster{
		Name:              mc.GetName(),
		AIGridEnabled:     labels[LabelEnabled] == "true",
		Provisioned:       labels[LabelProvisioned] == "true",
		HubAcceptsClient:  mc.GetHubAcceptsClient(),
		Location:          labels[LabelLocation],
		Site:              labels[LabelSite],
		Region:            labels[LabelRegion],
		OpenShiftVersion:  labels[LabelOpenShiftVersion],
		Status:            stateStrings[st.GetState()],
		StatusMessage:     st.GetStateMessage(),
		ConsoleURL:        claims[ClaimConsoleURL],
		KubernetesVersion: st.GetKubernetesVersion(),
		Platform:          claims[ClaimPlatform],
		Product:           claims[ClaimProduct],
		GPUCapacity:       gpu,
		SiteName:          annotations[AnnotationSiteName],
		Latitude:          parseCoordinate(annotations[AnnotationLatitude], 90),
		Longitude:         parseCoordinate(annotations[AnnotationLongitude], 180),
		Addons:            addons,
		Conditions:        conditions,
		ResourceVersion:   mc.GetResourceVersion(),
		Labels:            labels,
		Annotations:       annotations,
	}
}

// parseCoordinate reads an annotation as a finite number within
// [-limit, limit]; absent or invalid values are omitted rather than shown as
// zero. ParseFloat accepts "NaN" and "Inf", which JSON cannot encode, so they
// are rejected explicitly: one bad annotation must not break the whole list.
func parseCoordinate(s string, limit float64) *float64 {
	if s == "" {
		return nil
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < -limit || v > limit {
		return nil
	}
	return &v
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

// getCluster answers GET /api/v1/clusters/{name}.
func (a *App) getCluster(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	mc, err := a.fetchCluster(ctx, r.PathValue("name"))
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, toGridCluster(mc))
}

// fetchCluster reads one cluster with GetManagedCluster. The shipped backend
// has only ListManagedClusters and answers Unimplemented; then the list is
// filtered by name instead, so the detail endpoint keeps working until the
// backend ships the RPC (the result is the same object either way).
func (a *App) fetchCluster(ctx context.Context, name string) (*aigridv1.ManagedCluster, error) {
	resp, err := a.backend.Clusters.GetManagedCluster(ctx, &aigridv1.GetManagedClusterRequest{Name: name})
	if err == nil {
		return resp.GetObject(), nil
	}
	if status.Code(err) != codes.Unimplemented {
		return nil, err
	}
	list, err := a.backend.Clusters.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{})
	if err != nil {
		return nil, err
	}
	for _, mc := range list.GetClusters() {
		if mc.GetName() == name {
			return mc, nil
		}
	}
	// The backend's own NotFound wording, see mock/research/backend-conventions.md.
	return nil, Errorf(http.StatusNotFound, fmt.Sprintf("object with identifier '%s' not found", name))
}

// ClusterPatch is the body of PATCH /api/v1/clusters/{name}. Every field is
// optional; an absent field is left alone, an empty string removes the label
// or annotation, `null` removes a coordinate.
type ClusterPatch struct {
	AIGridEnabled *bool           `json:"aiGridEnabled"`
	Provisioned   *bool           `json:"provisioned"`
	Location      *string         `json:"location"`
	Site          *string         `json:"site"`
	Region        *string         `json:"region"`
	SiteName      *string         `json:"siteName"`
	Latitude      optionalFloat64 `json:"latitude"`
	Longitude     optionalFloat64 `json:"longitude"`
}

// optionalFloat64 tells apart absent, null and a number.
type optionalFloat64 struct {
	Set   bool
	Valid bool
	Value float64
}

func (o *optionalFloat64) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Valid = false
		return nil
	}
	if err := json.Unmarshal(b, &o.Value); err != nil {
		return err
	}
	o.Valid = true
	return nil
}

// maxBodyBytes bounds a JSON request body; a patch or a tenant is a handful
// of fields.
const maxBodyBytes = 1 << 20

// decodeBody reads a JSON request body strictly, for every handler that takes
// one: exactly one JSON value of at most maxBodyBytes bytes with nothing after
// it, no unknown fields. A body that is too large is 413 (also when the
// excess is after the value); anything else wrong with it is 422 with a
// message that names the problem. The body is fully validated before any
// backend call.
func decodeBody(w http.ResponseWriter, r *http.Request, into any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return Errorf(http.StatusRequestEntityTooLarge, fmt.Sprintf("request body must not exceed %d bytes", maxBodyBytes))
		}
		return Errorf(http.StatusUnprocessableEntity, fmt.Sprintf("invalid request body: %s", decodeErrorMessage(err)))
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return Errorf(http.StatusRequestEntityTooLarge, fmt.Sprintf("request body must not exceed %d bytes", maxBodyBytes))
		}
		return Errorf(http.StatusUnprocessableEntity, "invalid request body: unexpected content after the JSON object")
	}
	return nil
}

// patchCluster answers PATCH /api/v1/clusters/{name}: reads the cluster,
// applies the patch to its labels and annotations and writes them back with
// `UpdateManagedCluster` under optimistic locking, so a concurrent change on
// the hub surfaces as 409 instead of being overwritten.
func (a *App) patchCluster(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var patch ClusterPatch
	if err := decodeBody(w, r, &patch); err != nil {
		a.respondError(w, r, err)
		return
	}
	if patch.Latitude.Valid && (patch.Latitude.Value < -90 || patch.Latitude.Value > 90) {
		a.respondError(w, r, Errorf(http.StatusUnprocessableEntity, "latitude must be between -90 and 90"))
		return
	}
	if patch.Longitude.Valid && (patch.Longitude.Value < -180 || patch.Longitude.Value > 180) {
		a.respondError(w, r, Errorf(http.StatusUnprocessableEntity, "longitude must be between -180 and 180"))
		return
	}

	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	current, err := a.backend.Clusters.GetManagedCluster(ctx, &aigridv1.GetManagedClusterRequest{Name: name})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	obj := current.GetObject()
	labels := copyMap(obj.GetLabels())
	annotations := copyMap(obj.GetAnnotations())
	var paths []string

	setBool := func(m map[string]string, key string, v *bool) bool {
		if v == nil {
			return false
		}
		m[key] = strconv.FormatBool(*v)
		return true
	}
	setString := func(m map[string]string, key string, v *string) bool {
		if v == nil {
			return false
		}
		if *v == "" {
			delete(m, key)
		} else {
			m[key] = *v
		}
		return true
	}
	setCoord := func(m map[string]string, key string, v optionalFloat64) bool {
		if !v.Set {
			return false
		}
		if v.Valid {
			m[key] = strconv.FormatFloat(v.Value, 'f', -1, 64)
		} else {
			delete(m, key)
		}
		return true
	}
	labelsChanged := setBool(labels, LabelEnabled, patch.AIGridEnabled)
	labelsChanged = setBool(labels, LabelProvisioned, patch.Provisioned) || labelsChanged
	labelsChanged = setString(labels, LabelLocation, patch.Location) || labelsChanged
	labelsChanged = setString(labels, LabelSite, patch.Site) || labelsChanged
	labelsChanged = setString(labels, LabelRegion, patch.Region) || labelsChanged
	annotationsChanged := setString(annotations, AnnotationSiteName, patch.SiteName)
	annotationsChanged = setCoord(annotations, AnnotationLatitude, patch.Latitude) || annotationsChanged
	annotationsChanged = setCoord(annotations, AnnotationLongitude, patch.Longitude) || annotationsChanged
	if labelsChanged {
		paths = append(paths, "labels")
	}
	if annotationsChanged {
		paths = append(paths, "annotations")
	}
	if len(paths) == 0 {
		// Nothing to change: answer with the current object, no write.
		writeData(w, http.StatusOK, toGridCluster(obj))
		return
	}

	updated, err := a.backend.Clusters.UpdateManagedCluster(ctx, &aigridv1.UpdateManagedClusterRequest{
		Object: &aigridv1.ManagedCluster{
			Name:            name,
			ResourceVersion: obj.GetResourceVersion(),
			Labels:          labels,
			Annotations:     annotations,
		},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: paths},
		Lock:       true,
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	a.logger.Info("cluster updated", "name", name, "paths", paths)
	writeData(w, http.StatusOK, toGridCluster(updated.GetObject()))
}

// copyMap is nil-safe: the patch needs a map to write into even when the
// hub object has none.
func copyMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return maps.Clone(m)
}

// decodeErrorMessage keeps the useful part of a JSON decoding error.
func decodeErrorMessage(err error) string {
	var syntax *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syntax), errors.Is(err, io.ErrUnexpectedEOF):
		return "malformed JSON"
	case errors.As(err, &typ):
		return fmt.Sprintf("field %q must be a %s", typ.Field, typ.Type)
	case errors.Is(err, io.EOF):
		return "empty body"
	}
	return err.Error()
}
