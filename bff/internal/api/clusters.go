package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"mime"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
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
	gpu, _ := strconv.Atoi(st.GetCapacity()[CapacityGPU])
	provisioned := labels[LabelProvisioned] == "true"
	if st != nil && st.Provisioning != nil {
		provisioned = st.GetProvisioning() == "Compliant"
	}
	return GridCluster{
		Name:              mc.GetName(),
		AIGridEnabled:     labels[LabelEnabled] == "true",
		Provisioned:       provisioned,
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
		Conditions:        toConditions(st.GetConditions()),
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

// listClusters answers GET /api/v1/clusters?offset=&limit=&filter=, mapped
// like the tenants list: offset and limit as the request's page, `filter` as
// sent (listFilter). The backend returns the clusters by name and counts
// `total` over the whole filtered list, which `meta` carries. Neither backend
// evaluates `filter` yet: the fake answers InvalidArgument (422), and the
// shipped one, which would ignore it, is refused before the call (501, see
// backend.v1Clusters).
func (a *App) listClusters(w http.ResponseWriter, r *http.Request) {
	offset, err := queryInt(r, "offset")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	limit, err := queryInt(r, "limit")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	filter, err := listFilter(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	req := &aigridv1.ListManagedClustersRequest{Filter: filter}
	if offset != nil {
		req.Offset = proto.Int32(int32(*offset))
	}
	if limit != nil {
		req.Limit = proto.Int32(int32(*limit))
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Clusters.ListManagedClusters(ctx, req)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out := make([]GridCluster, 0, len(resp.GetClusters()))
	for _, mc := range resp.GetClusters() {
		out = append(out, toGridCluster(mc))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	total := resp.GetTotal()
	writeList(w, http.StatusOK, out, listMeta(offset, limit, len(out), &total))
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
	setETag(w, mc.GetResourceVersion())
	writeData(w, http.StatusOK, toGridCluster(mc))
}

// fetchCluster reads one cluster with GetManagedCluster (the shipped
// backend's Clusters/Get, v1.go). An older backend that has only the list
// answers Unimplemented; then the list is filtered by name instead, so the
// detail endpoint keeps working there too (the result is the same object
// either way). Remove the fallback once no such backend is deployed.
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
// optional and `null` is the same as absent; a present map replaces the
// stored one as a whole (FieldMask semantics, OSAC's; there are no per-key
// paths), so a client that changes one label sends the `labels` map it
// loaded with that label set, and removes a label by leaving it out. The BFF
// neither merges, compares nor validates the maps: the backend applies them
// under optimistic locking, puts back what the hub owns, refuses a change to
// any key outside `ai-grid/*` and `location`, checks the AI Grid annotations
// it understands (`ai-grid/latitude`, `ai-grid/longitude`) and does not
// write an update that changes nothing. Hub acceptance is not writable here:
// no page needs it, and a mistake would make the hub drop a live site.
type ClusterPatch struct {
	Labels      *map[string]string `json:"labels"`
	Annotations *map[string]string `json:"annotations"`
}

// Field-mask paths of UpdateManagedCluster.
const (
	maskClusterLabels      = "labels"
	maskClusterAnnotations = "annotations"
)

// maxBodyBytes bounds a JSON request body; a patch or a tenant is a handful
// of fields.
const maxBodyBytes = 1 << 20

// requireJSON is the first check of every handler that takes a body (every
// POST, PATCH and PUT): a Content-Type other than application/json
// (parameters such as charset are allowed) is 415, so a cross-site HTML form
// or a text/plain fetch, which a browser sends without a CORS preflight, can
// never write. A PATCH runs it before requireIfMatch, so such a request is
// 415 whatever its other headers say.
func requireJSON(r *http.Request) error {
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		return Errorf(http.StatusUnsupportedMediaType, "request body must be JSON: send Content-Type: application/json")
	}
	return nil
}

// decodeBody reads a JSON request body strictly: requireJSON, then exactly
// one JSON object (not null, an array or a scalar) of at most maxBodyBytes
// bytes with nothing after it, no unknown fields. A body that is too large is
// 413 (also when the excess is after the value); anything else wrong with it
// is 422 with a message that names the problem. The body is fully validated
// before any backend call.
func decodeBody(w http.ResponseWriter, r *http.Request, into any) error {
	if err := requireJSON(r); err != nil {
		return err
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := decodeObject(dec, into); err != nil {
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

// errNotObject is the decode error for a body that is valid JSON but not an
// object; decodeErrorMessage passes its text through.
var errNotObject = errors.New("must be a JSON object")

// decodeObject decodes the next JSON value from dec into `into` and requires it
// to be an object with no unknown fields. A struct target would otherwise take
// a top-level null as "no fields set" (and an empty PATCH answers 200), and an
// array or a scalar would fail with a type message that names no field.
func decodeObject(dec *json.Decoder, into any) error {
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return err
	}
	if len(raw) == 0 || raw[0] != '{' {
		return errNotObject
	}
	strict := json.NewDecoder(bytes.NewReader(raw))
	strict.DisallowUnknownFields()
	return strict.Decode(into)
}

// patchCluster answers PATCH /api/v1/clusters/{name} with one
// UpdateManagedCluster: the present body fields become the object and the
// field mask, the If-Match version (required, requireIfMatch) the object's
// `resource_version` with `lock: true`, so a stale tab or a concurrent
// change is the backend's Aborted, 409. The BFF does not read the cluster
// first. A body that names no field is 422: there is nothing to send, and
// answering it like GET would skip the If-Match check.
func (a *App) patchCluster(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := requireJSON(r); err != nil {
		a.respondError(w, r, err)
		return
	}
	expected, err := requireIfMatch(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var patch ClusterPatch
	if err := decodeBody(w, r, &patch); err != nil {
		a.respondError(w, r, err)
		return
	}
	// An empty map is absent on the wire; the mask path is what tells the
	// backend to clear it.
	obj := &aigridv1.ManagedCluster{Name: name, ResourceVersion: expected}
	var paths []string
	if patch.Labels != nil {
		obj.Labels = *patch.Labels
		paths = append(paths, maskClusterLabels)
	}
	if patch.Annotations != nil {
		obj.Annotations = *patch.Annotations
		paths = append(paths, maskClusterAnnotations)
	}
	if len(paths) == 0 {
		a.respondError(w, r, Errorf(http.StatusUnprocessableEntity, "the request body names no field to change"))
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	updated, err := a.backend.Clusters.UpdateManagedCluster(ctx, &aigridv1.UpdateManagedClusterRequest{
		Object:     obj,
		UpdateMask: &fieldmaskpb.FieldMask{Paths: paths},
		Lock:       true,
	})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	a.log(r).Info("cluster updated", "name", name, "paths", paths)
	setETag(w, updated.GetObject().GetResourceVersion())
	writeData(w, http.StatusOK, toGridCluster(updated.GetObject()))
}

// copyMap is nil-safe: the JSON carries an empty map rather than null when
// the backend sends none.
func copyMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return maps.Clone(m)
}

// decodeErrorMessage keeps the useful part of a JSON decoding error.
// jsonKind names a Go type the way a JSON client knows it ("an object", "a
// string"), so a type error never shows the BFF's internal type names.
func jsonKind(t reflect.Type) string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.Struct, reflect.Map:
		return "an object"
	case reflect.Slice, reflect.Array:
		return "an array"
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "true or false"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "a whole number"
	case reflect.Float32, reflect.Float64:
		return "a number"
	}
	return "a different JSON type"
}

func decodeErrorMessage(err error) string {
	var syntax *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syntax), errors.Is(err, io.ErrUnexpectedEOF):
		return "malformed JSON"
	case errors.As(err, &typ):
		return fmt.Sprintf("field %q must be %s", typ.Field, jsonKind(typ.Type))
	case errors.Is(err, io.EOF):
		return "empty body"
	}
	return err.Error()
}
