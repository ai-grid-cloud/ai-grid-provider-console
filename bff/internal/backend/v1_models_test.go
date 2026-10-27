package backend

import (
	"context"
	"slices"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const modelsNS = "models-as-a-service"

var modelCreated = timestamppb.New(time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC))

// v1Model is a stored model placed on two clusters, as the backend answers it.
func v1Model() *backendv1.Model {
	return &backendv1.Model{
		Id: "granite",
		Metadata: &backendv1.Metadata{
			Name: "granite", Version: 3, CreationTimestamp: modelCreated,
			Labels: map[string]string{"k": "v"}, Annotations: map[string]string{annotationDisplayName: "Granite"},
		},
		Spec: &backendv1.ModelSpec{
			Model:    &backendv1.ModelSource{Uri: "hf://ibm/granite", Name: "granite"},
			Replicas: proto.Int32(1),
			BaseRefs: []string{"preset"},
			Router:   &backendv1.ModelRouter{ManagedRoute: true, GatewayRefs: []*backendv1.ModelGatewayRef{{Name: "gw", Namespace: "openshift-ingress"}}},
			Main: &backendv1.ModelContainer{
				Image: "vllm", Requests: map[string]string{"cpu": "2"}, Limits: map[string]string{"memory": "8Gi"},
				Env: []*backendv1.ModelEnvVar{{Name: "VLLM_ADDITIONAL_ARGS", Value: "--x"}},
			},
			Placement: &backendv1.ModelPlacement{LabelSelector: &backendv1.ModelLabelSelector{
				MatchExpressions: []*backendv1.ModelLabelSelectorRequirement{{Key: "name", Operator: "In", Values: []string{"site-b", "site-a"}}},
			}},
		},
		Status: &backendv1.ModelStatus{
			Phase: backendv1.ModelPhase_MODEL_PHASE_PENDING, Reason: "SavedToGit",
			Placement: &backendv1.ModelPlacementStatus{NumberOfSelectedClusters: 2, SelectedClusters: []string{"site-b", "site-a"}},
		},
	}
}

// draftModel is v1Model in the draft, as the console reads it.
func draftModel() *aigridv1.Model {
	return &aigridv1.Model{
		Name: "granite",
		Metadata: &aigridv1.ObjectMeta{
			Namespace: modelsNS, ResourceVersion: "3", CreationTimestamp: modelCreated,
			Labels: map[string]string{"k": "v"}, Annotations: map[string]string{annotationDisplayName: "Granite"},
		},
		Spec: &aigridv1.ModelSpec{
			Model:    &aigridv1.ModelSource{Uri: "hf://ibm/granite", Name: "granite"},
			Replicas: proto.Int32(1),
			BaseRefs: []string{"preset"},
			Router:   &aigridv1.Router{ManagedRoute: true, GatewayRefs: []*aigridv1.GatewayRef{{Name: "gw", Namespace: "openshift-ingress"}}},
			Main: &aigridv1.Container{
				Image: "vllm", Requests: map[string]string{"cpu": "2"}, Limits: map[string]string{"memory": "8Gi"},
				Env: []*aigridv1.EnvVar{{Name: "VLLM_ADDITIONAL_ARGS", Value: "--x"}},
			},
			Placement: &aigridv1.Placement{LabelSelector: &aigridv1.LabelSelector{
				MatchLabels:      map[string]string{labelEnabled: "true", labelProvisioned: "true"},
				MatchExpressions: []*aigridv1.LabelSelectorRequirement{{Key: "location", Operator: "In", Values: []string{"site-b", "site-a"}}},
			}},
		},
		Status: &aigridv1.ModelStatus{
			Phase: aigridv1.ModelPhase_MODEL_PHASE_PENDING, Reason: "SavedToGit",
			Placement: &aigridv1.PlacementStatus{
				NumberOfSelectedClusters: 2, Locations: []string{"site-a", "site-b"},
				Decisions: []*aigridv1.ClusterDecision{{ClusterName: "site-a"}, {ClusterName: "site-b"}},
			},
		},
	}
}

func TestV1ModelReads(t *testing.T) {
	ctx := context.Background()
	conn := &recordingConn{reply: &backendv1.ModelsListResponse{Size: 1, Total: 4, Items: []*backendv1.Model{v1Model()}}}
	list, err := v1Models{conn, modelsNS}.ListModels(ctx, &aigridv1.ListModelsRequest{Offset: proto.Int32(3), Limit: proto.Int32(1)})
	if err != nil || conn.method != methodModelsList {
		t.Fatalf("List sent %s: %v", conn.method, err)
	}
	if sent := conn.req.(*backendv1.ModelsListRequest); sent.GetOffset() != 3 || sent.GetLimit() != 1 {
		t.Errorf("List sent %v, want offset 3 and limit 1", sent)
	}
	if list.GetTotal() != 4 || len(list.GetItems()) != 1 || !proto.Equal(list.GetItems()[0], draftModel()) {
		t.Fatalf("List got %v, want %v", list, draftModel())
	}

	conn = &recordingConn{reply: &backendv1.ModelsGetResponse{Object: v1Model()}}
	got, err := v1Models{conn, modelsNS}.GetModel(ctx, &aigridv1.GetModelRequest{Namespace: modelsNS, Name: "granite"})
	if err != nil || conn.method != methodModelsGet || conn.req.(*backendv1.ModelsGetRequest).GetId() != "granite" {
		t.Fatalf("Get sent %s %v: %v", conn.method, conn.req, err)
	}
	if !proto.Equal(got.GetObject(), draftModel()) {
		t.Errorf("Get got %v, want %v", got.GetObject(), draftModel())
	}
}

// The draft's filter and order use its own field names, which the backend's
// List doesn't have; a model in another namespace can't be in this backend.
func TestV1ModelRefusals(t *testing.T) {
	ctx := context.Background()
	c := v1Models{&recordingConn{}, modelsNS}
	if _, err := c.ListModels(ctx, &aigridv1.ListModelsRequest{Filter: proto.String("true")}); status.Code(err) != codes.Unimplemented {
		t.Errorf("List with a filter: %v, want Unimplemented", err)
	}
	if _, err := c.GetModel(ctx, &aigridv1.GetModelRequest{Namespace: "other", Name: "granite"}); status.Code(err) != codes.NotFound {
		t.Errorf("Get in another namespace: %v, want NotFound", err)
	}
	if _, err := c.DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: "other", Name: "granite"}); status.Code(err) != codes.NotFound {
		t.Errorf("Delete in another namespace: %v, want NotFound", err)
	}
	other := draftModel()
	other.Metadata.Namespace = "other"
	if _, err := c.CreateModel(ctx, &aigridv1.CreateModelRequest{Object: other}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("Create in another namespace: %v, want InvalidArgument", err)
	}
	tolerating := draftModel()
	tolerating.Spec.Placement.Tolerations = []*aigridv1.Toleration{{Key: "k", Operator: "Exists"}}
	if _, err := c.CreateModel(ctx, &aigridv1.CreateModelRequest{Object: tolerating}); status.Code(err) != codes.Unimplemented {
		t.Errorf("Create with tolerations: %v, want Unimplemented", err)
	}
}

func TestV1ModelWrites(t *testing.T) {
	ctx := context.Background()
	in := draftModel()
	in.Status, in.Metadata.ResourceVersion = nil, ""
	want := v1Model()
	want.Status, want.Metadata.Version, want.Metadata.CreationTimestamp = nil, 0, nil

	conn := &recordingConn{reply: &backendv1.ModelsCreateResponse{Object: v1Model()}}
	if _, err := (v1Models{conn, modelsNS}).CreateModel(ctx, &aigridv1.CreateModelRequest{Object: in}); err != nil || conn.method != methodModelsCreate {
		t.Fatalf("Create sent %s: %v", conn.method, err)
	}
	if sent := conn.req.(*backendv1.ModelsCreateRequest).GetObject(); !proto.Equal(sent, want) {
		t.Errorf("Create sent %v, want %v", sent, want)
	}

	in.Metadata.ResourceVersion = "3"
	mask := &fieldmaskpb.FieldMask{Paths: []string{"spec.placement", "metadata.labels"}}
	conn = &recordingConn{reply: &backendv1.ModelsUpdateResponse{Object: v1Model()}}
	if _, err := (v1Models{conn, modelsNS}).UpdateModel(ctx, &aigridv1.UpdateModelRequest{Object: in, UpdateMask: mask, Lock: true}); err != nil || conn.method != methodModelsUpdate {
		t.Fatalf("Update sent %s: %v", conn.method, err)
	}
	sent := conn.req.(*backendv1.ModelsUpdateRequest)
	want.Metadata.Version = 3
	if !proto.Equal(sent.GetObject(), want) || !proto.Equal(sent.GetUpdateMask(), mask) || !sent.GetLock() {
		t.Errorf("Update sent %v, want %v with the mask and the lock", sent, want)
	}

	for rv, version := range map[string]int32{"": 0, "3": 3} {
		conn = &recordingConn{reply: &backendv1.ModelsDeleteResponse{}}
		if _, err := (v1Models{conn, modelsNS}).DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: modelsNS, Name: "granite", ResourceVersion: rv}); err != nil {
			t.Fatal(err)
		}
		if sent := conn.req.(*backendv1.ModelsDeleteRequest); conn.method != methodModelsDelete || sent.GetId() != "granite" || sent.GetResourceVersion() != version {
			t.Errorf("Delete with version %q sent %s %v, want version %d", rv, conn.method, sent, version)
		}
	}

	// Version 0 is the backend's "no check": refused, so If-Match never makes a delete unconditional.
	conn = &recordingConn{}
	if _, err := (v1Models{conn, modelsNS}).DeleteModel(ctx, &aigridv1.DeleteModelRequest{Namespace: modelsNS, Name: "granite", ResourceVersion: "0"}); status.Code(err) != codes.FailedPrecondition || conn.method != "" {
		t.Errorf("Delete with version 0: %v after calling %q, want FailedPrecondition and no call", err, conn.method)
	}
}

// Placements other than the console's own pass through in both directions.
func TestV1ModelOtherPlacement(t *testing.T) {
	in := &aigridv1.Placement{ClusterSets: []string{"set"}, LabelSelector: &aigridv1.LabelSelector{
		MatchLabels:      map[string]string{"region": "east"},
		MatchExpressions: []*aigridv1.LabelSelectorRequirement{{Key: "location", Operator: "In", Values: []string{"a"}}},
	}}
	out, err := toV1Placement(in)
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(fromV1Placement(out), in) {
		t.Errorf("round trip got %v, want %v", fromV1Placement(out), in)
	}
}

// ListLocations passes the backend's Models/ListLocations through: the names of
// the provisioned, Available inference and combined members, in its order.
func TestV1ListLocations(t *testing.T) {
	conn := &recordingConn{reply: &backendv1.ModelsListLocationsResponse{Locations: []string{"site-a", "site-b"}}}
	got, err := v1Models{conn, modelsNS}.ListLocations(context.Background(), &aigridv1.ListLocationsRequest{})
	if err != nil || conn.method != methodModelsListLocations {
		t.Fatalf("ListLocations sent %s: %v", conn.method, err)
	}
	if want := []string{"site-a", "site-b"}; !slices.Equal(got.GetLocations(), want) {
		t.Errorf("ListLocations got %v, want %v", got.GetLocations(), want)
	}

	// None: an empty list, not null.
	conn = &recordingConn{reply: &backendv1.ModelsListLocationsResponse{}}
	if got, err := (v1Models{conn, modelsNS}).ListLocations(context.Background(), &aigridv1.ListLocationsRequest{}); err != nil || got.GetLocations() == nil {
		t.Errorf("ListLocations with none got %v, %v; want an empty list", got.GetLocations(), err)
	}
}
