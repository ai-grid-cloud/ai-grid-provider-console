// Package protodrift proves that the console's draft proto (mock/proto/ai_grid/v1,
// compiled into bff/gen) is a strict superset of the backend's real proto
// (mock/proto/upstream/ai_grid.proto, vendored unchanged).
//
// The draft is the console's proposal to ai-grid-backend. The backend may ship
// something different; the day it does, hack/sync-upstream-proto.sh refreshes the
// vendored copy (nightly in .github/workflows/drift.yaml) and this test fails on
// every service, method, message, field, oneof or enum value the draft no longer
// agrees with. That is the signal to change the
// draft, or to adopt the backend's generated package and delete the draft.
package protodrift

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/bufbuild/protocompile"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	// Links the draft's generated descriptors into protoregistry.GlobalFiles.
	_ "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const (
	upstreamDir  = "../../../mock/proto/upstream"
	upstreamFile = "ai_grid.proto"
	draftPackage = "ai_grid.v1"
)

// compileUpstream parses a copy of the backend proto in dir without registering
// it, so it can be compared against the draft registered under the same package.
func compileUpstream(t *testing.T, dir string) protoreflect.FileDescriptor {
	t.Helper()
	compiler := protocompile.Compiler{
		Resolver: protocompile.WithStandardImports(&protocompile.SourceResolver{ImportPaths: []string{dir}}),
	}
	files, err := compiler.Compile(context.Background(), upstreamFile)
	if err != nil {
		t.Fatalf("compile %s/%s: %v", dir, upstreamFile, err)
	}
	return files[0]
}

func TestUpstreamCommitIsRecorded(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(upstreamDir, "COMMIT"))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && !strings.HasPrefix(line, "#") {
			got[k] = v
		}
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(got["commit"]) {
		t.Errorf("COMMIT must record the full git sha of the vendored proto, got %q", got["commit"])
	}
	if !strings.HasPrefix(got["repo"], "https://github.com/") {
		t.Errorf("COMMIT must record the repository URL, got %q", got["repo"])
	}
	if got["path"] != "proto/ai_grid/v1/ai_grid.proto" {
		t.Errorf("COMMIT must record the file path in the backend repository, got %q", got["path"])
	}
}

// TestDraftIsSupersetOfUpstream is the test that fails the day the backend
// changes its proto in a way the draft does not carry.
func TestDraftIsSupersetOfUpstream(t *testing.T) {
	upstream := compileUpstream(t, upstreamDir)
	if got := string(upstream.Package()); got != draftPackage {
		t.Fatalf("upstream package is %s, the draft is %s; the console must switch packages", got, draftPackage)
	}
	draft := &registry{}
	draft.checkFile(upstream)
	for _, diff := range draft.diffs {
		t.Error(diff)
	}
	if len(draft.diffs) > 0 {
		t.Log("the backend proto in mock/proto/upstream no longer agrees with the draft in mock/proto/ai_grid/v1: update the draft, or adopt the backend package and delete the draft")
	}
}

// registry resolves draft descriptors by full name and collects differences.
type registry struct{ diffs []string }

func (r *registry) errorf(format string, args ...any) {
	r.diffs = append(r.diffs, fmt.Sprintf(format, args...))
}

// checkFile compares everything an upstream file declares with the draft.
func (r *registry) checkFile(up protoreflect.FileDescriptor) {
	for i := 0; i < up.Services().Len(); i++ {
		r.checkService(up.Services().Get(i))
	}
	for i := 0; i < up.Messages().Len(); i++ {
		r.checkMessage(up.Messages().Get(i))
	}
	for i := 0; i < up.Enums().Len(); i++ {
		r.checkEnum(up.Enums().Get(i))
	}
}

func (r *registry) find(name protoreflect.FullName) protoreflect.Descriptor {
	d, err := protoregistry.GlobalFiles.FindDescriptorByName(name)
	if err != nil {
		return nil
	}
	return d
}

func (r *registry) checkService(up protoreflect.ServiceDescriptor) {
	d := r.find(up.FullName())
	svc, ok := d.(protoreflect.ServiceDescriptor)
	if !ok {
		r.errorf("upstream service %s is missing from the draft (found %T)", up.FullName(), d)
		return
	}
	for i := 0; i < up.Methods().Len(); i++ {
		um := up.Methods().Get(i)
		dm := svc.Methods().ByName(um.Name())
		if dm == nil {
			r.errorf("upstream method %s is missing from the draft service %s", um.FullName(), svc.FullName())
			continue
		}
		if dm.Input().FullName() != um.Input().FullName() {
			r.errorf("method %s: upstream input %s, draft input %s", um.FullName(), um.Input().FullName(), dm.Input().FullName())
		}
		if dm.Output().FullName() != um.Output().FullName() {
			r.errorf("method %s: upstream output %s, draft output %s", um.FullName(), um.Output().FullName(), dm.Output().FullName())
		}
		if dm.IsStreamingClient() != um.IsStreamingClient() || dm.IsStreamingServer() != um.IsStreamingServer() {
			r.errorf("method %s: streaming differs (upstream client=%v server=%v, draft client=%v server=%v)",
				um.FullName(), um.IsStreamingClient(), um.IsStreamingServer(), dm.IsStreamingClient(), dm.IsStreamingServer())
		}
	}
}

func (r *registry) checkMessage(up protoreflect.MessageDescriptor) {
	d := r.find(up.FullName())
	msg, ok := d.(protoreflect.MessageDescriptor)
	if !ok {
		r.errorf("upstream message %s is missing from the draft (found %T)", up.FullName(), d)
		return
	}
	for i := 0; i < up.Fields().Len(); i++ {
		uf := up.Fields().Get(i)
		df := msg.Fields().ByNumber(uf.Number())
		if df == nil {
			r.errorf("upstream field %s (number %d) is missing from the draft message %s", uf.FullName(), uf.Number(), msg.FullName())
			continue
		}
		if df.Name() != uf.Name() {
			r.errorf("field %d of %s: upstream name %q, draft name %q", uf.Number(), msg.FullName(), uf.Name(), df.Name())
		}
		if df.Cardinality() != uf.Cardinality() {
			r.errorf("field %s: upstream cardinality %v, draft %v", uf.FullName(), uf.Cardinality(), df.Cardinality())
		}
		if df.HasPresence() != uf.HasPresence() {
			r.errorf("field %s: upstream presence (optional) %v, draft %v", uf.FullName(), uf.HasPresence(), df.HasPresence())
		}
		if df.IsMap() != uf.IsMap() {
			r.errorf("field %s: upstream map %v, draft map %v", uf.FullName(), uf.IsMap(), df.IsMap())
		}
		if uo, do := oneofName(uf), oneofName(df); uo != do {
			r.errorf("field %s: upstream oneof %q, draft oneof %q", uf.FullName(), uo, do)
		}
		if ut, dt := typeName(uf), typeName(df); ut != dt {
			r.errorf("field %s: upstream type %s, draft type %s", uf.FullName(), ut, dt)
		}
	}
	for i := 0; i < up.Messages().Len(); i++ {
		r.checkMessage(up.Messages().Get(i))
	}
	for i := 0; i < up.Enums().Len(); i++ {
		r.checkEnum(up.Enums().Get(i))
	}
}

func (r *registry) checkEnum(up protoreflect.EnumDescriptor) {
	d := r.find(up.FullName())
	enum, ok := d.(protoreflect.EnumDescriptor)
	if !ok {
		r.errorf("upstream enum %s is missing from the draft (found %T)", up.FullName(), d)
		return
	}
	for i := 0; i < up.Values().Len(); i++ {
		uv := up.Values().Get(i)
		dv := enum.Values().ByName(uv.Name())
		if dv == nil {
			r.errorf("upstream enum value %s is missing from the draft enum %s", uv.FullName(), enum.FullName())
			continue
		}
		if dv.Number() != uv.Number() {
			r.errorf("enum value %s: upstream number %d, draft number %d", uv.FullName(), uv.Number(), dv.Number())
		}
	}
}

// oneofName is the real oneof a field belongs to, or "" for none. Fields that
// are merely `optional` sit in a synthetic oneof, which HasPresence covers; two
// fields moved into one real oneof can no longer be set together, which the
// presence, cardinality and type checks would not notice.
func oneofName(f protoreflect.FieldDescriptor) string {
	if o := f.ContainingOneof(); o != nil && !o.IsSynthetic() {
		return string(o.Name())
	}
	return ""
}

// typeName renders a field's type so scalars, messages and enums compare by
// name: "string", "message ai_grid.v1.ManagedCluster", "enum ai_grid.v1.X".
func typeName(f protoreflect.FieldDescriptor) string {
	switch f.Kind() {
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return fmt.Sprintf("message %s", f.Message().FullName())
	case protoreflect.EnumKind:
		return fmt.Sprintf("enum %s", f.Enum().FullName())
	default:
		return f.Kind().String()
	}
}

// TestDriftIsDetected guards the guard: every kind of change the backend could
// make to its proto is applied to a copy of the upstream file, and the
// comparison must report it, so a silent pass is not a bug in the test.
func TestDriftIsDetected(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(upstreamDir, upstreamFile))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		old, new string   // one replacement applied to the upstream copy
		want     []string // a substring of each expected difference, in order
	}{
		{
			name: "field type changed and field added",
			old:  "bool hub_accepts_client = 3;",
			new:  "string hub_accepts_client = 3;\n  int32 agent_version = 99;",
			want: []string{"ManagedCluster.hub_accepts_client: upstream type string, draft type bool", "ManagedCluster.agent_version (number 99) is missing"},
		},
		{
			name: "method renamed, so the draft lacks it",
			old:  "rpc ListManagedClusters(ListManagedClustersRequest)",
			new:  "rpc ListClusters(ListManagedClustersRequest)",
			want: []string{"method ai_grid.v1.ManagedClusters.ListClusters is missing from the draft service"},
		},
		{
			name: "method became server streaming",
			old:  "returns (ListTenantsResponse);",
			new:  "returns (stream ListTenantsResponse);",
			want: []string{"method ai_grid.v1.Tenants.ListTenants: streaming differs"},
		},
		{
			name: "method output changed",
			old:  "rpc Ping(PingRequest) returns (PingResponse);",
			new:  "rpc Ping(PingRequest) returns (PingRequest);",
			want: []string{"method ai_grid.v1.AiGrid.Ping: upstream output ai_grid.v1.PingRequest, draft output ai_grid.v1.PingResponse"},
		},
		{
			name: "enum values renumbered relative to the draft",
			old:  "message PingRequest {",
			new:  "enum ConditionStatus {\n  CONDITION_STATUS_UNSPECIFIED = 0;\n  CONDITION_STATUS_FALSE = 1;\n  CONDITION_STATUS_TRUE = 2;\n}\n\nmessage PingRequest {",
			want: []string{"enum value ai_grid.v1.CONDITION_STATUS_FALSE: upstream number 1, draft number 2", "enum value ai_grid.v1.CONDITION_STATUS_TRUE: upstream number 2, draft number 1"},
		},
		{
			name: "enum value missing from the draft",
			old:  "message PingRequest {",
			new:  "enum ConditionStatus {\n  CONDITION_STATUS_UNSPECIFIED = 0;\n  CONDITION_STATUS_TRUE = 1;\n  CONDITION_STATUS_FALSE = 2;\n  CONDITION_STATUS_DEGRADED = 3;\n}\n\nmessage PingRequest {",
			want: []string{"enum value ai_grid.v1.CONDITION_STATUS_DEGRADED is missing from the draft enum ai_grid.v1.ConditionStatus"},
		},
		{
			name: "fields moved into a oneof",
			old:  "string name = 1;\n  map<string, string> labels = 2;\n  bool hub_accepts_client = 3;",
			new:  "map<string, string> labels = 2;\n  oneof identity {\n    string name = 1;\n    bool hub_accepts_client = 3;\n  }",
			// A oneof member also has presence, so each field is reported twice.
			want: []string{"ManagedCluster.name: upstream presence (optional) true, draft false", `ManagedCluster.name: upstream oneof "identity", draft oneof ""`, "ManagedCluster.hub_accepts_client: upstream presence (optional) true, draft false", `ManagedCluster.hub_accepts_client: upstream oneof "identity", draft oneof ""`},
		},
		{
			name: "field became optional",
			old:  "string id = 1;",
			new:  "optional string id = 1;",
			want: []string{"Tenant.id: upstream presence (optional) true, draft false"},
		},
		{
			name: "field renamed in place",
			old:  "repeated string domains = 3;",
			new:  "repeated string hosts = 3;",
			want: []string{`field 3 of ai_grid.v1.Tenant: upstream name "hosts", draft name "domains"`},
		},
		{
			name: "message added",
			old:  "message PingRequest {",
			new:  "message Site { string name = 1; }\n\nmessage PingRequest {",
			want: []string{"upstream message ai_grid.v1.Site is missing from the draft"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mutated := strings.Replace(string(raw), tc.old, tc.new, 1)
			if mutated == string(raw) {
				t.Fatalf("the mutation did not apply; update this case with the upstream file (looking for %q)", tc.old)
			}
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, upstreamFile), []byte(mutated), 0o600); err != nil {
				t.Fatal(err)
			}
			r := &registry{}
			r.checkFile(compileUpstream(t, dir))
			if len(r.diffs) != len(tc.want) {
				t.Fatalf("want %d difference(s) %q, got %d: %q", len(tc.want), tc.want, len(r.diffs), r.diffs)
			}
			for i, want := range tc.want {
				if !strings.Contains(r.diffs[i], want) {
					t.Errorf("difference %d = %q, want it to mention %q", i, r.diffs[i], want)
				}
			}
		})
	}
}
