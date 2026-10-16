package fakebackend

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const (
	idAcme   = "3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c"
	idGlobex = "8d2e7b31-0c4f-4a9d-b5e6-7f8a9b0c1d2e"
)

func seedOrgs() []*aigridv1.Tenant {
	return []*aigridv1.Tenant{
		{Id: idGlobex, Name: "globex-research", Alias: "globex", Enabled: proto.Bool(true), Domains: []string{"globex.example.com"}},
		{Id: idAcme, Name: "acme-robotics", Enabled: proto.Bool(true), Description: "Acme", Attributes: map[string]string{"billing-account": "ACME-0042"},
			DomainDetails: []*aigridv1.TenantDomain{{Name: "Acme.example.com", Verified: true, IdentityProviderAlias: "acme-oidc", AutoRedirect: true}, {Name: "*.acme.example.org"}}},
		{Id: "c5a4d3e2-f1b0-4987-a6c5-d4e3f2a1b0c9", Name: "initech-labs", Enabled: proto.Bool(false)},
	}
}

func tenantServer(t *testing.T, tenants ...*aigridv1.Tenant) *Server {
	t.Helper()
	if tenants == nil {
		tenants = seedOrgs()
	}
	s := newServer(t, &Fixtures{Tenants: tenants})
	n := 0
	s.SetIDGenerator(func() string { n++; return "00000000-0000-4000-8000-00000000000" + string(rune('0'+n)) })
	return s
}

func mustCode(t *testing.T, err error, want codes.Code, wantMsg string) {
	t.Helper()
	if status.Code(err) != want {
		t.Fatalf("code = %v (%v), want %v", status.Code(err), err, want)
	}
	if wantMsg != "" && status.Convert(err).Message() != wantMsg {
		t.Fatalf("message = %q, want %q", status.Convert(err).Message(), wantMsg)
	}
}

// TestRepoTenantFixturesLookLikeKeycloak proves the shipped tenants.json is a
// realm Keycloak could hold and covers the shapes the UI must render.
func TestRepoTenantFixturesLookLikeKeycloak(t *testing.T) {
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.Tenants) < 5 {
		t.Fatalf("expected at least five organizations, got %d", len(fx.Tenants))
	}
	var disabled, wildcard, noDomains, aliasDiffers, twoDomainsWithAttrs int
	for _, tn := range fx.Tenants {
		if !uuidPattern.MatchString(tn.GetId()) {
			t.Errorf("%s: id %q is not a UUID", tn.GetName(), tn.GetId())
		}
		if tn.GetAlias() == "" {
			t.Errorf("%s: the backend always returns alias (Keycloak fills it from the name)", tn.GetName())
		}
		if len(tn.GetDomains()) != len(tn.GetDomainDetails()) {
			t.Errorf("%s: domains and domainDetails must list the same domains", tn.GetName())
		}
		for i, d := range tn.GetDomainDetails() {
			if d.GetName() != tn.GetDomains()[i] || d.GetName() != strings.ToLower(d.GetName()) {
				t.Errorf("%s: domain %d: %q vs %q, must be equal and lower-case", tn.GetName(), i, d.GetName(), tn.GetDomains()[i])
			}
			if strings.HasPrefix(d.GetName(), "*.") {
				wildcard++
			}
		}
		if !tn.GetEnabled() {
			disabled++
		}
		if len(tn.GetDomains()) == 0 {
			noDomains++
		}
		if tn.GetAlias() != tn.GetName() {
			aliasDiffers++
		}
		if len(tn.GetDomains()) == 2 && len(tn.GetAttributes()) > 0 {
			twoDomainsWithAttrs++
		}
	}
	if disabled == 0 || wildcard == 0 || noDomains == 0 || aliasDiffers == 0 || twoDomainsWithAttrs == 0 {
		t.Errorf("fixtures must seed a disabled org, a wildcard domain, an org without domains, an alias different from the name and an org with two domains and attributes: %d %d %d %d %d", disabled, wildcard, noDomains, aliasDiffers, twoDomainsWithAttrs)
	}
	if _, err := New(fx, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
}

func TestSeedRejectsWhatKeycloakWouldReject(t *testing.T) {
	ok := func(tn ...*aigridv1.Tenant) error {
		_, err := New(&Fixtures{Tenants: tn}, slog.New(slog.DiscardHandler))
		return err
	}
	base := &aigridv1.Tenant{Id: idAcme, Name: "acme", Domains: []string{"acme.example.com"}}
	for name, bad := range map[string][]*aigridv1.Tenant{
		"non-uuid id":      {{Id: "1", Name: "x"}},
		"blank name":       {{Id: idAcme, Name: " "}},
		"duplicate name":   {base, {Id: idGlobex, Name: "acme", Alias: "other"}},
		"duplicate alias":  {base, {Id: idGlobex, Name: "other", Alias: "acme"}},
		"shared domain":    {base, {Id: idGlobex, Name: "other", Domains: []string{"ACME.example.com"}}},
		"bad domain":       {{Id: idAcme, Name: "x", Domains: []string{"not a domain"}}},
		"alias with space": {{Id: idAcme, Name: "x", Alias: "a b"}},
		"details disagree": {{Id: idAcme, Name: "x", Domains: []string{"a.example.com"}, DomainDetails: []*aigridv1.TenantDomain{{Name: "b.example.com"}}}},
	} {
		if err := ok(bad...); err == nil {
			t.Errorf("%s: fixture must be rejected", name)
		}
	}
	if err := ok(base); err != nil {
		t.Errorf("valid fixture rejected: %v", err)
	}
}

// TestValidateDomainUsesKeycloakMessages pins Organizations.validateDomain
// (26.8.0) branch for branch, on canonical (trimmed, lower-case) input.
func TestValidateDomainUsesKeycloakMessages(t *testing.T) {
	cases := map[string]string{
		"":                                       MsgDomainEmpty,
		"   ":                                    MsgDomainEmpty,
		"not a domain":                           "Invalid domain format: not a domain",
		"-acme.example.com":                      "Invalid domain format: -acme.example.com",
		"a-.example.com":                         "Invalid domain format: a-.example.com",
		"acme..example.com":                      "Invalid domain format: acme..example.com",
		"acme.example.com.":                      "Invalid domain format: acme.example.com.",
		"acme.*.example.com":                     MsgWildcardNotFirst,
		"acme.*.*.com":                           MsgWildcardNotFirst, // startsWith is checked before the second wildcard
		"*.*.example.com":                        "Multiple wildcards are not allowed: *.*.example.com",
		"*.":                                     "Wildcard domain must specify a base domain: *.",
		"*.com":                                  "Domain must have at least 2 parts (e.g. 'example.com'): com", // the base, not the input
		"*.a.b.c.d.e.f.g.h.i.j.k":                "Domain has too many parts (max 10 allowed): a.b.c.d.e.f.g.h.i.j.k",
		"*.not a domain.com":                     "Invalid domain format: *.not a domain.com",
		"acme.example.com":                       "",
		"acme_robotics.example":                  "Invalid domain format: acme_robotics.example", // Keycloak's pattern has no `_`
		"a+b.example.com":                        "",
		"x'y.example.org":                        "",
		"bücher.example":                         "", // IDN accepted through the non-ASCII range
		"localhost":                              "", // the e-mail rule alone governs plain domains
		"[192.0.2.1]":                            "",
		"*acme.example.com":                      "", // no `*.`: an ordinary e-mail domain with a `*` in a label
		"ac*me.example.com":                      "",
		"acme*.example.com":                      MsgWildcardNotFirst, // contains `*.` (star then dot): a wildcard that does not start with one
		"*.acme.example.org":                     "",
		"a.b.c.d.e.f.g.h.i.j.k":                  "", // the parts rule is for wildcards only
		strings.Repeat("a", 63) + ".example.com": "",
		strings.Repeat("a", 64) + ".example.com": "Invalid domain format: " + strings.Repeat("a", 64) + ".example.com",
		strings.Repeat("a.", 126) + strings.Repeat("b", 4): "Invalid domain format: " + strings.Repeat("a.", 126) + strings.Repeat("b", 4), // 256 chars
		strings.Repeat("a.", 126) + strings.Repeat("b", 3): "",                                                                             // 255 chars
	}
	for domain, want := range cases {
		err := validateDomain(domain)
		switch {
		case want == "" && err != nil:
			t.Errorf("%q: unexpected %v", domain, err)
		case want != "" && (err == nil || err.Error() != want):
			t.Errorf("%q: got %v, want %q", domain, err, want)
		}
	}
}

// TestNormalizeDomainsCanonicalisesFirst: OrganizationDomainModel trims and
// lower-cases before anything looks at the name, so messages print the
// canonical form and case variants collapse.
func TestNormalizeDomainsCanonicalisesFirst(t *testing.T) {
	tn := &aigridv1.Tenant{Domains: []string{" Acme.Example.com ", "ACME.example.COM", "*.Acme.Example.ORG"}}
	if err := normalizeDomains(tn); err != nil {
		t.Fatal(err)
	}
	if strings.Join(tn.GetDomains(), ",") != "acme.example.com,*.acme.example.org" {
		t.Errorf("domains = %v", tn.GetDomains())
	}
	err := normalizeDomains(&aigridv1.Tenant{Domains: []string{"Not A Domain"}})
	if err == nil || err.Error() != "Invalid domain format: not a domain" {
		t.Errorf("message must print the canonical name, got %v", err)
	}
	err = normalizeDomains(&aigridv1.Tenant{Domains: []string{" *.COM "}})
	if err == nil || err.Error() != "Domain must have at least 2 parts (e.g. 'example.com'): com" {
		t.Errorf("wildcard parts message on canonical base, got %v", err)
	}
	if err := normalizeDomains(&aigridv1.Tenant{Domains: []string{"a.example.com"}, DomainDetails: []*aigridv1.TenantDomain{{Name: " A.EXAMPLE.COM "}}}); err != nil {
		t.Errorf("names and details are compared canonically: %v", err)
	}
}

func TestValidateAliasUsesKeycloakMessages(t *testing.T) {
	cases := map[string]string{"acme": "", "acme-robotics_2": "", "acme robotics": MsgEmptySpace, "acme\trobotics": MsgEmptySpace, "acme/eu": "Character '/' not allowed.", "a@b": "Character '@' not allowed.", `a\b`: `Character '\' not allowed.`}
	for alias, want := range cases {
		err := validateAlias(alias)
		switch {
		case want == "" && err != nil:
			t.Errorf("%q: unexpected %v", alias, err)
		case want != "" && (err == nil || err.Error() != want):
			t.Errorf("%q: got %v, want %q", alias, err, want)
		}
	}
}

func TestListTenants(t *testing.T) {
	s := tenantServer(t)
	ctx := authed(context.Background())
	list := func(req *aigridv1.ListTenantsRequest) *aigridv1.ListTenantsResponse {
		t.Helper()
		resp, err := s.ListTenants(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	all := list(&aigridv1.ListTenantsRequest{})
	if names := tenantNames(all); strings.Join(names, ",") != "acme-robotics,globex-research,initech-labs" || all.GetSize() != 3 || all.GetTotal() != 3 {
		t.Fatalf("list = %v size %d total %d", names, all.GetSize(), all.GetTotal())
	}
	acme := all.GetTenants()[0]
	if acme.GetAlias() != "acme-robotics" || len(acme.GetDomains()) != 2 || acme.GetDomains()[0] != "acme.example.com" || acme.GetDomainDetails()[0].GetName() != "acme.example.com" || !acme.GetDomainDetails()[0].GetVerified() {
		t.Errorf("alias defaults to the name, domains are lower-cased and mirrored from the details: %v", acme)
	}
	if page := list(&aigridv1.ListTenantsRequest{Offset: proto.Int32(1), Limit: proto.Int32(1)}); strings.Join(tenantNames(page), ",") != "globex-research" || page.GetSize() != 1 || page.GetTotal() != 3 {
		t.Errorf("page = %v", page)
	}
	if page := list(&aigridv1.ListTenantsRequest{Limit: proto.Int32(0)}); len(page.GetTenants()) != 0 || page.GetTotal() != 3 {
		t.Errorf("limit 0 counts only: %v", page)
	}
	if page := list(&aigridv1.ListTenantsRequest{Offset: proto.Int32(10)}); len(page.GetTenants()) != 0 || page.GetTotal() != 3 {
		t.Errorf("offset past the end: %v", page)
	}
	// search: case-insensitive contains on the name or a domain, total follows the filter.
	filter := func(term string) *string {
		return proto.String(`this.name.contains("` + term + `") || this.domains.exists(d, d.contains("` + term + `"))`)
	}
	if page := list(&aigridv1.ListTenantsRequest{Filter: filter("GLOBEX")}); strings.Join(tenantNames(page), ",") != "globex-research" || page.GetTotal() != 1 {
		t.Errorf("search by name = %v", page)
	}
	if page := list(&aigridv1.ListTenantsRequest{Filter: filter("example.org")}); strings.Join(tenantNames(page), ",") != "acme-robotics" {
		t.Errorf("search by domain = %v", page)
	}
	if page := list(&aigridv1.ListTenantsRequest{Filter: filter("")}); page.GetTotal() != 3 {
		t.Errorf("blank search returns everything: %v", page)
	}
	if page := list(&aigridv1.ListTenantsRequest{Filter: filter(`say \"hi\"`)}); page.GetTotal() != 0 {
		t.Errorf("escaped term parses: %v", page)
	}
	// `%` and `_` are literal characters of the term, never LIKE wildcards
	// (the browser mock runs the same cases).
	if _, err := s.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "under_score", Domains: []string{"100%.example.com"}}}); err != nil {
		t.Fatal(err)
	}
	for term, want := range map[string]string{"r_s": "under_score", "r%s": "", "_": "under_score", "%": "under_score", "100%": "under_score", "a_c": "", "%ex%": ""} {
		page := list(&aigridv1.ListTenantsRequest{Filter: filter(term)})
		if got := strings.Join(tenantNames(page), ","); got != want {
			t.Errorf("literal search %q = %q, want %q", term, got, want)
		}
	}
	if _, err := s.DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: "00000000-0000-4000-8000-000000000001"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`this.name == "a"`, `this.name.startsWith("a")`, `name.contains("a")`, `this.name.contains(a)`,
		`this.name.contains("a")`, // name only is not what the UI means
		`this.name.contains("a") || this.domains.exists(d, d.contains("b"))`, // two different terms
		`this.domains.exists(d, d.contains("a")) || this.name.contains("a")`,
	} {
		_, err := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{Filter: proto.String(bad)})
		if status.Code(err) != codes.InvalidArgument || !strings.Contains(status.Convert(err).Message(), bad) {
			t.Errorf("filter %s = %v, want InvalidArgument naming it", bad, err)
		}
	}
	if _, err := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{Order: proto.String("name desc")}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("order = %v", err)
	}
	if _, err := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{Limit: proto.Int32(-1)}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("negative limit = %v", err)
	}
	all.GetTenants()[0].Domains[0] = "mutated"
	if again := list(&aigridv1.ListTenantsRequest{}); again.GetTenants()[0].GetDomains()[0] != "acme.example.com" {
		t.Error("responses must be copies of the store")
	}
}

func tenantNames(resp *aigridv1.ListTenantsResponse) []string {
	names := make([]string, 0, len(resp.GetTenants()))
	for _, tn := range resp.GetTenants() {
		names = append(names, tn.GetName())
	}
	return names
}

func TestGetTenant(t *testing.T) {
	s := tenantServer(t)
	ctx := authed(context.Background())
	got, err := s.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: idGlobex})
	if err != nil || got.GetObject().GetName() != "globex-research" || got.GetObject().GetAlias() != "globex" {
		t.Fatalf("get = %v, %v", got, err)
	}
	_, err = s.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: "11111111-2222-4333-8444-555555555555"})
	mustCode(t, err, codes.NotFound, "object with identifier '11111111-2222-4333-8444-555555555555' not found")
	_, err = s.GetTenant(ctx, &aigridv1.GetTenantRequest{})
	mustCode(t, err, codes.InvalidArgument, "")
}

func TestCreateTenant(t *testing.T) {
	ctx := authed(context.Background())
	create := func(s *Server, obj *aigridv1.Tenant) (*aigridv1.Tenant, error) {
		resp, err := s.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: obj})
		return resp.GetObject(), err
	}

	t.Run("defaults and normalisation", func(t *testing.T) {
		s := tenantServer(t)
		got, err := create(s, &aigridv1.Tenant{Name: "wayne-aerospace", Enabled: proto.Bool(true), Domains: []string{"Wayne-Aero.Example.com"}})
		if err != nil {
			t.Fatal(err)
		}
		if got.GetId() != "00000000-0000-4000-8000-000000000001" || got.GetAlias() != "wayne-aerospace" || !got.GetEnabled() || got.GetDomains()[0] != "wayne-aero.example.com" || got.GetDomainDetails()[0].GetVerified() {
			t.Errorf("created = %v", got)
		}
		if back, err := s.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: got.GetId()}); err != nil || !proto.Equal(back.GetObject(), got) {
			t.Errorf("the created object is what Get returns: %v, %v", back, err)
		}
		if list, _ := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{}); list.GetTotal() != 4 {
			t.Errorf("total = %d", list.GetTotal())
		}
		got2, err := create(s, &aigridv1.Tenant{Name: "Stark Industries", Alias: "stark", Description: "d", Enabled: proto.Bool(false), Attributes: map[string]string{"k": "v"},
			DomainDetails: []*aigridv1.TenantDomain{{Name: " Stark.Example.com ", Verified: true, IdentityProviderAlias: "stark-oidc", AutoRedirect: true}}})
		if err != nil || got2.GetAlias() != "stark" || got2.GetEnabled() || got2.GetDomains()[0] != "stark.example.com" || !got2.GetDomainDetails()[0].GetAutoRedirect() || got2.GetAttributes()["k"] != "v" {
			t.Errorf("explicit alias, details and attributes kept, names canonicalised; enabled false stays false as Keycloak stores what it is sent: %v, %v", got2, err)
		}
		got3, err := create(s, &aigridv1.Tenant{Name: "omitted-enabled"})
		if err != nil || got3.Enabled == nil || !got3.GetEnabled() {
			t.Errorf("an omitted enabled is Keycloak's default true: %v, %v", got3, err)
		}
		got4, err := create(s, &aigridv1.Tenant{Name: "star", Domains: []string{"*acme.example.com", "ac*me.example.com"}})
		if err != nil || len(got4.GetDomains()) != 2 {
			t.Errorf("a star inside a label is an ordinary e-mail domain character: %v, %v", got4, err)
		}
	})

	t.Run("keycloak validation messages", func(t *testing.T) {
		s := tenantServer(t)
		cases := []struct {
			name string
			obj  *aigridv1.Tenant
			code codes.Code
			msg  string
		}{
			{"blank name", &aigridv1.Tenant{Name: " "}, codes.InvalidArgument, MsgNameRequired},
			{"no object", nil, codes.InvalidArgument, ""},
			{"id given", &aigridv1.Tenant{Id: idAcme, Name: "x"}, codes.InvalidArgument, ""},
			{"name with space and no alias", &aigridv1.Tenant{Name: "Acme Robotics EU"}, codes.InvalidArgument, "Name cannot be used as alias: Empty Space not allowed."},
			{"name with slash and no alias", &aigridv1.Tenant{Name: "acme/eu"}, codes.InvalidArgument, "Name cannot be used as alias: Character '/' not allowed."},
			{"explicit alias with space", &aigridv1.Tenant{Name: "x", Alias: "acme eu"}, codes.InvalidArgument, MsgEmptySpace},
			{"explicit alias with reserved char", &aigridv1.Tenant{Name: "x", Alias: "acme?eu"}, codes.InvalidArgument, "Character '?' not allowed."},
			{"duplicate name", &aigridv1.Tenant{Name: "acme-robotics", Alias: "other"}, codes.AlreadyExists, MsgDuplicateName},
			{"duplicate alias", &aigridv1.Tenant{Name: "other", Alias: "globex"}, codes.AlreadyExists, MsgDuplicateAlias},
			{"name equal to another alias", &aigridv1.Tenant{Name: "globex"}, codes.AlreadyExists, MsgDuplicateAlias},
			{"bad domain", &aigridv1.Tenant{Name: "x", Domains: []string{"Not A Domain"}}, codes.InvalidArgument, "Invalid domain format: not a domain"},
			{"bad wildcard", &aigridv1.Tenant{Name: "x", Domains: []string{"*.com"}}, codes.InvalidArgument, "Domain must have at least 2 parts (e.g. 'example.com'): com"},
			{"duplicate name wins over a bad domain", &aigridv1.Tenant{Name: "acme-robotics", Alias: "other", Domains: []string{"not a domain"}}, codes.AlreadyExists, MsgDuplicateName},
			{"duplicate alias wins over a bad domain", &aigridv1.Tenant{Name: "other", Alias: "globex", Domains: []string{"not a domain"}}, codes.AlreadyExists, MsgDuplicateAlias},
			{"explicit alias chars win over a duplicate name", &aigridv1.Tenant{Name: "acme-robotics", Alias: "a b"}, codes.InvalidArgument, MsgEmptySpace},
			{"blank name wins over a bad domain", &aigridv1.Tenant{Name: "", Domains: []string{"not a domain"}}, codes.InvalidArgument, MsgNameRequired},
			{"empty domain", &aigridv1.Tenant{Name: "x", Domains: []string{""}}, codes.InvalidArgument, MsgDomainEmpty},
			{"domain owned by another org", &aigridv1.Tenant{Name: "x", Domains: []string{"GLOBEX.example.com"}}, codes.InvalidArgument, "Domain globex.example.com is already linked to organization globex-research in realm ai-grid"},
			{"details disagree with names", &aigridv1.Tenant{Name: "x", Domains: []string{"a.example.com"}, DomainDetails: []*aigridv1.TenantDomain{{Name: "b.example.com"}}}, codes.InvalidArgument, ""},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				_, err := create(s, tc.obj)
				mustCode(t, err, tc.code, tc.msg)
			})
		}
		if list, _ := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{}); list.GetTotal() != 3 {
			t.Errorf("rejected creates must not change the store, total = %d", list.GetTotal())
		}
	})

	t.Run("duplicate domains within the request collapse", func(t *testing.T) {
		s := tenantServer(t)
		got, err := create(s, &aigridv1.Tenant{Name: "x", Domains: []string{"x.example.com", " X.example.com "}})
		if err != nil || len(got.GetDomains()) != 1 {
			t.Errorf("Keycloak keeps a set of domains: %v, %v", got, err)
		}
	})

	t.Run("concurrent creates of the same name admit one", func(t *testing.T) {
		s := tenantServer(t)
		const n = 8
		var wg sync.WaitGroup
		results := make([]error, n)
		for i := range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, results[i] = s.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "raced", Domains: []string{"raced.example.com"}}})
			}()
		}
		wg.Wait()
		ok, exists := 0, 0
		for _, err := range results {
			switch status.Code(err) {
			case codes.OK:
				ok++
			case codes.AlreadyExists:
				exists++
			default:
				t.Errorf("unexpected %v", err)
			}
		}
		if ok != 1 || exists != n-1 {
			t.Errorf("ok=%d exists=%d, want 1 and %d", ok, exists, n-1)
		}
	})
}

func TestUpdateTenant(t *testing.T) {
	ctx := authed(context.Background())
	mask := func(paths ...string) *fieldmaskpb.FieldMask { return &fieldmaskpb.FieldMask{Paths: paths} }
	update := func(s *Server, obj *aigridv1.Tenant, m *fieldmaskpb.FieldMask) (*aigridv1.Tenant, error) {
		resp, err := s.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{Object: obj, UpdateMask: m})
		return resp.GetObject(), err
	}

	t.Run("mask merge", func(t *testing.T) {
		s := tenantServer(t)
		got, err := update(s, &aigridv1.Tenant{Id: idAcme, Enabled: proto.Bool(false), Name: "ignored"}, mask(PathEnabled))
		if err != nil {
			t.Fatal(err)
		}
		if got.GetEnabled() || got.GetName() != "acme-robotics" || got.GetDescription() != "Acme" || len(got.GetDomains()) != 2 || got.GetAttributes()["billing-account"] != "ACME-0042" {
			t.Errorf("only enabled changes: %v", got)
		}
		got, err = update(s, &aigridv1.Tenant{Id: idAcme, Name: "acme-robotics-eu", Description: "", Attributes: map[string]string{}}, mask(PathName, PathDescription, PathAttributes))
		if err != nil {
			t.Fatal(err)
		}
		if got.GetName() != "acme-robotics-eu" || got.GetDescription() != "" || len(got.GetAttributes()) != 0 || got.GetAlias() != "acme-robotics" || len(got.GetDomains()) != 2 {
			t.Errorf("name, description cleared, attributes cleared by {}, alias and domains untouched: %v", got)
		}
	})

	t.Run("domains path keeps the metadata of a domain that stays", func(t *testing.T) {
		s := tenantServer(t)
		got, err := update(s, &aigridv1.Tenant{Id: idAcme, Domains: []string{"ACME.example.com", "new.example.com"}}, mask(PathDomains))
		if err != nil {
			t.Fatal(err)
		}
		if len(got.GetDomainDetails()) != 2 || !got.GetDomainDetails()[0].GetVerified() || got.GetDomainDetails()[0].GetIdentityProviderAlias() != "acme-oidc" || got.GetDomainDetails()[1].GetName() != "new.example.com" || got.GetDomainDetails()[1].GetVerified() {
			t.Errorf("details = %v", got.GetDomainDetails())
		}
		if strings.Join(got.GetDomains(), ",") != "acme.example.com,new.example.com" {
			t.Errorf("domains = %v", got.GetDomains())
		}
		// A name submitted with surrounding whitespace and a different case is
		// the same domain (OrganizationDomainModel canonicalises it), so its
		// verified flag, identity provider and redirect survive.
		got, err = update(s, &aigridv1.Tenant{Id: idAcme, Domains: []string{"  ACME.Example.COM  ", "*.ACME.example.org"}}, mask(PathDomains))
		if err != nil {
			t.Fatal(err)
		}
		if d := got.GetDomainDetails()[0]; d.GetName() != "acme.example.com" || !d.GetVerified() || d.GetIdentityProviderAlias() != "acme-oidc" || !d.GetAutoRedirect() {
			t.Errorf("metadata lost on a non-canonical resubmission: %v", d)
		}
		got, err = update(s, &aigridv1.Tenant{Id: idAcme, Domains: []string{}}, mask(PathDomains))
		if err != nil || len(got.GetDomains()) != 0 || len(got.GetDomainDetails()) != 0 {
			t.Errorf("[] clears the domains: %v, %v", got, err)
		}
	})

	t.Run("domain_details path replaces metadata", func(t *testing.T) {
		s := tenantServer(t)
		got, err := update(s, &aigridv1.Tenant{Id: idAcme, DomainDetails: []*aigridv1.TenantDomain{{Name: "acme.example.com", Verified: false}}}, mask(PathDomainDetails))
		if err != nil || len(got.GetDomainDetails()) != 1 || got.GetDomainDetails()[0].GetVerified() || got.GetDomainDetails()[0].GetIdentityProviderAlias() != "" || len(got.GetDomains()) != 1 {
			t.Errorf("details = %v, %v", got, err)
		}
	})

	t.Run("no mask is a keycloak PUT without attributes and domains", func(t *testing.T) {
		s := tenantServer(t)
		if _, err := update(s, &aigridv1.Tenant{Id: idAcme, Enabled: proto.Bool(false)}, mask(PathEnabled)); err != nil {
			t.Fatal(err)
		}
		got, err := update(s, &aigridv1.Tenant{Id: idAcme, Name: "acme-2"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got.GetName() != "acme-2" || got.GetDescription() != "" || !got.GetEnabled() || len(got.GetDomains()) != 2 || got.GetAttributes()["billing-account"] != "ACME-0042" {
			t.Errorf("scalars replaced, an omitted enabled re-enables, collections kept: %v", got)
		}
		if got, err := update(s, &aigridv1.Tenant{Id: idAcme, Name: "acme-2", Enabled: proto.Bool(false)}, nil); err != nil || got.GetEnabled() {
			t.Errorf("an explicit false is kept: %v, %v", got, err)
		}
	})

	t.Run("keycloak rejections", func(t *testing.T) {
		s := tenantServer(t)
		_, err := update(s, &aigridv1.Tenant{Id: idAcme, Alias: "acme"}, mask(PathEnabled))
		mustCode(t, err, codes.InvalidArgument, MsgAliasImmutable)
		if got, err := update(s, &aigridv1.Tenant{Id: idAcme, Alias: "acme-robotics", Enabled: proto.Bool(true)}, mask(PathEnabled)); err != nil || !got.GetEnabled() {
			t.Errorf("the same alias is accepted: %v, %v", got, err)
		}
		_, err = update(s, &aigridv1.Tenant{Id: idAcme, Name: "globex-research"}, mask(PathName))
		mustCode(t, err, codes.AlreadyExists, MsgDuplicateName)
		_, err = update(s, &aigridv1.Tenant{Id: idAcme, Name: "globex.example.com"}, mask(PathName))
		mustCode(t, err, codes.AlreadyExists, MsgDuplicateName) // exact search matches domains too
		_, err = update(s, &aigridv1.Tenant{Id: idAcme, Name: "acme.example.com"}, mask(PathName))
		mustCode(t, err, codes.AlreadyExists, MsgDuplicateName) // ... including the organization's own domains
		if got, err := update(s, &aigridv1.Tenant{Id: idAcme, Name: "acme-robotics"}, mask(PathName)); err != nil || got.GetName() != "acme-robotics" {
			t.Errorf("keeping the name is not a conflict: %v, %v", got, err)
		}
		_, err = update(s, &aigridv1.Tenant{Id: idAcme, Name: ""}, mask(PathName))
		mustCode(t, err, codes.InvalidArgument, MsgNameRequired)
		_, err = update(s, &aigridv1.Tenant{Id: idAcme, Domains: []string{"globex.example.com"}}, mask(PathDomains))
		mustCode(t, err, codes.InvalidArgument, "Domain globex.example.com is already linked to organization globex-research in realm ai-grid")
		_, err = update(s, &aigridv1.Tenant{Id: idAcme, Domains: []string{"Bad Domain"}}, mask(PathDomains))
		mustCode(t, err, codes.InvalidArgument, "Invalid domain format: bad domain")
		_, err = update(s, &aigridv1.Tenant{Id: idAcme}, mask("alias"))
		mustCode(t, err, codes.InvalidArgument, "")
		if !strings.Contains(status.Convert(err).Message(), `"alias"`) {
			t.Errorf("bad path must be named: %v", err)
		}
		_, err = update(s, &aigridv1.Tenant{Name: "x"}, mask(PathName))
		mustCode(t, err, codes.InvalidArgument, "")
		_, err = update(s, &aigridv1.Tenant{Id: "11111111-2222-4333-8444-555555555555", Name: "x"}, mask(PathName))
		mustCode(t, err, codes.NotFound, "object with identifier '11111111-2222-4333-8444-555555555555' not found")
		if got, _ := s.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: idAcme}); got.GetObject().GetName() != "acme-robotics" || len(got.GetObject().GetDomains()) != 2 {
			t.Errorf("rejected updates leave the store alone: %v", got)
		}
	})
}

func TestDeleteTenant(t *testing.T) {
	s := tenantServer(t)
	ctx := authed(context.Background())
	if _, err := s.DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: idGlobex}); err != nil {
		t.Fatal(err)
	}
	_, err := s.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: idGlobex})
	mustCode(t, err, codes.NotFound, "")
	_, err = s.DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: idGlobex})
	mustCode(t, err, codes.NotFound, "object with identifier '"+idGlobex+"' not found")
	_, err = s.DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{})
	mustCode(t, err, codes.InvalidArgument, "")
	// The domain is free again.
	if _, err := s.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "globex-2", Domains: []string{"globex.example.com"}}}); err != nil {
		t.Errorf("domain of a deleted org can be claimed: %v", err)
	}
}

// TestTenantMutationsNeedAProviderAdmin: the backend gates Keycloak writes
// with the same provider-admin check as hub writes; reads need only a token.
func TestTenantMutationsNeedAProviderAdmin(t *testing.T) {
	access := Access{DefaultAllowed: true, DeniedTokens: []string{"viewer-token"}, RejectedTokens: []string{"expired-token"}}
	s := newServer(t, &Fixtures{Tenants: seedOrgs(), Access: access})
	as := func(token, user string) context.Context {
		return metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "Bearer "+token, "x-forwarded-user", user))
	}
	viewer := as("viewer-token", "viewer")
	want := `User "viewer" is not a provider admin: cannot patch resource "managedclusters" in API group "cluster.open-cluster-management.io" at the cluster scope`
	_, err := s.CreateTenant(viewer, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "x"}})
	mustCode(t, err, codes.PermissionDenied, want)
	_, err = s.UpdateTenant(viewer, &aigridv1.UpdateTenantRequest{Object: &aigridv1.Tenant{Id: idAcme, Enabled: proto.Bool(false)}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{PathEnabled}}})
	mustCode(t, err, codes.PermissionDenied, want)
	_, err = s.DeleteTenant(viewer, &aigridv1.DeleteTenantRequest{Id: idAcme})
	mustCode(t, err, codes.PermissionDenied, want)
	if list, err := s.ListTenants(viewer, &aigridv1.ListTenantsRequest{}); err != nil || list.GetTotal() != 3 {
		t.Errorf("viewer list = %v, %v", list, err)
	}
	if _, err := s.GetTenant(viewer, &aigridv1.GetTenantRequest{Id: idAcme}); err != nil {
		t.Errorf("viewer get = %v", err)
	}
	_, err = s.DeleteTenant(as("expired-token", "ghost"), &aigridv1.DeleteTenantRequest{Id: idAcme})
	mustCode(t, err, codes.Unauthenticated, "")
	anon := context.Background()
	for name, call := range map[string]func() error{
		"get": func() error { _, err := s.GetTenant(anon, &aigridv1.GetTenantRequest{Id: idAcme}); return err },
		"create": func() error {
			_, err := s.CreateTenant(anon, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "x"}})
			return err
		},
		"update": func() error {
			_, err := s.UpdateTenant(anon, &aigridv1.UpdateTenantRequest{Object: &aigridv1.Tenant{Id: idAcme}})
			return err
		},
		"delete": func() error { _, err := s.DeleteTenant(anon, &aigridv1.DeleteTenantRequest{Id: idAcme}); return err },
	} {
		if err := call(); status.Code(err) != codes.Unauthenticated {
			t.Errorf("%s without authorization = %v, want Unauthenticated", name, err)
		}
	}
	if _, err := s.DeleteTenant(as("dev-token", "dev-user"), &aigridv1.DeleteTenantRequest{Id: idAcme}); err != nil {
		t.Errorf("admin delete = %v", err)
	}
}

// TestTenantsErrorModes: the two Keycloak failure modes the fixtures can
// select, mapped with the conventions' codes.
func TestTenantsErrorModes(t *testing.T) {
	ctx := authed(context.Background())
	down, err := New(&Fixtures{TenantsUnavailable: "request Keycloak token: dial tcp 192.0.2.1:8080: connect: connection refused", Access: Access{DefaultAllowed: true}}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	_, err = down.ListTenants(ctx, &aigridv1.ListTenantsRequest{})
	mustCode(t, err, codes.Unavailable, "Keycloak is unavailable: request Keycloak token: dial tcp 192.0.2.1:8080: connect: connection refused")
	_, err = down.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "x"}})
	mustCode(t, err, codes.Unavailable, "")
	// Keycloak's own validation cannot run while Keycloak is down: the real
	// backend only learns about a bad domain or alias from Keycloak.
	_, err = down.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "x", Alias: "a b", Domains: []string{"not a domain"}}})
	mustCode(t, err, codes.Unavailable, "")
	_, err = down.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{Object: &aigridv1.Tenant{Id: idAcme, Alias: "changed"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{PathEnabled}}})
	mustCode(t, err, codes.Unavailable, "")
	// Request-shape checks still come first.
	_, err = down.CreateTenant(ctx, &aigridv1.CreateTenantRequest{})
	mustCode(t, err, codes.InvalidArgument, "")

	missing, err := New(&Fixtures{TenantsRealmMissing: true, Access: Access{DefaultAllowed: true}}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	for name, call := range map[string]func() error{
		"list": func() error { _, err := missing.ListTenants(ctx, &aigridv1.ListTenantsRequest{}); return err },
		"get":  func() error { _, err := missing.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: idAcme}); return err },
		"create": func() error {
			_, err := missing.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: &aigridv1.Tenant{Name: "x"}})
			return err
		},
		"update": func() error {
			_, err := missing.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{Object: &aigridv1.Tenant{Id: idAcme}})
			return err
		},
		"delete": func() error {
			_, err := missing.DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: idAcme})
			return err
		},
	} {
		if err := call(); status.Code(err) != codes.FailedPrecondition || status.Convert(err).Message() != `Keycloak realm "ai-grid": Realm not found.` {
			t.Errorf("%s with the realm missing = %v", name, err)
		}
	}
	// Authentication and the caller's own mistakes still come first.
	if _, err := missing.ListTenants(context.Background(), &aigridv1.ListTenantsRequest{}); status.Code(err) != codes.Unauthenticated {
		t.Errorf("anonymous = %v", err)
	}

	disabled, err := New(&Fixtures{TenantsOrgsDisabled: true, Access: Access{DefaultAllowed: true}}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	_, err = disabled.ListTenants(ctx, &aigridv1.ListTenantsRequest{})
	mustCode(t, err, codes.FailedPrecondition, `Keycloak realm "ai-grid": Organizations not enabled for this realm.`)
}

func TestNewUUIDIsVersion4(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := newUUID()
		if !uuidPattern.MatchString(id) || id[14] != '4' || !strings.ContainsRune("89ab", rune(id[19])) {
			t.Fatalf("not a v4 UUID: %s", id)
		}
		if seen[id] {
			t.Fatalf("duplicate %s", id)
		}
		seen[id] = true
	}
}
