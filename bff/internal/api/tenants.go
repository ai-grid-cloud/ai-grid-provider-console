package api

import (
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Tenant is a consumer organisation. The backend reads them from Keycloak
// Organizations in the AI Grid realm; the JSON carries what Keycloak's full
// representation carries, with the collections always present (Keycloak
// omits an empty `domains`, the console does not).
type Tenant struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Alias       string `json:"alias"`
	Enabled     bool   `json:"enabled"`
	Description string `json:"description"`
	// Domains are the names of DomainDetails, in the same order.
	Domains       []string          `json:"domains"`
	DomainDetails []TenantDomain    `json:"domainDetails"`
	Attributes    map[string]string `json:"attributes"`
}

// TenantDomain is one organization domain with Keycloak's metadata.
type TenantDomain struct {
	Name                  string `json:"name"`
	Verified              bool   `json:"verified"`
	IdentityProviderAlias string `json:"identityProviderAlias,omitempty"`
	AutoRedirect          bool   `json:"autoRedirect"`
}

// Tenant JSON maps. Keys of the PATCH body; they double as the field-mask
// paths the backend accepts, apart from `alias`, which travels in the object
// so the backend can answer "Cannot change the alias" like Keycloak.
const (
	maskName        = "name"
	maskDomains     = "domains"
	maskEnabled     = "enabled"
	maskDescription = "description"
	maskAttributes  = "attributes"
)

func toTenant(t *aigridv1.Tenant) Tenant {
	domains := t.GetDomains()
	if domains == nil {
		domains = []string{}
	}
	details := make([]TenantDomain, 0, len(t.GetDomainDetails()))
	for _, d := range t.GetDomainDetails() {
		details = append(details, TenantDomain{Name: d.GetName(), Verified: d.GetVerified(), IdentityProviderAlias: d.GetIdentityProviderAlias(), AutoRedirect: d.GetAutoRedirect()})
	}
	if len(details) == 0 {
		// A backend that only fills fields 1-3 (today's) sends names only.
		for _, name := range domains {
			details = append(details, TenantDomain{Name: name})
		}
	}
	attributes := t.GetAttributes()
	if attributes == nil {
		attributes = map[string]string{}
	}
	alias := t.GetAlias()
	if alias == "" {
		alias = t.GetName() // Keycloak defaults the alias to the name; today's backend does not send it
	}
	// A backend that does not fill `enabled` (today's, fields 1-3 only) is
	// read as enabled: Keycloak's default, and the only value under which
	// every organization is usable.
	enabled := t.Enabled == nil || t.GetEnabled()
	return Tenant{
		ID: t.GetId(), Name: t.GetName(), Alias: alias, Enabled: enabled, Description: t.GetDescription(),
		Domains: domains, DomainDetails: details, Attributes: attributes,
	}
}

// queryInt reads an optional non-negative integer query parameter. The
// request fields are int32, so the value is parsed as one: a larger number
// is 422 instead of wrapping on its way into the proto.
func queryInt(r *http.Request, name string) (*int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	v64, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || v64 < 0 {
		return nil, Errorf(http.StatusUnprocessableEntity, fmt.Sprintf("query parameter %q must be an integer between 0 and %d", name, math.MaxInt32))
	}
	v := int(v64)
	return &v, nil
}

// searchFilter turns the `search` query into the CEL expression that means
// what Keycloak's `search` parameter does, a case-insensitive contains on the
// name or on any domain, so a backend that evaluates the filter as written
// and one that pushes it down to Keycloak return the same tenants. The term
// is a CEL string literal.
func searchFilter(term string) string {
	literal := `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(term) + `"`
	return `this.name.contains(` + literal + `) || this.domains.exists(d, d.contains(` + literal + `))`
}

// listTenants answers GET /api/v1/tenants?offset=&limit=&search=. The
// backend returns them in Keycloak's order (by name); `meta` carries the
// page, with `total` counted over the whole search result.
func (a *App) listTenants(w http.ResponseWriter, r *http.Request) {
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
	req := &aigridv1.ListTenantsRequest{}
	if offset != nil {
		req.Offset = proto.Int32(int32(*offset))
	}
	if limit != nil {
		req.Limit = proto.Int32(int32(*limit))
	}
	if search := strings.TrimSpace(r.URL.Query().Get("search")); search != "" {
		req.Filter = proto.String(searchFilter(search))
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.ListTenants(ctx, req)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out := make([]Tenant, 0, len(resp.GetTenants()))
	for _, t := range resp.GetTenants() {
		out = append(out, toTenant(t))
	}
	meta := ListMeta{Size: len(out), Total: int(resp.GetTotal()), Limit: limit}
	if offset != nil {
		meta.Offset = *offset
	}
	if meta.Total < meta.Size {
		meta.Total = meta.Size // a backend that does not count (today's) at least reports what it sent
	}
	writeList(w, http.StatusOK, out, meta)
}

// getTenant answers GET /api/v1/tenants/{id}.
func (a *App) getTenant(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: r.PathValue("id")})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, toTenant(resp.GetObject()))
}

// TenantCreate is the body of POST /api/v1/tenants. `name` is required;
// `alias` defaults to the name; `enabled` defaults to true (Keycloak's
// default for an omitted key); `domains` are names with default metadata.
type TenantCreate struct {
	Name        string            `json:"name"`
	Alias       string            `json:"alias"`
	Description string            `json:"description"`
	Enabled     *bool             `json:"enabled"`
	Domains     []string          `json:"domains"`
	Attributes  map[string]string `json:"attributes"`
}

// createTenant answers POST /api/v1/tenants: 201 with the created tenant and
// a Location header. Validation is the backend's (Keycloak's messages come
// back as 422, a taken name or alias as 409).
func (a *App) createTenant(w http.ResponseWriter, r *http.Request) {
	var body TenantCreate
	if err := decodeBody(w, r, &body); err != nil {
		a.respondError(w, r, err)
		return
	}
	// `enabled` is passed through as given; absent stays absent and the
	// backend applies Keycloak's default (true).
	obj := &aigridv1.Tenant{Name: body.Name, Alias: body.Alias, Description: body.Description, Enabled: body.Enabled, Domains: body.Domains, Attributes: body.Attributes}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: obj})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	t := toTenant(resp.GetObject())
	a.logger.Info("tenant created", "id", t.ID, "name", t.Name)
	w.Header().Set("Location", APIPrefix+"/tenants/"+url.PathEscape(t.ID))
	writeData(w, http.StatusCreated, t)
}

// TenantPatch is the body of PATCH /api/v1/tenants/{id}. Every field is
// optional and an absent field is left alone; a present field replaces the
// stored one as a whole (`domains: []` removes every domain, `attributes: {}`
// every attribute). `alias` may be sent but must equal the stored alias.
type TenantPatch struct {
	Name        *string            `json:"name"`
	Alias       *string            `json:"alias"`
	Description *string            `json:"description"`
	Enabled     *bool              `json:"enabled"`
	Domains     *[]string          `json:"domains"`
	Attributes  *map[string]string `json:"attributes"`
}

// patchTenant answers PATCH /api/v1/tenants/{id}: the present fields become
// the field mask of one UpdateTenant call; the backend does Keycloak's GET,
// merge and PUT.
func (a *App) patchTenant(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var patch TenantPatch
	if err := decodeBody(w, r, &patch); err != nil {
		a.respondError(w, r, err)
		return
	}
	obj := &aigridv1.Tenant{Id: id}
	var paths []string
	if patch.Name != nil {
		obj.Name = *patch.Name
		paths = append(paths, maskName)
	}
	if patch.Alias != nil {
		obj.Alias = *patch.Alias
	}
	if patch.Description != nil {
		obj.Description = *patch.Description
		paths = append(paths, maskDescription)
	}
	if patch.Enabled != nil {
		obj.Enabled = patch.Enabled
		paths = append(paths, maskEnabled)
	}
	if patch.Domains != nil {
		obj.Domains = *patch.Domains
		if obj.Domains == nil {
			obj.Domains = []string{}
		}
		paths = append(paths, maskDomains)
	}
	if patch.Attributes != nil {
		obj.Attributes = *patch.Attributes
		if obj.Attributes == nil {
			obj.Attributes = map[string]string{}
		}
		paths = append(paths, maskAttributes)
	}

	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	if len(paths) == 0 {
		// Nothing to write: answer with the current object. An alias on its
		// own is only checked against it (Keycloak's wording), so a no-op
		// round trip does not become a PUT and an admin event.
		resp, err := a.backend.Tenants.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: id})
		if err != nil {
			a.respondError(w, r, err)
			return
		}
		cur := resp.GetObject()
		if patch.Alias != nil && *patch.Alias != "" && *patch.Alias != cur.GetAlias() {
			a.respondError(w, r, Errorf(http.StatusUnprocessableEntity, "Cannot change the alias"))
			return
		}
		writeData(w, http.StatusOK, toTenant(cur))
		return
	}
	resp, err := a.backend.Tenants.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{Object: obj, UpdateMask: &fieldmaskpb.FieldMask{Paths: paths}})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	a.logger.Info("tenant updated", "id", id, "paths", paths)
	writeData(w, http.StatusOK, toTenant(resp.GetObject()))
}

// deleteTenant answers DELETE /api/v1/tenants/{id} with 204.
func (a *App) deleteTenant(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	if _, err := a.backend.Tenants.DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: id}); err != nil {
		a.respondError(w, r, err)
		return
	}
	a.logger.Info("tenant deleted", "id", id)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
