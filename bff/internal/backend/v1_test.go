package backend

import (
	"context"
	"slices"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// recordingConn records one Invoke and answers with reply.
type recordingConn struct {
	method string
	req    any
	reply  proto.Message
}

func (c *recordingConn) Invoke(_ context.Context, method string, args, reply any, _ ...grpc.CallOption) error {
	c.method, c.req = method, args
	proto.Merge(reply.(proto.Message), c.reply)
	return nil
}

func (c *recordingConn) NewStream(context.Context, *grpc.StreamDesc, string, ...grpc.CallOption) (grpc.ClientStream, error) {
	panic("unused")
}

func TestV1UpdateSendsMetadataPathsAndVersion(t *testing.T) {
	conn := &recordingConn{reply: &backendv1.ClustersUpdateResponse{Object: &backendv1.ManagedCluster{
		Id: "site1", Metadata: &backendv1.Metadata{Version: 8}, Spec: &backendv1.ManagedClusterSpec{HubAcceptsClient: true},
	}}}
	resp, err := v1Clusters{conn}.UpdateManagedCluster(context.Background(), &aigridv1.UpdateManagedClusterRequest{
		Object:     &aigridv1.ManagedCluster{Name: "site1", ResourceVersion: "7", Labels: map[string]string{"ai-grid/enabled": "true"}},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"labels"}},
		Lock:       true,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := &backendv1.ClustersUpdateRequest{
		Object: &backendv1.ManagedCluster{Id: "site1", Metadata: &backendv1.Metadata{
			Labels: map[string]string{"ai-grid/enabled": "true"}, Version: 7,
		}},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"metadata.labels"}},
		Lock:       true,
	}
	if conn.method != methodClustersUpdate || !proto.Equal(conn.req.(proto.Message), want) {
		t.Fatalf("sent %s %v, want %v", conn.method, conn.req, want)
	}
	if p := resp.GetObject().GetStatus().Provisioning; p == nil || *p != "" {
		t.Fatalf("provisioning %v, want set and empty", p)
	}
	if got := resp.GetObject().GetResourceVersion(); got != "8" {
		t.Fatalf("resource version %q, want 8", got)
	}
}

func TestFromV1ClusterState(t *testing.T) {
	accepted := &backendv1.ManagedClusterSpec{HubAcceptsClient: true}
	for _, tc := range []struct {
		name string
		mc   *backendv1.ManagedCluster
		want aigridv1.ManagedClusterState
	}{
		{"not accepted", &backendv1.ManagedCluster{}, aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED},
		{"not joined", &backendv1.ManagedCluster{Spec: accepted}, aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT},
		{"available", &backendv1.ManagedCluster{Spec: accepted, Status: &backendv1.ManagedClusterStatus{Joined: true, AvailableCondition: "True"}}, aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE},
		{"offline", &backendv1.ManagedCluster{Spec: accepted, Status: &backendv1.ManagedClusterStatus{Joined: true, AvailableCondition: "False"}}, aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE},
		{"unknown", &backendv1.ManagedCluster{Spec: accepted, Status: &backendv1.ManagedClusterStatus{Joined: true}}, aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN},
	} {
		if got := FromV1Cluster(tc.mc).GetStatus().GetState(); got != tc.want {
			t.Errorf("%s: state %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestV1ListClustersForwardsPage(t *testing.T) {
	conn := &recordingConn{reply: &backendv1.ClustersListResponse{Size: 1, Total: 3, Items: []*backendv1.ManagedCluster{{Id: "site2"}}}}
	resp, err := v1Clusters{conn}.ListManagedClusters(context.Background(), &aigridv1.ListManagedClustersRequest{Offset: proto.Int32(1), Limit: proto.Int32(1)})
	if err != nil {
		t.Fatal(err)
	}
	if want := (&backendv1.ClustersListRequest{Offset: proto.Int32(1), Limit: proto.Int32(1)}); conn.method != methodClustersList || !proto.Equal(conn.req.(proto.Message), want) {
		t.Fatalf("sent %s %v, want %v", conn.method, conn.req, want)
	}
	if resp.GetTotal() != 3 || resp.GetSize() != 1 || len(resp.GetClusters()) != 1 || resp.GetClusters()[0].GetName() != "site2" {
		t.Fatalf("got %v", resp)
	}

	// The backend doesn't evaluate filter yet and would count every cluster,
	// so a filter never reaches it.
	conn = &recordingConn{reply: &backendv1.ClustersListResponse{}}
	_, err = v1Clusters{conn}.ListManagedClusters(context.Background(), &aigridv1.ListManagedClustersRequest{Filter: proto.String(`this.name == "a"`)})
	if status.Code(err) != codes.Unimplemented || conn.method != "" {
		t.Fatalf("filter: %v, sent %q", err, conn.method)
	}
}

func TestV1ListTenantsForwardsPageAndFilter(t *testing.T) {
	conn := &recordingConn{reply: &backendv1.TenantsListResponse{Size: 1, Total: 3, Items: []*backendv1.Tenant{{Id: "t2"}}}}
	resp, err := v1Tenants{conn}.ListTenants(context.Background(), &aigridv1.ListTenantsRequest{Offset: proto.Int32(1), Limit: proto.Int32(1)})
	if err != nil {
		t.Fatal(err)
	}
	if want := (&backendv1.TenantsListRequest{Offset: proto.Int32(1), Limit: proto.Int32(1)}); !proto.Equal(conn.req.(proto.Message), want) {
		t.Fatalf("sent %v, want %v", conn.req, want)
	}
	if resp.Total == nil || *resp.Total != 3 || len(resp.GetTenants()) != 1 {
		t.Fatalf("got total %v and %d tenants, want 3 and 1", resp.Total, len(resp.GetTenants()))
	}

	// The backend doesn't evaluate filter yet: no total, so the handler answers 501.
	resp, err = v1Tenants{conn}.ListTenants(context.Background(), &aigridv1.ListTenantsRequest{Filter: proto.String(`this.name == "a"`)})
	if err != nil {
		t.Fatal(err)
	}
	if conn.req.(*backendv1.TenantsListRequest).Filter == nil || resp.Total != nil {
		t.Fatalf("filter not forwarded, or total %v set", resp.Total)
	}
}

func TestV1TenantWrites(t *testing.T) {
	created := timestamppb.New(time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC))
	stored := &backendv1.Tenant{Id: "t1", Metadata: &backendv1.Metadata{Name: "org1", Version: 4, CreationTimestamp: created}, Spec: &backendv1.TenantSpec{Domains: []string{"org1.example.com"}}}
	ctx := context.Background()

	conn := &recordingConn{reply: &backendv1.TenantsGetResponse{Object: stored}}
	got, err := v1Tenants{conn}.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: "t1"})
	if err != nil || conn.method != methodTenantsGet || conn.req.(*backendv1.TenantsGetRequest).GetId() != "t1" {
		t.Fatalf("GetTenant sent %s %v: %v", conn.method, conn.req, err)
	}
	want := &aigridv1.Tenant{Id: "t1", Name: "org1", Domains: []string{"org1.example.com"}, ResourceVersion: "4", CreateTime: created}
	if !proto.Equal(got.GetObject(), want) {
		t.Fatalf("GetTenant() = %v, want %v", got.GetObject(), want)
	}

	conn = &recordingConn{reply: &backendv1.TenantsCreateResponse{Object: stored}}
	if _, err := (v1Tenants{conn}).CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "org1", Domains: []string{"org1.example.com"}}}); err != nil {
		t.Fatal(err)
	}
	wantCreate := &backendv1.TenantsCreateRequest{Object: &backendv1.Tenant{Metadata: &backendv1.Metadata{Name: "org1"}, Spec: &backendv1.TenantSpec{Domains: []string{"org1.example.com"}}}}
	if conn.method != methodTenantsCreate || !proto.Equal(conn.req.(proto.Message), wantCreate) {
		t.Fatalf("CreateTenant sent %s %v, want %v", conn.method, conn.req, wantCreate)
	}

	conn = &recordingConn{reply: &backendv1.TenantsUpdateResponse{Object: stored}}
	if _, err := (v1Tenants{conn}).UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{
		Object:     &aigridv1.Tenant{Id: "t1", ResourceVersion: "3", Domains: []string{}},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"domains"}},
	}); err != nil {
		t.Fatal(err)
	}
	wantUpdate := &backendv1.TenantsUpdateRequest{
		Object:     &backendv1.Tenant{Id: "t1", Metadata: &backendv1.Metadata{Version: 3}, Spec: &backendv1.TenantSpec{}},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"spec.domains"}},
		Lock:       true,
	}
	if conn.method != methodTenantsUpdate || !proto.Equal(conn.req.(proto.Message), wantUpdate) {
		t.Fatalf("UpdateTenant sent %s %v, want %v", conn.method, conn.req, wantUpdate)
	}

	// Version 0 is sent as it is, with lock: the backend, not the BFF,
	// refuses it.
	if _, err := (v1Tenants{conn}).UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{
		Object: &aigridv1.Tenant{Id: "t1", ResourceVersion: "0"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"domains"}},
	}); err != nil || !conn.req.(*backendv1.TenantsUpdateRequest).GetLock() {
		t.Fatalf("version 0: lock %v, err %v", conn.req.(*backendv1.TenantsUpdateRequest).GetLock(), err)
	}

	// Delete sends the If-Match version, 0 included: the backend refuses it.
	for _, v := range []struct {
		rv   string
		want int32
	}{{"4", 4}, {"0", 0}} {
		conn = &recordingConn{reply: &backendv1.TenantsDeleteResponse{}}
		if _, err := (v1Tenants{conn}).DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: "t1", ResourceVersion: v.rv}); err != nil {
			t.Fatal(err)
		}
		wantDelete := &backendv1.TenantsDeleteRequest{Id: "t1", Version: v.want}
		if conn.method != methodTenantsDelete || !proto.Equal(conn.req.(proto.Message), wantDelete) {
			t.Fatalf("DeleteTenant(version %s) sent %s %v, want %v", v.rv, conn.method, conn.req, wantDelete)
		}
	}
}

// Fields the backend's Tenant lacks are refused before any call, not dropped.
func TestV1TenantFieldsNotInBackend(t *testing.T) {
	ctx := context.Background()
	conn := &recordingConn{}
	_, err := v1Tenants{conn}.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{
		Name: "org1", IdentityProvider: &aigridv1.IdentityProvider{Title: "SSO"},
	}})
	if status.Code(err) != codes.Unimplemented || conn.method != "" {
		t.Fatalf("create with an identity provider: %v, sent %q", err, conn.method)
	}
	_, err = v1Tenants{conn}.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{
		Object:     &aigridv1.Tenant{Id: "t1", ResourceVersion: "1"},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"domains", "identity_provider"}},
	})
	if status.Code(err) != codes.Unimplemented || conn.method != "" {
		t.Fatalf("update of identity_provider: %v, sent %q", err, conn.method)
	}
	// Keycloak's defaults are what the backend sets anyway.
	conn.reply = &backendv1.TenantsCreateResponse{}
	if _, err := (v1Tenants{conn}).CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "org1", Alias: "org1", Enabled: proto.Bool(true)}}); err != nil {
		t.Fatal(err)
	}
}

// methodConn answers each method with its own reply or error, and records the methods called.
type methodConn struct {
	replies map[string]proto.Message
	errs    map[string]error
	called  []string
	reqs    []any
}

func (c *methodConn) Invoke(_ context.Context, method string, req, reply any, _ ...grpc.CallOption) error {
	c.called, c.reqs = append(c.called, method), append(c.reqs, req)
	if err := c.errs[method]; err != nil {
		return err
	}
	proto.Merge(reply.(proto.Message), c.replies[method])
	return nil
}

func (c *methodConn) NewStream(context.Context, *grpc.StreamDesc, string, ...grpc.CallOption) (grpc.ClientStream, error) {
	panic("unused")
}

// GetTenant answers with the backend's error as is: both target backends have Get, so there is no list fallback.
func TestV1GetTenantNoListFallback(t *testing.T) {
	conn := &methodConn{errs: map[string]error{methodTenantsGet: status.Error(codes.Unimplemented, "unknown method Get")}}
	if _, err := (v1Tenants{conn}).GetTenant(context.Background(), &aigridv1.GetTenantRequest{Id: "t2"}); status.Code(err) != codes.Unimplemented || len(conn.called) != 1 {
		t.Fatalf("GetTenant on Unimplemented: %v after %v, want Unimplemented and no list", err, conn.called)
	}
}

// Description, enabled and attributes pass when they hold what a read gives back.
func TestV1UpdateTenantReadBackValues(t *testing.T) {
	ctx := context.Background()
	stored := &backendv1.Tenant{Id: "t1", Metadata: &backendv1.Metadata{Name: "org1", Version: 4}}
	newConn := func() *methodConn {
		return &methodConn{replies: map[string]proto.Message{
			methodTenantsGet:    &backendv1.TenantsGetResponse{Object: stored},
			methodTenantsUpdate: &backendv1.TenantsUpdateResponse{Object: stored},
		}}
	}
	update := func(conn *methodConn, version string, obj *aigridv1.Tenant, paths ...string) (*aigridv1.UpdateTenantResponse, error) {
		obj.Id, obj.ResourceVersion = "t1", version
		return v1Tenants{conn}.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{Object: obj, UpdateMask: &fieldmaskpb.FieldMask{Paths: paths}})
	}

	// With the name: only metadata.name goes to the backend.
	conn := newConn()
	if _, err := update(conn, "4", &aigridv1.Tenant{Name: "org2", Enabled: proto.Bool(true)}, "name", "description", "enabled", "attributes"); err != nil {
		t.Fatal(err)
	}
	if len(conn.called) != 1 || conn.called[0] != methodTenantsUpdate {
		t.Fatalf("called %v, want one Update", conn.called)
	}
	if paths := conn.reqs[0].(*backendv1.TenantsUpdateRequest).GetUpdateMask().GetPaths(); !slices.Equal(paths, []string{"metadata.name"}) {
		t.Fatalf("mask %v, want [metadata.name]", paths)
	}

	// Only no-op fields at a version: one Update whose mask names only id,
	// which PR 16 answers without writing, checking the version (an empty
	// mask would rewrite name and domains).
	conn = newConn()
	got, err := update(conn, "4", &aigridv1.Tenant{Enabled: proto.Bool(true)}, "description", "enabled")
	if err != nil || got.GetObject().GetName() != "org1" || !slices.Equal(conn.called, []string{methodTenantsUpdate}) {
		t.Fatalf("no-op update at 4: %v, %v after %v", got.GetObject(), err, conn.called)
	}
	wantNoop := &backendv1.TenantsUpdateRequest{
		Object:     &backendv1.Tenant{Id: "t1", Metadata: &backendv1.Metadata{Version: 4}, Spec: &backendv1.TenantSpec{}},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"id"}},
		Lock:       true,
	}
	if !proto.Equal(conn.reqs[0].(proto.Message), wantNoop) {
		t.Fatalf("no-op update at 4 sent %v, want %v", conn.reqs[0], wantNoop)
	}
	// At version 0 too: one locked Update, never a plain read.
	conn = newConn()
	if _, err := update(conn, "0", &aigridv1.Tenant{}, "description"); err != nil || !slices.Equal(conn.called, []string{methodTenantsUpdate}) || !conn.reqs[0].(*backendv1.TenantsUpdateRequest).GetLock() {
		t.Fatalf("no-op update at 0: %v after %v", err, conn.called)
	}

	// Other values, and any alias, are refused before any call.
	for _, tc := range []struct {
		obj   *aigridv1.Tenant
		paths []string
	}{
		{&aigridv1.Tenant{Description: "x"}, []string{"description"}},
		{&aigridv1.Tenant{Enabled: proto.Bool(false)}, []string{"enabled"}},
		{&aigridv1.Tenant{Attributes: map[string]string{"k": "v"}}, []string{"attributes"}},
		{&aigridv1.Tenant{Name: "org1", Alias: "org1"}, []string{"name", "alias"}},
	} {
		conn := newConn()
		if _, err := update(conn, "4", tc.obj, tc.paths...); status.Code(err) != codes.Unimplemented || len(conn.called) != 0 {
			t.Errorf("%v %v: %v after %v, want Unimplemented before any call", tc.paths, tc.obj, err, conn.called)
		}
	}
}

// A negative If-Match version is a bad request, refused before any call.
func TestV1TenantNegativeVersion(t *testing.T) {
	ctx := context.Background()
	conn := &recordingConn{}
	_, err := v1Tenants{conn}.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{
		Object: &aigridv1.Tenant{Id: "t1", ResourceVersion: "-1"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"domains"}},
	})
	if status.Code(err) != codes.InvalidArgument || conn.method != "" {
		t.Fatalf("update at -1: %v, sent %q", err, conn.method)
	}
	if _, err := (v1Tenants{conn}).DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: "t1", ResourceVersion: "-1"}); status.Code(err) != codes.InvalidArgument || conn.method != "" {
		t.Fatalf("delete at -1: %v, sent %q", err, conn.method)
	}
}
