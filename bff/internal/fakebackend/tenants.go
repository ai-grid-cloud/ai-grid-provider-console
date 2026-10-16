package fakebackend

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Tenants are Keycloak Organizations behind the backend's mapping
// (mock/research/keycloak.md sections 3, 5 and 8; backend-conventions.md 6.6).
// The store is a map of organizations keyed by UUID; every RPC does what the
// real backend does with Keycloak 26.8: the same uniqueness rules, the same
// validation messages, the same defaults, and the gRPC code the error table
// in keycloak.md 8.2 assigns to each Keycloak outcome.

// filterPattern is the one CEL form ListTenants supports, the expression that
// means what Keycloak's `search` does:
// `this.name.contains("<term>") || this.domains.exists(d, d.contains("<term>"))`
// with the same string literal (CEL escapes `\"` and `\\`) in both places.
var filterPattern = regexp.MustCompile(`^this\.name\.contains\("((?:[^"\\]|\\.)*)"\) \|\| this\.domains\.exists\(d, d\.contains\("((?:[^"\\]|\\.)*)"\)\)$`)

const supportedFilter = `this.name.contains("<term>") || this.domains.exists(d, d.contains("<term>"))`

// searchTerm extracts the Keycloak `search` value from the filter, or
// reports InvalidArgument for any other expression.
func searchTerm(filter string) (string, error) {
	if filter == "" {
		return "", nil
	}
	m := filterPattern.FindStringSubmatch(filter)
	if m == nil || m[1] != m[2] {
		return "", status.Errorf(codes.InvalidArgument, "filter %s is not supported; this server only evaluates %s", filter, supportedFilter)
	}
	term := strings.NewReplacer(`\"`, `"`, `\\`, `\`).Replace(m[1])
	return term, nil
}

// matchesSearch is the contract's search: a case-insensitive literal
// substring match on the name or on any domain (domains are stored
// lower-case). Keycloak's `search` is a SQL `LIKE %term%` built without
// escaping, so a backend that pushes the term down must escape `%` and `_`
// first (ListTenantsRequest.filter in the proto); the fake's literal match is
// the reference behaviour.
func matchesSearch(t *aigridv1.Tenant, term string) bool {
	if term == "" {
		return true
	}
	term = strings.ToLower(term)
	if strings.Contains(strings.ToLower(t.GetName()), term) {
		return true
	}
	for _, d := range t.GetDomains() {
		if strings.Contains(d, term) {
			return true
		}
	}
	return false
}

// beginTenants is what every Tenants RPC does after authentication and the
// round trip: fail the way the backend fails when Keycloak is unreachable or
// the realm is missing, before touching the store. Must be called under s.mu.
func (s *Server) beginTenants() error {
	if s.TenantsErr != nil {
		return s.TenantsErr
	}
	// Keycloak answers 404 {"error":"Realm not found."} or
	// {"errorMessage":"Organizations not enabled for this realm."}; the
	// conventions make both FailedPrecondition (deployment misconfiguration,
	// not a caller error). The wrapping text `Keycloak realm "<realm>": ` is
	// the console's proposal (keycloak.md 8.2), not something Keycloak says.
	if s.realmMissing {
		return status.Errorf(codes.FailedPrecondition, "Keycloak realm %q: %s", KeycloakRealm, MsgRealmMissing)
	}
	if s.orgsDisabled {
		return status.Errorf(codes.FailedPrecondition, "Keycloak realm %q: %s", KeycloakRealm, MsgOrgsNotEnabled)
	}
	return nil
}

// ListTenants implements Tenants: `offset`/`limit` are Keycloak's `first`/`max`
// (omitted limit means all, zero means count only, negative is
// InvalidArgument), `total` is what `GET /organizations/count` returns for
// the same search, results are ordered by name and disabled organizations
// are included like Keycloak includes them. The order is Go byte order, an
// approximation of the realm database's collation (PostgreSQL on the hub,
// whose typical locale is case-insensitive); the fixtures are all lower-case
// so the two agree today.
func (s *Server) ListTenants(ctx context.Context, req *aigridv1.ListTenantsRequest) (*aigridv1.ListTenantsResponse, error) {
	if _, err := s.begin(ctx); err != nil {
		return nil, err
	}
	term, err := searchTerm(req.GetFilter())
	if err != nil {
		return nil, err
	}
	if req.GetOrder() != "" {
		return nil, status.Error(codes.InvalidArgument, "order is not supported by this server yet; Keycloak returns organizations by name")
	}
	if req.GetOffset() < 0 {
		return nil, status.Errorf(codes.InvalidArgument, "offset must not be negative, got %d", req.GetOffset())
	}
	if req.Limit != nil && req.GetLimit() < 0 {
		return nil, status.Errorf(codes.InvalidArgument, "limit must not be negative, got %d", req.GetLimit())
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.beginTenants(); err != nil {
		return nil, err
	}
	// Filter and sort references under the lock; only the page that leaves
	// the lock is cloned, so a count-only or small-page request does not
	// copy the whole realm.
	all := make([]*aigridv1.Tenant, 0, len(s.tenants))
	for _, t := range s.tenants {
		if matchesSearch(t, term) {
			all = append(all, t)
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].GetName() < all[j].GetName() })
	total := len(all)
	offset := min(int(req.GetOffset()), total)
	window := all[offset:]
	if req.Limit != nil && int(req.GetLimit()) < len(window) {
		window = window[:req.GetLimit()]
	}
	page := make([]*aigridv1.Tenant, 0, len(window))
	for _, t := range window {
		page = append(page, cloneTenant(t))
	}
	return &aigridv1.ListTenantsResponse{Tenants: page, Size: int32(len(page)), Total: int32(total)}, nil
}

// GetTenant implements Tenants. Keycloak answers 404 "Organization not
// found."; the backend maps that to NotFound with the conventions' message
// and keeps Keycloak's text in its log, as this does.
func (s *Server) GetTenant(ctx context.Context, req *aigridv1.GetTenantRequest) (*aigridv1.GetTenantResponse, error) {
	if _, err := s.begin(ctx); err != nil {
		return nil, err
	}
	if req.GetId() == "" {
		// Request-shape check before Keycloak is called; the text is the
		// console's (Keycloak would say "Id cannot be null.").
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.beginTenants(); err != nil {
		return nil, err
	}
	t, ok := s.tenants[req.GetId()]
	if !ok {
		return nil, s.tenantNotFound(req.GetId())
	}
	return &aigridv1.GetTenantResponse{Object: cloneTenant(t)}, nil
}

func (s *Server) tenantNotFound(id string) error {
	s.logger.Debug("keycloak", "status", 404, "errorMessage", MsgOrganizationMissing, "id", id)
	return notFound(id)
}

// CreateTenant implements Tenants in the order Keycloak checks a POST
// (OrganizationsResource.create L112-118, then JpaOrganizationProvider.create
// L102-121, then RepresentationToModel.toModel): explicit alias characters,
// blank name, alias defaulting to the name and the name's characters,
// duplicate name, duplicate alias, and only then the domains. Everything
// Keycloak decides comes after the Keycloak gate (beginTenants), because the
// real backend learns those answers from Keycloak and answers Unavailable
// without it; only the request-shape checks precede it. The real backend
// follows the 201's Location with a GET and returns the object; the fake
// returns the stored object directly.
func (s *Server) CreateTenant(ctx context.Context, req *aigridv1.CreateTenantRequest) (*aigridv1.CreateTenantResponse, error) {
	token, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.authorizeProviderAdmin(ctx, token); err != nil {
		return nil, err
	}
	obj := req.GetObject()
	if obj == nil {
		// Console wording; Keycloak's own is "Organization cannot be null."
		return nil, status.Error(codes.InvalidArgument, "object is required")
	}
	if obj.GetId() != "" {
		// Console rule (see CreateTenantRequest in the proto): Keycloak
		// itself ignores a client id on POST.
		return nil, status.Error(codes.InvalidArgument, "object.id must be empty; Keycloak assigns it")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.beginTenants(); err != nil {
		return nil, err
	}
	if obj.GetAlias() != "" {
		if err := validateAlias(obj.GetAlias()); err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
	}
	if strings.TrimSpace(obj.GetName()) == "" {
		return nil, status.Error(codes.InvalidArgument, MsgNameRequired)
	}
	t := cloneTenant(obj)
	if strings.TrimSpace(t.GetAlias()) == "" {
		t.Alias = t.GetName()
		if err := validateAlias(t.GetAlias()); err != nil {
			return nil, status.Error(codes.InvalidArgument, MsgNameNotAliasPrefix+err.Error())
		}
	}
	for _, other := range s.tenants {
		if other.GetName() == t.GetName() {
			return nil, status.Error(codes.AlreadyExists, MsgDuplicateName)
		}
	}
	for _, other := range s.tenants {
		if other.GetAlias() == t.GetAlias() {
			return nil, status.Error(codes.AlreadyExists, MsgDuplicateAlias)
		}
	}
	if err := normalizeDomains(t); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if err := s.checkDomainsFree(t, ""); err != nil {
		return nil, err
	}
	if t.Enabled == nil {
		t.Enabled = proto.Bool(true) // OrganizationRepresentation.enabled defaults to true
	}
	if t.Attributes == nil {
		t.Attributes = map[string]string{}
	}
	t.Id = s.newID()
	s.tenants[t.Id] = t
	s.logger.Debug("organization created", "id", t.GetId(), "name", t.GetName(), "alias", t.GetAlias())
	return &aigridv1.CreateTenantResponse{Object: cloneTenant(t)}, nil
}

// checkDomainsFree is the realm-wide domain uniqueness Keycloak enforces
// when it claims domains for an organization. Must be called under s.mu.
func (s *Server) checkDomainsFree(t *aigridv1.Tenant, selfID string) error {
	for _, d := range t.GetDomains() {
		for id, other := range s.tenants {
			if id != selfID && slices.Contains(other.GetDomains(), d) {
				return status.Errorf(codes.InvalidArgument, MsgDomainLinkedFmt, d, other.GetName(), KeycloakRealm)
			}
		}
	}
	return nil
}

// UpdateTenant implements Tenants as the backend's GET, merge, PUT: the
// mask names the fields to replace; without a mask the scalars are replaced
// (`enabled` to true when unset, as Keycloak defaults it) and `attributes`
// and the domains are left alone, which is what a Keycloak PUT does with a
// body that lacks those keys (keycloak.md 5.6). Keycloak's own checks
// follow: a new name that matches another organization's name or any
// organization's domain, its own included (OrganizationResource.update
// L123-126 searches with exact=true and no self-exclusion), is 409; a
// different alias is 400 "Cannot change the alias".
func (s *Server) UpdateTenant(ctx context.Context, req *aigridv1.UpdateTenantRequest) (*aigridv1.UpdateTenantResponse, error) {
	token, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.authorizeProviderAdmin(ctx, token); err != nil {
		return nil, err
	}
	obj := req.GetObject()
	if obj.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "object.id is required") // console wording
	}
	paths := req.GetUpdateMask().GetPaths()
	for _, p := range paths {
		if !slices.Contains(tenantPaths, p) {
			return nil, status.Errorf(codes.InvalidArgument, "update_mask path %q is not supported; supported paths: %s", p, strings.Join(tenantPaths, ", "))
		}
	}
	has := func(p string) bool { return len(paths) == 0 || slices.Contains(paths, p) }

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.beginTenants(); err != nil {
		return nil, err
	}
	cur, ok := s.tenants[obj.GetId()]
	if !ok {
		return nil, s.tenantNotFound(obj.GetId())
	}
	next := cloneTenant(cur)
	if has(PathName) {
		if strings.TrimSpace(obj.GetName()) == "" {
			return nil, status.Error(codes.InvalidArgument, MsgNameRequired)
		}
		next.Name = obj.GetName()
	}
	if next.GetName() != cur.GetName() {
		// OrganizationResource.update searches with exact=true, which matches
		// names and domains, and does not exclude the organization itself: a
		// rename to one of its own domains is a conflict too.
		for id, other := range s.tenants {
			if (id != cur.GetId() && other.GetName() == next.GetName()) || slices.Contains(other.GetDomains(), next.GetName()) {
				return nil, status.Error(codes.AlreadyExists, MsgDuplicateName)
			}
		}
	}
	if obj.GetAlias() != "" && obj.GetAlias() != cur.GetAlias() {
		return nil, status.Error(codes.InvalidArgument, MsgAliasImmutable)
	}
	switch {
	case slices.Contains(paths, PathEnabled):
		next.Enabled = proto.Bool(obj.GetEnabled())
	case len(paths) == 0:
		// A PUT body without `enabled` re-enables (Java default true).
		next.Enabled = proto.Bool(obj.Enabled == nil || obj.GetEnabled())
	}
	if has(PathDescription) {
		next.Description = obj.GetDescription()
	}
	// Collections only move when their path is in the mask: a Keycloak PUT
	// leaves `attributes` and `domains` unchanged when the key is absent.
	if slices.Contains(paths, PathAttributes) {
		next.Attributes = copyMap(obj.GetAttributes())
	}
	switch {
	case slices.Contains(paths, PathDomainDetails):
		next.Domains = nil
		next.DomainDetails = obj.GetDomainDetails()
	case slices.Contains(paths, PathDomains):
		// The names are replaced; a domain that stays keeps its metadata, as
		// OrganizationAdapter.setDomains keeps the entity and a client that
		// sends only names has no metadata to offer.
		kept := map[string]*aigridv1.TenantDomain{}
		for _, d := range cur.GetDomainDetails() {
			kept[d.GetName()] = d
		}
		next.Domains = nil
		next.DomainDetails = nil
		for _, name := range obj.GetDomains() {
			if d, ok := kept[canonicalDomain(name)]; ok {
				next.DomainDetails = append(next.DomainDetails, d)
			} else {
				next.DomainDetails = append(next.DomainDetails, &aigridv1.TenantDomain{Name: name})
			}
		}
	}
	if err := normalizeDomains(next); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if err := s.checkDomainsFree(next, cur.GetId()); err != nil {
		return nil, err
	}
	s.tenants[cur.GetId()] = next
	s.logger.Debug("organization updated", "id", next.GetId(), "name", next.GetName(), "paths", paths)
	return &aigridv1.UpdateTenantResponse{Object: cloneTenant(next)}, nil
}

// DeleteTenant implements Tenants: Keycloak's DELETE answers 204 and removes
// the organization with its memberships; 404 when it is already gone.
func (s *Server) DeleteTenant(ctx context.Context, req *aigridv1.DeleteTenantRequest) (*aigridv1.DeleteTenantResponse, error) {
	token, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.authorizeProviderAdmin(ctx, token); err != nil {
		return nil, err
	}
	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required") // console wording
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.beginTenants(); err != nil {
		return nil, err
	}
	t, ok := s.tenants[req.GetId()]
	if !ok {
		return nil, s.tenantNotFound(req.GetId())
	}
	delete(s.tenants, req.GetId())
	s.logger.Debug("organization deleted", "id", t.GetId(), "name", t.GetName())
	return &aigridv1.DeleteTenantResponse{}, nil
}

// seedTenant validates one fixture organization the way Keycloak would have
// accepted it, so the shipped fixtures can only contain organizations that
// could exist in a realm. Must be called under s.mu, before Serve.
func (s *Server) seedTenant(t *aigridv1.Tenant) error {
	if !uuidPattern.MatchString(t.GetId()) {
		return fmt.Errorf("fixture tenant %q: id %q is not a lower-case UUID as Keycloak assigns them", t.GetName(), t.GetId())
	}
	if strings.TrimSpace(t.GetName()) == "" {
		return fmt.Errorf("fixture tenant %s: %s", t.GetId(), MsgNameRequired)
	}
	t = cloneTenant(t)
	if strings.TrimSpace(t.GetAlias()) == "" {
		t.Alias = t.GetName()
	}
	if t.Enabled == nil {
		t.Enabled = proto.Bool(true)
	}
	if err := validateAlias(t.GetAlias()); err != nil {
		return fmt.Errorf("fixture tenant %q: alias %q: %w", t.GetName(), t.GetAlias(), err)
	}
	if err := normalizeDomains(t); err != nil {
		return fmt.Errorf("fixture tenant %q: %w", t.GetName(), err)
	}
	if t.Attributes == nil {
		t.Attributes = map[string]string{}
	}
	if _, dup := s.tenants[t.GetId()]; dup {
		return fmt.Errorf("fixture tenant id %q listed twice", t.GetId())
	}
	for _, other := range s.tenants {
		if other.GetName() == t.GetName() {
			return fmt.Errorf("fixture tenant %q: %s", t.GetName(), MsgDuplicateName)
		}
		if other.GetAlias() == t.GetAlias() {
			return fmt.Errorf("fixture tenant %q: %s", t.GetName(), MsgDuplicateAlias)
		}
	}
	if err := s.checkDomainsFree(t, ""); err != nil {
		return fmt.Errorf("fixture tenant %q: %s", t.GetName(), status.Convert(err).Message())
	}
	s.tenants[t.GetId()] = t
	return nil
}
