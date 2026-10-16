package api

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
)

func seedTenants() []*aigridv1.Tenant {
	return []*aigridv1.Tenant{
		{Id: "t-2", Name: "globex-research", Alias: "globex", Enabled: proto.Bool(true), ResourceVersion: "1", Domains: []string{"globex.example.com"},
			DomainDetails: []*aigridv1.TenantDomain{{Name: "globex.example.com", Verified: true}}},
		{Id: "t-1", Name: "acme-robotics", Alias: "acme-robotics", Enabled: proto.Bool(true), ResourceVersion: "1", Description: "Acme", Attributes: map[string]string{"billing-account": "ACME-0042"},
			Domains:       []string{"acme.example.com", "*.acme.example.org"},
			DomainDetails: []*aigridv1.TenantDomain{{Name: "acme.example.com", Verified: true, IdentityProviderAlias: "acme-oidc", AutoRedirect: true}, {Name: "*.acme.example.org"}}},
		{Id: "t-3", Name: "umbrella-biotech", Alias: "umbrella-biotech", Enabled: proto.Bool(false), ResourceVersion: "1"},
	}
}

func jsonRequest(method, path, body string) *http.Request {
	req := asUser(method, path)
	req.Body = io.NopCloser(strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func decodeList(t *testing.T, rec *httptest.ResponseRecorder, into any) ListMeta {
	t.Helper()
	var env struct {
		Data json.RawMessage `json:"data"`
		Meta ListMeta        `json:"meta"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope %q: %v", rec.Body.String(), err)
	}
	if err := json.Unmarshal(env.Data, into); err != nil {
		t.Fatalf("decode data %q: %v", env.Data, err)
	}
	return env.Meta
}

// total is meta.Total, -1 when it is omitted.
func total(meta ListMeta) int {
	if meta.Total == nil {
		return -1
	}
	return *meta.Total
}

func TestListTenantsPagesAndFilters(t *testing.T) {
	fake := &backendtest.Fake{Tenants: seedTenants()}
	app := newTestApp(t, testConfig(t), fake)

	var list []Tenant
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	meta := decodeList(t, rec, &list)
	if len(list) != 3 || list[0].Name != "acme-robotics" || list[2].Name != "umbrella-biotech" {
		t.Fatalf("list = %+v", list)
	}
	if meta.Size != 3 || total(meta) != 3 || meta.Offset != 0 || meta.Limit != nil {
		t.Errorf("meta = %+v", meta)
	}
	if !strings.Contains(rec.Body.String(), `"meta":{"size":3,"total":3,"offset":0}`) {
		t.Errorf("limit is omitted when the caller asked for everything: %s", rec.Body.String())
	}
	acme := list[0]
	if acme.Alias != "acme-robotics" || !acme.Enabled || acme.Description != "Acme" || acme.Attributes["billing-account"] != "ACME-0042" || len(acme.Domains) != 2 {
		t.Errorf("acme = %+v", acme)
	}
	if len(acme.DomainDetails) != 2 || !acme.DomainDetails[0].Verified || acme.DomainDetails[0].IdentityProviderAlias != "acme-oidc" || !acme.DomainDetails[0].AutoRedirect || acme.DomainDetails[1].Name != "*.acme.example.org" {
		t.Errorf("domainDetails = %+v", acme.DomainDetails)
	}
	if u := list[2]; u.Enabled || u.Domains == nil || u.DomainDetails == nil || u.Attributes == nil {
		t.Errorf("collections are always present, enabled false kept: %s", rec.Body.String())
	}
	if fake.LastListTenants.Offset != nil || fake.LastListTenants.Limit != nil || fake.LastListTenants.Filter != nil {
		t.Errorf("no query means an empty request: %v", fake.LastListTenants)
	}

	// The filter is the client's CEL, forwarded byte for byte (the BFF
	// neither builds nor lowers nor checks it); the backend evaluates it.
	const byName = `this.name.lowerAscii().contains("\"bio\"") || this.domains.exists(d, d.lowerAscii().contains("\"bio\""))`
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?offset=1&limit=1&filter="+url.QueryEscape(byName)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	meta = decodeList(t, rec, &list)
	if fake.LastListTenants.GetOffset() != 1 || fake.LastListTenants.GetLimit() != 1 || fake.LastListTenants.GetFilter() != byName {
		t.Errorf("query not mapped to the request, got %v", fake.LastListTenants)
	}
	if meta.Offset != 1 || meta.Limit == nil || *meta.Limit != 1 {
		t.Errorf("meta echoes the page: %+v", meta)
	}
	for filter, want := range map[string]string{
		`this.name.lowerAscii().contains("bio") || this.domains.exists(d, d.lowerAscii().contains("bio"))`: "umbrella-biotech",
		`this.domains.exists(d, d.endsWith(".example.org"))`:                                               "acme-robotics",
		`this.alias != this.name`:            "globex-research",
		`!this.enabled`:                      "umbrella-biotech",
		"  this.name.startsWith(\"acme\")\n": "acme-robotics", // whitespace and all
	} {
		rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?filter="+url.QueryEscape(filter)))
		meta = decodeList(t, rec, &list)
		// Forwarded as written, only the surrounding whitespace trimmed.
		if rec.Code != http.StatusOK || len(list) != 1 || list[0].Name != want || total(meta) != 1 || fake.LastListTenants.GetFilter() != strings.TrimSpace(filter) {
			t.Errorf("filter %q = %d %+v %+v, request %q", filter, rec.Code, list, meta, fake.LastListTenants.GetFilter())
		}
	}
	// A repeated filter is 422: only one expression is evaluated, so the
	// second would be silently dropped.
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?filter=true&filter=false")); rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("repeated filter = %d %s", rec.Code, rec.Body.String())
	}
	// A whitespace-only parameter is no filter, so the shipped backend's 501
	// is not triggered by it.
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?filter=%20%20"))
	meta = decodeList(t, rec, &list)
	if rec.Code != http.StatusOK || fake.LastListTenants.Filter != nil || total(meta) != 3 {
		t.Errorf("whitespace filter = %d, request %v", rec.Code, fake.LastListTenants)
	}
	// An empty parameter is no filter.
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?filter="))
	meta = decodeList(t, rec, &list)
	if fake.LastListTenants.Filter != nil || total(meta) != 3 {
		t.Errorf("an empty filter sends none: %v", fake.LastListTenants)
	}
	// The backend's answer to a bad filter is the 422, with its message.
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?filter="+url.QueryEscape(`this.name ==`)))
	if rec.Code != http.StatusUnprocessableEntity || !strings.HasPrefix(decodeError(t, rec).Error.Message, "filter this.name == is not a valid CEL expression: ") {
		t.Errorf("bad filter = %d %s", rec.Code, rec.Body.String())
	}
	// The parameter the BFF used to turn into CEL is refused, so an old
	// client does not get the unfiltered list as its search result.
	for _, q := range []string{"search=bio", "search=", "filter=true&search=x"} {
		fake.Calls = nil
		rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?"+q))
		if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != `query parameter "search" is not supported; send a CEL filter in "filter"` || len(fake.Calls) != 0 {
			t.Errorf("%s = %d %s, calls %v", q, rec.Code, rec.Body.String(), fake.Calls)
		}
	}
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?limit=0"))
	meta = decodeList(t, rec, &list)
	if len(list) != 0 || meta.Size != 0 || total(meta) != 3 || meta.Limit == nil || *meta.Limit != 0 {
		t.Errorf("limit=0 counts only: %+v %+v", list, meta)
	}
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?offset=10&limit=5"))
	meta = decodeList(t, rec, &list)
	if len(list) != 0 || total(meta) != 3 || meta.Offset != 10 {
		t.Errorf("offset past the end is an empty page with the total: %+v %+v", list, meta)
	}
	for _, q := range []string{"offset=-1", "limit=x", "limit=-2", "limit=2147483648", "offset=4294967296", "limit=99999999999999999999"} {
		if rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?"+q)); rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s -> %d, want 422 (the request fields are int32)", q, rec.Code)
		}
	}
	// The largest int32 is accepted and reaches the backend unchanged.
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants?offset=2147483647&limit=2147483647"))
	meta = decodeList(t, rec, &list)
	if rec.Code != http.StatusOK || fake.LastListTenants.GetOffset() != math.MaxInt32 || fake.LastListTenants.GetLimit() != math.MaxInt32 || meta.Offset != math.MaxInt32 || len(list) != 0 {
		t.Errorf("max int32 = %d %+v, request %v", rec.Code, meta, fake.LastListTenants)
	}
}

func TestTenantFromTodaysBackend(t *testing.T) {
	// Fields 1-3 only: alias falls back to the name, details are derived and an
	// absent `enabled` reads as enabled (Keycloak's default), never as disabled.
	tn := toTenant(&aigridv1.Tenant{Id: "x", Name: "tenant-a", Domains: []string{"a.example.com"}})
	if tn.Alias != "tenant-a" || len(tn.DomainDetails) != 1 || tn.DomainDetails[0].Name != "a.example.com" || tn.Attributes == nil || !tn.Enabled {
		t.Errorf("tenant = %+v", tn)
	}
	if toTenant(&aigridv1.Tenant{Id: "x", Name: "off", Enabled: proto.Bool(false)}).Enabled {
		t.Error("an explicit false is kept")
	}
	fake := &backendtest.Fake{Tenants: []*aigridv1.Tenant{{Id: "t-1", Name: "tenant-a"}}}
	rec := serve(newTestApp(t, testConfig(t), fake), asUser(http.MethodGet, "/api/v1/tenants"))
	if !strings.Contains(rec.Body.String(), `"enabled":true`) {
		t.Errorf("today's backend must not render every tenant disabled: %s", rec.Body.String())
	}
	bare := toTenant(&aigridv1.Tenant{Id: "y", Name: "bare"})
	if bare.Domains == nil || bare.DomainDetails == nil || len(bare.Domains) != 0 {
		t.Errorf("bare = %+v", bare)
	}
}

func TestGetTenant(t *testing.T) {
	app := newTestApp(t, testConfig(t), &backendtest.Fake{Tenants: seedTenants()})
	var tn Tenant
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-2"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &tn)
	if tn.Name != "globex-research" || tn.Alias != "globex" {
		t.Errorf("tenant = %+v", tn)
	}
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants/missing"))
	if rec.Code != http.StatusNotFound || decodeError(t, rec).Error.Message != "object with identifier 'missing' not found" {
		t.Errorf("missing = %d %s", rec.Code, rec.Body.String())
	}
}

func TestCreateTenant(t *testing.T) {
	t.Run("201 with Location", func(t *testing.T) {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "wayne-aerospace", "description": "Wayne", "domains": ["wayne-aero.example.com"], "attributes": {"ai-grid/region": "us-east"}}`))
		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		var tn Tenant
		decodeData(t, rec, &tn)
		if tn.ID != "t-4" || tn.Name != "wayne-aerospace" || tn.Alias != "wayne-aerospace" || !tn.Enabled || tn.Description != "Wayne" || tn.Domains[0] != "wayne-aero.example.com" || tn.DomainDetails[0].Name != "wayne-aero.example.com" || tn.Attributes["ai-grid/region"] != "us-east" {
			t.Errorf("created = %+v", tn)
		}
		if loc := rec.Header().Get("Location"); loc != "/api/v1/tenants/t-4" {
			t.Errorf("Location = %q", loc)
		}
		sent := fake.LastCreateTenant.GetObject()
		if sent.Enabled != nil || sent.GetId() != "" || sent.GetAlias() != "" {
			t.Errorf("an absent enabled stays absent (the backend applies Keycloak's default), id and alias are left to the backend: %v", sent)
		}
		if got := fake.Metadata.Get("authorization"); len(got) != 1 || got[0] != "Bearer sha256~token" {
			t.Errorf("token not forwarded: %v", fake.Metadata)
		}
		rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "stark", "alias": "stark-industries", "enabled": false}`))
		if rec.Code != http.StatusCreated || fake.LastCreateTenant.GetObject().Enabled == nil || fake.LastCreateTenant.GetObject().GetEnabled() || fake.LastCreateTenant.GetObject().GetAlias() != "stark-industries" {
			t.Errorf("explicit enabled=false and alias are sent as given: %d %v", rec.Code, fake.LastCreateTenant)
		}
		if loc := rec.Header().Get("Location"); loc != "/api/v1/tenants/t-5" {
			t.Errorf("Location = %q", loc)
		}
	})

	t.Run("keycloak and body errors", func(t *testing.T) {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "acme-robotics"}`))
		if rec.Code != http.StatusConflict || decodeError(t, rec).Error.Message != "A organization with the same name already exists." {
			t.Errorf("duplicate = %d %s", rec.Code, rec.Body.String())
		}
		rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": ""}`))
		if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != "Name can not be null" {
			t.Errorf("blank name = %d %s", rec.Code, rec.Body.String())
		}
		for body, want := range map[string]string{
			`{"name": 1}`:                `invalid request body: field "name" must be a string`,
			`{"name": "x", "colour": 1}`: `invalid request body: json: unknown field "colour"`,
			`{`:                          "invalid request body: malformed JSON",
			``:                           "invalid request body: empty body",
			`null`:                       "invalid request body: must be a JSON object",
			`["acme"]`:                   "invalid request body: must be a JSON object",
		} {
			rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", body))
			if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != want {
				t.Errorf("%s -> %d %s, want 422 %q", body, rec.Code, rec.Body.String(), want)
			}
		}
		if rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "`+strings.Repeat("x", maxBodyBytes)+`"}`)); rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("oversized body = %d %s", rec.Code, rec.Body.String())
		}
		fake.LastCreateTenant = nil
		fake.Err = backendtest.Status(codes.InvalidArgument, "Domain acme.example.com is already linked to organization acme-robotics in realm ai-grid")
		rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "x", "domains": ["acme.example.com"]}`))
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(decodeError(t, rec).Error.Message, "already linked to organization acme-robotics") {
			t.Errorf("InvalidArgument -> %d %s, want 422 with Keycloak's message", rec.Code, rec.Body.String())
		}
		fake.Err = backendtest.Status(codes.PermissionDenied, `User "alice" is not a provider admin: cannot patch resource "managedclusters" in API group "cluster.open-cluster-management.io" at the cluster scope`)
		if rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "x"}`)); rec.Code != http.StatusForbidden || !strings.Contains(decodeError(t, rec).Error.Message, "not a provider admin") {
			t.Errorf("PermissionDenied -> %d %s", rec.Code, rec.Body.String())
		}
		fake.Err = backendtest.Status(codes.FailedPrecondition, `Keycloak realm "ai-grid": Realm not found.`)
		if rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "x"}`)); rec.Code != http.StatusPreconditionFailed {
			t.Errorf("FailedPrecondition -> %d", rec.Code)
		}
		fake.Err = backendtest.Status(codes.Unavailable, "Keycloak is unavailable: connection refused")
		if rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants")); rec.Code != http.StatusServiceUnavailable {
			t.Errorf("Unavailable -> %d", rec.Code)
		}
	})
}

// patchTenant is a tenant PATCH that carries If-Match: "<version>".
func patchTenant(id, version, body string) *http.Request {
	return withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/"+id, body), `"`+version+`"`)
}

func TestPatchTenant(t *testing.T) {
	t.Run("present fields become the mask", func(t *testing.T) {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, patchTenant("t-1", "1", `{"enabled": false, "description": "", "domains": ["acme.example.com"]}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		var tn Tenant
		decodeData(t, rec, &tn)
		if tn.Enabled || tn.Description != "" || len(tn.Domains) != 1 || tn.Name != "acme-robotics" || tn.Attributes["billing-account"] != "ACME-0042" {
			t.Errorf("patched = %+v", tn)
		}
		up := fake.LastUpdateTenant
		if paths := up.GetUpdateMask().GetPaths(); strings.Join(paths, ",") != "description,enabled,domains" {
			t.Errorf("mask = %v", paths)
		}
		if up.GetObject().GetId() != "t-1" || up.GetObject().GetName() != "" || up.GetObject().GetAlias() != "" || up.GetObject().GetResourceVersion() != "1" {
			t.Errorf("only the patched fields and the If-Match version travel: %v", up.GetObject())
		}
		rec = serve(app, patchTenant("t-1", "2", `{"attributes": {}, "domains": [], "name": "acme-eu", "alias": "acme-robotics"}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		up = fake.LastUpdateTenant
		if paths := up.GetUpdateMask().GetPaths(); strings.Join(paths, ",") != "name,alias,domains,attributes" {
			t.Errorf("mask = %v", paths)
		}
		if up.GetObject().GetAlias() != "acme-robotics" || len(up.GetObject().GetAttributes()) != 0 || len(up.GetObject().GetDomains()) != 0 {
			// An empty map or list is absent on the wire; the mask path is what tells the backend to clear it.
			t.Errorf("alias travels in the object, cleared collections are empty: %v", up.GetObject())
		}
		var cleared Tenant
		decodeData(t, rec, &cleared)
		if len(cleared.Domains) != 0 || len(cleared.Attributes) != 0 || cleared.Name != "acme-eu" {
			t.Errorf("cleared = %+v", cleared)
		}
	})

	t.Run("null leaves a field alone and is not in the mask", func(t *testing.T) {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, patchTenant("t-1", "1", `{"domains": null, "attributes": null, "description": null, "enabled": false}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		if paths := fake.LastUpdateTenant.GetUpdateMask().GetPaths(); strings.Join(paths, ",") != "enabled" {
			t.Errorf("null must not put a path in the mask, got %v", paths)
		}
		var tn Tenant
		decodeData(t, rec, &tn)
		if len(tn.Domains) != 2 || tn.Attributes["billing-account"] != "ACME-0042" || tn.Description != "Acme" || tn.Enabled {
			t.Errorf("patched = %+v", tn)
		}
	})

	t.Run("an empty body is 422; the alias goes to the backend", func(t *testing.T) {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		rec := serve(app, patchTenant("t-2", "9", `{}`))
		if rec.Code != http.StatusUnprocessableEntity || len(fake.Calls) != 0 {
			t.Errorf("empty patch = %d, calls %v", rec.Code, fake.Calls)
		}
		// The alias is a mask path like the others; the backend keeps the
		// stored one, so sending it back changes nothing and keeps the version.
		rec = serve(app, patchTenant("t-2", "1", `{"alias": "globex"}`))
		if rec.Code != http.StatusOK || strings.Join(fake.LastUpdateTenant.GetUpdateMask().GetPaths(), ",") != "alias" || fake.LastUpdateTenant.GetObject().GetAlias() != "globex" || rec.Header().Get("ETag") != `"1"` {
			t.Errorf("same alias = %d %s, update %v", rec.Code, rec.Body.String(), fake.LastUpdateTenant)
		}
		// A different one is the backend's answer, Keycloak's text.
		for _, body := range []string{`{"alias": "globex-2"}`, `{"alias": "globex-2", "enabled": false}`} {
			fake.LastUpdateTenant = nil
			rec = serve(app, patchTenant("t-2", "1", body))
			if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != "Cannot change the alias" || fake.LastUpdateTenant == nil {
				t.Errorf("%s = %d %s", body, rec.Code, rec.Body.String())
			}
		}
	})

	t.Run("errors", func(t *testing.T) {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		if rec := serve(app, patchTenant("missing", "1", `{"enabled": true}`)); rec.Code != http.StatusNotFound {
			t.Errorf("missing = %d", rec.Code)
		}
		for body, want := range map[string]string{
			`{"enabled": "yes"}`: `invalid request body: field "enabled" must be true or false`,
			`{"version": 3}`:     `invalid request body: json: unknown field "version"`,
			`{"domains": "a"}`:   `invalid request body: field "domains" must be an array`,
			`{"enabled": true}}`: "invalid request body: unexpected content after the JSON object",
			`null`:               "invalid request body: must be a JSON object",
		} {
			rec := serve(app, patchTenant("t-1", "1", body))
			if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != want {
				t.Errorf("%s -> %d %s, want 422 %q", body, rec.Code, rec.Body.String(), want)
			}
		}
		// A blank name is Keycloak's 409, not a 422 (see UpdateTenant in the fake backend).
		if rec := serve(app, patchTenant("t-1", "1", `{"name": ""}`)); rec.Code != http.StatusConflict || decodeError(t, rec).Error.Message != "A organization with the same name already exists." {
			t.Errorf("blank name = %d %s, want 409 with Keycloak's message", rec.Code, rec.Body.String())
		}
		fake.Err = backendtest.Status(codes.AlreadyExists, "A organization with the same name already exists.")
		if rec := serve(app, patchTenant("t-1", "1", `{"name": "globex-research"}`)); rec.Code != http.StatusConflict {
			t.Errorf("rename conflict = %d", rec.Code)
		}
	})
}

// TestTenantCarriesTheBackendsCreateTime: createTime is the backend's (P3),
// omitted when it sends none.
func TestTenantCarriesTheBackendsCreateTime(t *testing.T) {
	created := time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)
	raw, err := json.Marshal(toTenant(&aigridv1.Tenant{Id: "t-1", ResourceVersion: "4", CreateTime: timestamppb.New(created)}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"resourceVersion":"4","createTime":"2026-09-01T09:00:00Z"`) {
		t.Fatalf("tenant with a creation time: %s", raw)
	}
	raw, err = json.Marshal(toTenant(&aigridv1.Tenant{Id: "t-1"}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "createTime") {
		t.Fatalf("tenant without a creation time: %s", raw)
	}
}

func TestDeleteTenant(t *testing.T) {
	fake := &backendtest.Fake{Tenants: seedTenants()}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-3"), `"1"`))
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("delete = %d %q", rec.Code, rec.Body.String())
	}
	if fake.LastDeleteTenant.GetId() != "t-3" || len(fake.Tenants) != 2 {
		t.Errorf("delete request = %v, tenants left %d", fake.LastDeleteTenant, len(fake.Tenants))
	}
	rec = serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-3"), `"1"`))
	if rec.Code != http.StatusNotFound || decodeError(t, rec).Error.Message != "object with identifier 't-3' not found" {
		t.Errorf("second delete = %d %s", rec.Code, rec.Body.String())
	}
	// A tenant created after a delete gets a fresh id, never a recycled one.
	var created Tenant
	rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "after-delete"}`))
	decodeData(t, rec, &created)
	if rec.Code != http.StatusCreated || created.ID != "t-4" {
		t.Errorf("created after delete = %d %+v, want id t-4", rec.Code, created)
	}
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-3")); rec.Code != http.StatusNotFound {
		t.Errorf("the deleted id must stay gone: %d", rec.Code)
	}
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-3")); rec.Code != http.StatusNotFound {
		t.Errorf("get after delete = %d", rec.Code)
	}
	fake.Err = backendtest.Status(codes.PermissionDenied, "User \"alice\" is not a provider admin")
	if rec := serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-1"), `"1"`)); rec.Code != http.StatusForbidden {
		t.Errorf("denied delete = %d", rec.Code)
	}
	if rec := serve(app, httptest.NewRequest(http.MethodDelete, "/api/v1/tenants/t-1", nil)); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous delete = %d", rec.Code)
	}
}

func TestTenantVersions(t *testing.T) {
	tenants := seedTenants()
	tenants[1].ResourceVersion = "4" // acme-robotics, t-1
	fake := &backendtest.Fake{Tenants: tenants}
	app := newTestApp(t, testConfig(t), fake)

	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-1"))
	var got Tenant
	decodeData(t, rec, &got)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"4"` || got.ResourceVersion != "4" {
		t.Fatalf("GET = %d, ETag %q, resourceVersion %q", rec.Code, rec.Header().Get("ETag"), got.ResourceVersion)
	}

	// A stale tab: 409, nothing written.
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", `{"description": "stale"}`), `"3"`))
	if rec.Code != http.StatusConflict || fake.LastUpdateTenant.GetObject().GetResourceVersion() != "3" {
		t.Fatalf("stale PATCH = %d %s, request %v", rec.Code, rec.Body.String(), fake.LastUpdateTenant)
	}
	if fake.Tenants[1].GetDescription() != "Acme" || fake.Tenants[1].GetResourceVersion() != "4" {
		t.Errorf("a stale write must not land: %v", fake.Tenants[1])
	}
	// The current version writes and answers the next one.
	rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", `{"description": "fresh"}`), `"4"`))
	decodeData(t, rec, &got)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `"5"` || got.Description != "fresh" || got.ResourceVersion != "5" {
		t.Fatalf("matching PATCH = %d, ETag %q, %+v", rec.Code, rec.Header().Get("ETag"), got)
	}
	// Without If-Match the PATCH is 428 and reaches nothing: every write
	// carries the version the client read.
	fake.Calls = nil
	rec = serve(app, jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", `{"description": "unchecked"}`))
	if rec.Code != http.StatusPreconditionRequired || decodeError(t, rec).Error.Code != "428" || len(fake.Calls) != 0 {
		t.Errorf("PATCH without If-Match = %d %s, calls %v", rec.Code, rec.Body.String(), fake.Calls)
	}
	// A PATCH that sets no field is 422, so a stale If-Match is never
	// answered with the current object.
	if rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", `{}`), `"1"`)); rec.Code != http.StatusUnprocessableEntity || rec.Header().Get("ETag") != "" {
		t.Errorf("empty PATCH with a stale If-Match = %d, ETag %q", rec.Code, rec.Header().Get("ETag"))
	}
	if rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", `{"enabled": false}`), `5`)); rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("an unquoted If-Match = %d, want 422", rec.Code)
	}

	// DELETE: stale is 409 and keeps the tenant, current deletes.
	rec = serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-1"), `"4"`))
	if rec.Code != http.StatusConflict || fake.LastDeleteTenant.GetResourceVersion() != "4" || len(fake.Tenants) != 3 {
		t.Fatalf("stale DELETE = %d %s, request %v", rec.Code, rec.Body.String(), fake.LastDeleteTenant)
	}
	if rec := serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-1"), `"5"`)); rec.Code != http.StatusNoContent || len(fake.Tenants) != 2 {
		t.Errorf("matching DELETE = %d", rec.Code)
	}
	// Without If-Match the delete is 428 and reaches nothing.
	fake.Calls = nil
	if rec := serve(app, asUser(http.MethodDelete, "/api/v1/tenants/t-2")); rec.Code != http.StatusPreconditionRequired || len(fake.Calls) != 0 || len(fake.Tenants) != 2 {
		t.Errorf("DELETE without If-Match = %d, calls %v", rec.Code, fake.Calls)
	}
	// A created tenant comes back with its first version.
	rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "new-org"}`))
	if rec.Code != http.StatusCreated || rec.Header().Get("ETag") != `"1"` {
		t.Errorf("POST = %d, ETag %q", rec.Code, rec.Header().Get("ETag"))
	}
	// A backend that keeps no version (today's) sends no ETag and no field.
	fake.Tenants = append(fake.Tenants, &aigridv1.Tenant{Id: "t-9", Name: "unversioned"})
	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-9"))
	if rec.Header().Get("ETag") != "" || strings.Contains(rec.Body.String(), "resourceVersion") {
		t.Errorf("no version: ETag %q, body %s", rec.Header().Get("ETag"), rec.Body.String())
	}
}

// The shipped backend's ListTenantsRequest is empty: it drops offset, limit
// and filter and returns every tenant with no total. Asking it for a filter
// or a page is 501, never the unfiltered rows as if they were the result.
func TestTenantFilterAndPagingOnTheShippedBackend(t *testing.T) {
	var many []*aigridv1.Tenant
	for i := range 8 {
		many = append(many, &aigridv1.Tenant{Id: fmt.Sprintf("t-%d", i+1), Name: fmt.Sprintf("org-%d", i+1)})
	}
	fake := &backendtest.Fake{Tenants: many, ShippedLists: true}
	app := newTestApp(t, testConfig(t), fake)
	for _, q := range []string{"filter=false&limit=5", "filter=" + url.QueryEscape(`this.name == "org-1"`), "limit=5", "offset=3", "offset=1&limit=100"} {
		rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?"+q))
		if rec.Code != http.StatusNotImplemented {
			t.Errorf("%s on the shipped backend = %d %s, want 501", q, rec.Code, rec.Body.String())
			continue
		}
		if msg := decodeError(t, rec).Error.Message; msg != "the AI Grid backend does not support filtering or paging tenants yet; list them without filter, offset or limit" {
			t.Errorf("message = %q", msg)
		}
	}
	// No filter and no page (offset=0 is the start anyway): the full list,
	// with the size as the total because nothing precedes it.
	for _, q := range []string{"", "?offset=0", "?filter="} {
		var list []Tenant
		rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants"+q))
		if rec.Code != http.StatusOK {
			t.Fatalf("%q = %d %s", q, rec.Code, rec.Body.String())
		}
		if meta := decodeList(t, rec, &list); len(list) != 8 || meta.Size != 8 || total(meta) != 8 {
			t.Errorf("%q = %d tenants, meta %+v", q, len(list), meta)
		}
	}
}

// idpJSON is an identity provider in the console's JSON, the PoC's shape.
const idpJSON = `{"title": "Acme SSO", "description": "Acme employees sign in here.", "enabled": true, "config": {"clientId": "ai-grid", "clientSecretSecret": {"name": "acme-oidc-client"}, "issuer": "https://sso.example.com/realms/acme", "authorizationUrl": "https://sso.example.com/realms/acme/auth", "tokenUrl": "https://sso.example.com/realms/acme/token", "defaultScopes": "openid", "userInfoUrl": "", "jwksUrl": "https://sso.example.com/realms/acme/certs", "logoutUrl": "", "validateSignature": false}}`

// TestTenantIdentityProviderRoundTrips: the identity provider (P1) travels
// from POST to the backend and back, and a PATCH of only identityProvider
// masks only identity_provider, so the domains stay.
func TestTenantIdentityProviderRoundTrips(t *testing.T) {
	fake := &backendtest.Fake{Tenants: seedTenants()}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "wayne-aerospace", "domains": ["wayne-aero.example.com"], "identityProvider": `+idpJSON+`}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	sent := fake.LastCreateTenant.GetObject().GetIdentityProvider()
	if sent.GetTitle() != "Acme SSO" || sent.Enabled == nil || !sent.GetEnabled() || sent.GetConfig().GetClientSecretSecretName() != "acme-oidc-client" ||
		sent.GetConfig().GetJwksUrl() != "https://sso.example.com/realms/acme/certs" || sent.GetConfig().ValidateSignature == nil || sent.GetConfig().GetValidateSignature() {
		t.Fatalf("identity provider sent = %v", sent)
	}

	rec = serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-4"))
	var got map[string]any
	decodeData(t, rec, &got)
	want := map[string]any{}
	if err := json.Unmarshal([]byte(idpJSON), &want); err != nil {
		t.Fatal(err)
	}
	if gotIdP, _ := json.Marshal(got["identityProvider"]); string(gotIdP) != string(mustMarshal(t, want)) {
		t.Fatalf("GET identityProvider = %s, want %s", gotIdP, mustMarshal(t, want))
	}

	rec = serve(app, patchTenant("t-4", "1", `{"identityProvider": `+strings.Replace(idpJSON, "Acme SSO", "Wayne SSO", 1)+`}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", rec.Code, rec.Body)
	}
	if paths := fake.LastUpdateTenant.GetUpdateMask().GetPaths(); len(paths) != 1 || paths[0] != "identity_provider" {
		t.Errorf("mask = %v, want [identity_provider]", paths)
	}
	var tn Tenant
	decodeData(t, rec, &tn)
	if tn.IdentityProvider == nil || tn.IdentityProvider.Title != "Wayne SSO" || len(tn.Domains) != 1 || tn.Domains[0] != "wayne-aero.example.com" {
		t.Errorf("patched = %+v", tn)
	}

	// The client secret itself has no field: strict decoding refuses it.
	rec = serve(app, patchTenant("t-4", "2", `{"identityProvider": {"config": {"clientSecret": "s3cr3t"}}}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(decodeError(t, rec).Error.Message, `unknown field "clientSecret"`) {
		t.Errorf("client secret value = %d %s", rec.Code, rec.Body)
	}
}

// TestPatchWithoutIdentityProviderKeepsIt: a PATCH that leaves out
// identityProvider doesn't name it in the mask, and a tenant without one
// has no identityProvider key.
func TestPatchWithoutIdentityProviderKeepsIt(t *testing.T) {
	fake := &backendtest.Fake{Tenants: seedTenants()}
	app := newTestApp(t, testConfig(t), fake)
	if rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-1")); strings.Contains(rec.Body.String(), `"identityProvider":`) {
		t.Fatalf("a tenant without an identity provider: %s", rec.Body)
	}
	fake.Tenants[1].IdentityProvider = &aigridv1.IdentityProvider{Title: "Acme SSO", Enabled: proto.Bool(true), Config: &aigridv1.OidcConfig{ClientId: "ai-grid"}}
	rec := serve(app, patchTenant("t-1", "1", `{"domains": ["acme.example.com"]}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", rec.Code, rec.Body)
	}
	if paths := fake.LastUpdateTenant.GetUpdateMask().GetPaths(); len(paths) != 1 || paths[0] != "domains" {
		t.Errorf("mask = %v, want [domains]", paths)
	}
	var tn Tenant
	decodeData(t, rec, &tn)
	if tn.IdentityProvider == nil || tn.IdentityProvider.Title != "Acme SSO" || tn.IdentityProvider.Config == nil || tn.IdentityProvider.Config.ClientID != "ai-grid" {
		t.Errorf("identity provider kept = %+v", tn.IdentityProvider)
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
