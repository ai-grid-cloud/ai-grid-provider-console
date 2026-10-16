package fakebackend

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Strings Keycloak 26.8 writes for Organizations. Every Msg* value comes from
// mock/research/keycloak.md sections 3, 4 and 5, which cite the Java source
// for each one. Keep them verbatim: the real backend forwards Keycloak's
// `errorMessage` as the gRPC status message and the UI shows it.
//
// Not everything the fake says comes from Keycloak. The texts the real
// backend will have to choose itself, and which the console therefore
// invented (listed in mock/README.md, proposed to the backend in
// keycloak.md 8.2), are: the PermissionDenied message of
// authorizeProviderAdmin (server.go), the FailedPrecondition messages built
// from MsgRealmMissing / MsgOrgsNotEnabled (tenants.go beginTenants), the
// "object is required" / "object.id must be empty" / "id is required"
// request-shape messages (tenants.go), and
// "domains and domain_details name different domains" (normalizeDomains).
const (
	// KeycloakRealm is the realm the backend reads tenants from
	// (`KEYCLOAK_REALM`, default `ai-grid`).
	KeycloakRealm = "ai-grid"

	// Create and update (JpaOrganizationProvider, OrganizationResource).
	MsgNameRequired        = "Name can not be null"
	MsgNameNotAliasPrefix  = "Name cannot be used as alias: "
	MsgDuplicateName       = "A organization with the same name already exists."
	MsgDuplicateAlias      = "A organization with the same alias already exists" // sic, no period
	MsgAliasImmutable      = "Cannot change the alias"
	MsgOrganizationMissing = "Organization not found."

	// ReservedCharValidator: whitespace reads as "Empty Space", any other
	// RFC 3986 reserved character is named.
	MsgEmptySpace      = "Empty Space not allowed."
	MsgReservedCharFmt = "Character '%s' not allowed."
	reservedAliasChars = `:/?#@!$&()*+,;=[]\`

	// Realm-level 404 bodies (`{"error": ...}` and `{"errorMessage": ...}`).
	MsgRealmMissing     = "Realm not found."
	MsgOrgsNotEnabled   = "Organizations not enabled for this realm."
	MsgKeycloakDownPref = "Keycloak is unavailable: "

	// Organizations.validateDomain (Organizations.java:315-343) and the
	// cross-organization check. The "parts" messages print the base domain
	// (the input with `*.` stripped); the others print the whole input, which
	// is already trimmed and lower-cased by then (OrganizationDomainModel).
	MsgDomainEmpty          = "Domain name cannot be empty"
	MsgDomainInvalidFmt     = "Invalid domain format: %s"
	MsgWildcardNoBaseFmt    = "Wildcard domain must specify a base domain: %s"
	MsgWildcardNotFirst     = "Wildcard domain must start with the wildcard"
	MsgWildcardMultipleFmt  = "Multiple wildcards are not allowed: %s"
	MsgDomainTooFewPartsFmt = "Domain must have at least 2 parts (e.g. 'example.com'): %s"
	MsgDomainTooManyParts   = "Domain has too many parts (max 10 allowed): %s"
	MsgDomainLinkedFmt      = "Domain %s is already linked to organization %s in realm %s"

	// Field-mask paths UpdateTenant accepts.
	PathName          = "name"
	PathDomains       = "domains"
	PathEnabled       = "enabled"
	PathDescription   = "description"
	PathAttributes    = "attributes"
	PathDomainDetails = "domain_details"
)

// wildcardPrefix is Organizations.WILDCARD_PREFIX.
const wildcardPrefix = "*."

// tenantPaths is the list UpdateTenant names in its InvalidArgument messages.
var tenantPaths = []string{PathName, PathDomains, PathEnabled, PathDescription, PathAttributes, PathDomainDetails}

// uuidPattern is a lower-case version 4 UUID as KeycloakModelUtils.generateId()
// (java.util.UUID.randomUUID) writes it: version nibble 4, variant 8-b.
var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// The e-mail domain rule Keycloak applies to a plain domain
// (Organizations.validateDomain -> EmailValidationUtil.isValidEmail("user@" +
// domain), a copy of hibernate-validator's EmailValidator): labels made of
// letters, digits, `!#$%&'*+/=?^`{|}~` (no underscore: Keycloak's copy of the
// hibernate pattern omits it) and any non-ASCII character, with
// hyphens only inside a label, joined by dots, no trailing dot, or an IPv4
// literal in brackets. Approximations, documented so nobody mistakes them for
// the source: hibernate runs the domain through IDN.toASCII before matching
// (so a label is capped at 63 characters after punycode and the whole domain
// at 255); the fake applies both caps to the raw characters instead, and it
// leaves out hibernate's bracketed IPv6 literal.
var (
	emailDomainChars = "[a-z0-9!#$%&'*+/=?^`{|}~\\x{80}-\\x{ffff}]"
	emailDomainLabel = "(?:" + emailDomainChars + "-*)*" + emailDomainChars + "+"
	emailDomain      = regexp.MustCompile(`^(?:` + emailDomainLabel + `(?:\.` + emailDomainLabel + `)*|\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])$`)
)

const (
	maxDomainLength = 255
	maxLabelLength  = 63
)

// keycloakError is a validation message exactly as Keycloak's `errorMessage`
// carries it (capitalised, sometimes with a trailing period), which the real
// backend forwards verbatim as the gRPC status message.
type keycloakError struct{ msg string }

func (e *keycloakError) Error() string { return e.msg }

// keycloakErrorf formats one of the Msg* templates.
func keycloakErrorf(format string, args ...any) error {
	return &keycloakError{msg: fmt.Sprintf(format, args...)}
}

// newUUID returns a random version 4 UUID, which is what Keycloak assigns to
// an organization (keycloak.md 5.8).
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// validateAlias is Keycloak's ReservedCharValidator.validateNoSpace: the
// first whitespace or RFC 3986 reserved character decides the message.
func validateAlias(alias string) error {
	for _, r := range alias {
		if unicode.IsSpace(r) {
			return &keycloakError{msg: MsgEmptySpace}
		}
		if strings.ContainsRune(reservedAliasChars, r) {
			return keycloakErrorf(MsgReservedCharFmt, string(r))
		}
	}
	return nil
}

// validateDomain is Organizations.validateDomain (26.8.0, L315-343),
// branch for branch, on a name that OrganizationDomainModel has already
// trimmed and lower-cased: blank is rejected; a name containing `*.` is a
// wildcard that must be exactly `*.<base>` with no further `*` and a base of 2
// to 10 parts; everything else, the base included, must be valid as the
// domain part of an e-mail address. A `*` that is not followed by a dot is an
// ordinary character of that rule, so `*acme.example.com` is accepted.
func validateDomain(domain string) error {
	if strings.TrimSpace(domain) == "" {
		return &keycloakError{msg: MsgDomainEmpty}
	}
	base := domain
	if strings.Contains(domain, wildcardPrefix) {
		if len(domain) == len(wildcardPrefix) {
			return keycloakErrorf(MsgWildcardNoBaseFmt, domain)
		}
		if !strings.HasPrefix(domain, wildcardPrefix) {
			return &keycloakError{msg: MsgWildcardNotFirst}
		}
		base = domain[len(wildcardPrefix):]
		if strings.Contains(base, "*") {
			return keycloakErrorf(MsgWildcardMultipleFmt, domain)
		}
		parts := strings.Count(base, ".") + 1
		if parts < 2 {
			return keycloakErrorf(MsgDomainTooFewPartsFmt, base)
		}
		if parts > 10 {
			return keycloakErrorf(MsgDomainTooManyParts, base)
		}
	}
	if !isEmailDomain(base) {
		return keycloakErrorf(MsgDomainInvalidFmt, domain)
	}
	return nil
}

// isEmailDomain applies the rule documented on emailDomain.
func isEmailDomain(domain string) bool {
	if utf8.RuneCountInString(domain) > maxDomainLength || !emailDomain.MatchString(domain) {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if utf8.RuneCountInString(label) > maxLabelLength {
			return false
		}
	}
	return true
}

// normalizeDomains makes `domains` and `domain_details` one list the way
// Keycloak builds its domain set: each name is trimmed and lower-cased
// (OrganizationDomainModel), then validated, then kept once (the set
// collapses case variants). The two fields must agree when both are set.
// Details are built with Keycloak's defaults (`verified: false`) for a name
// that has none.
func normalizeDomains(t *aigridv1.Tenant) error {
	details := t.GetDomainDetails()
	names := t.GetDomains()
	switch {
	case len(details) == 0:
		for _, name := range names {
			details = append(details, &aigridv1.TenantDomain{Name: name})
		}
	case len(names) != 0:
		if len(names) != len(details) {
			return fmt.Errorf("domains and domain_details name different domains")
		}
		for i, name := range names {
			if canonicalDomain(name) != canonicalDomain(details[i].GetName()) {
				return fmt.Errorf("domains and domain_details name different domains")
			}
		}
	}
	seen := map[string]bool{}
	out := make([]*aigridv1.TenantDomain, 0, len(details))
	for _, d := range details {
		name := canonicalDomain(d.GetName())
		if err := validateDomain(name); err != nil {
			return err
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, &aigridv1.TenantDomain{Name: name, Verified: d.GetVerified(), IdentityProviderAlias: d.GetIdentityProviderAlias(), AutoRedirect: d.GetAutoRedirect()})
	}
	t.DomainDetails = out
	t.Domains = make([]string, 0, len(out))
	for _, d := range out {
		t.Domains = append(t.Domains, d.GetName())
	}
	return nil
}

// canonicalDomain is what OrganizationDomainModel's constructor stores:
// `name.trim().toLowerCase()`.
func canonicalDomain(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}
