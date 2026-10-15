# Spike: Keycloak Organizations as AI Grid tenants

Read-only research, 2026-10-15. Purpose: specify a fake gRPC backend and frontend mocks that
behave like the real `ai-grid-backend` + Keycloak pair, so the real backend can be swapped in
later with minimal change. All names, hosts, ids and UUIDs below are fictional.

Sources used throughout:

- Keycloak Admin REST API (OpenAPI for "latest", 26.8.x): https://www.keycloak.org/docs-api/latest/rest-api/index.html (the `openapi.json` next to it was parsed for the Organizations tag).
- Server Administration Guide, Managing organizations: https://www.keycloak.org/docs/latest/server_admin/index.html#_managing_organizations (asciidoc sources at tag `26.8.0`: `docs/documentation/server_admin/topics/organizations/*.adoc`).
- Enabled features list: https://www.keycloak.org/server/features
- Keycloak source at tag `26.8.0` (the deployed version), in particular
  `services/src/main/java/org/keycloak/organization/admin/resource/{OrganizationsResource,OrganizationResource,OrganizationMemberResource,OrganizationIdentityProvidersResource}.java`,
  `model/jpa/src/main/java/org/keycloak/organization/jpa/{JpaOrganizationProvider,OrganizationAdapter}.java`,
  `services/src/main/java/org/keycloak/organization/utils/Organizations.java`,
  `services/src/main/java/org/keycloak/services/resources/admin/fgap/OrganizationPermissions.java`,
  `server-spi-private/src/main/java/org/keycloak/models/AdminRoles.java`,
  `services/src/main/java/org/keycloak/services/{ErrorResponse,error/KeycloakErrorHandler}.java`,
  `services/src/main/java/org/keycloak/authentication/authenticators/directgrant/{ValidateUsername,ValidatePassword}.java`,
  `services/src/main/java/org/keycloak/protocol/oidc/grants/ClientCredentialsGrantType.java`,
  `services/src/main/java/org/keycloak/services/managers/ApplianceBootstrap.java`, `server-spi-private/src/main/java/org/keycloak/models/Constants.java`.
- Backend code: `<console repo>/.cache/ai-grid-backend/internal/keycloak/client.go`,
  `internal/ai_grid/tenants.go`, `internal/ai_grid/service.go`, `cmd/ai-grid-backend/main.go`,
  `proto/ai_grid/v1/ai_grid.proto`, `deploy/kind/keycloak.yaml`, `README.md`.
- Console plan: `<console repo>/docs/plan/bff-api.md`, `docs/plan/work-breakdown.md`;
  current shapes in `bff/internal/api/tenants.go`, `bff/internal/backend/backendtest/server.go`, `frontend/src/api/{types.ts,MockConsoleService.ts}`.

---

## 1. Summary

1. The dev hub's Keycloak (`grid-sso`) runs `quay.io/keycloak/keycloak:26.8.0` with `start --import-realm`; the `organization` feature (`organization:v1`) is GA and on by default in 26.x, nothing disables it, and the master realm's discovery document advertises the `organization` scope. Organizations are available.
2. The `ai-grid` realm does not exist yet (`GET /realms/ai-grid/.well-known/openid-configuration` returns 404 `{"error":"Realm does not exist"}`). A realm-import ConfigMap seeds three other realms, one of which already has `organizationsEnabled: true` with two sample organizations; see section 2.
3. Today's backend does one thing: password grant as the bootstrap admin in `master` via `admin-cli`, then `GET /admin/realms/ai-grid/organizations?first=0&max=100` with the default brief representation, and maps `{id,name,domains[].name}` to proto `Tenant{id,name,domains}`. Every failure becomes a plain Go error, i.e. gRPC code `Unknown`, which the BFF turns into a 502.
4. The Organizations Admin API is a conventional CRUD surface: list (`search`, `exact`, `q`, `first`, `max`, default `max=10`, ordered by name), `POST` 201 + `Location`, `PUT` 204 (full replace of the representation), `DELETE` 204, plus `/members`, `/invitations`, `/identity-providers`, `/groups` and `/count` sub-resources.
5. Error bodies come in two shapes: resource-level errors are `{"errorMessage": "..."}` (400/404/409), while framework-level errors are `{"error": "HTTP 401 Unauthorized"}`, `{"error": "HTTP 403 Forbidden"}`, `{"error": "Realm not found."}`.
6. Uniqueness is enforced on `name` and `alias` (409, message literally "A organization with the same name already exists."), and on domains across the realm (400 "Domain acme.example.com is already linked to organization ..."). Alias defaults to the name and is immutable (400 "Cannot change the alias").
7. Authorization is by `realm-management` client roles: `query-organizations` alone yields an empty `200 []` on list, `view-organizations` is needed to see anything, `manage-organizations` for create/update/delete, and members additionally need `query-users`/`view-users`/`manage-users`.
8. The deployed console's `ListTenants` would return disabled organizations too, capped at 100, without alias/enabled/description/attributes/members: all gaps versus what `bff-api.md` Step 6 wants (create, update, delete; members later).
9. Proposed: a `Tenants` service with paged/searchable list, get, create, update, delete, list/add/remove members, and a fixed mapping from Keycloak status codes to gRPC codes (409 AlreadyExists, 404 NotFound, 400 InvalidArgument, 401/403 Internal, network Unavailable), which the BFF's existing error table already maps to HTTP.
10. Bootstrap for production: create the `ai-grid` realm with `organizationsEnabled: true`, a confidential client `ai-grid-backend` with service accounts, assign the minimal `realm-management` roles to its service-account user, and switch the backend to `client_credentials` in the `ai-grid` realm.

---

## 2. Facts about the grid-sso Keycloak (anonymised)

Observed with `oc get` only (no secret values read, no login attempted):

| Item | Observation |
|---|---|
| Workload | `Deployment/keycloak`, image `quay.io/keycloak/keycloak:26.8.0`; `StatefulSet/keycloak-postgresql` on `quay.io/sclorg/postgresql-16-c9s:latest`. |
| Start mode | `args: ["start", "--import-realm"]` (production mode, not `start-dev`). Env: `KC_DB=postgres`, `KC_DB_URL_HOST=keycloak-postgresql`, `KC_PROXY_HEADERS=xforwarded`, `KC_HTTP_ENABLED=true`, `KC_HEALTH_ENABLED=true`. No `KC_FEATURES` / `--features` flag, so the default feature set applies. |
| Exposure | One OpenShift `Route` with edge TLS and HTTP-to-HTTPS redirect in front of `Service/keycloak:8080`. Call it `https://sso.example.com` below. |
| Version check | `GET /realms/master/.well-known/openid-configuration` returned 200; `grant_types_supported` includes `password` and `client_credentials`; `scopes_supported` includes `organization` (only present when the organization feature is enabled). |
| Organizations feature | https://www.keycloak.org/server/features lists `organization:v1` ("Organization support within realms") as enabled by default; GA since Keycloak 26.0. Nothing in the deployment disables it. Per realm it is still an opt-in switch (`organizationsEnabled` in `RealmRepresentation`, "Realm Settings > Organizations" in the admin console). |
| Realms | `master` exists. `ai-grid` does not: `GET /realms/ai-grid/.well-known/openid-configuration` returned 404 `{"error":"Realm does not exist"}`. |
| Realm import | ConfigMap `keycloak-realm-import-<hash>` mounted for `--import-realm` holds three realm JSON files: one SaaS-style realm with `organizationsEnabled: true` containing 2 organizations (keys `name, alias, domains, enabled, identityProviders`; each with 1 domain, 1 linked IdP, alias different from name, 0 members, `enabled: true`) and two small per-tenant IdP realms (1 client, 1 user each, no organizations). Only counts and key names were read. Whether these realms were actually imported was not enumerated (out of scope). |
| Unauthenticated admin call | `GET /admin/realms/master/organizations` without a token returned `401 {"error":"HTTP 401 Unauthorized"}`. |
| Backend's own dev setup | `deploy/kind/keycloak.yaml` runs `quay.io/keycloak/keycloak:26.3` in `start-dev` with bootstrap admin `admin/admin`, a Job that creates realm `ai-grid` with `organizationsEnabled: true` and two organizations `tenant-a`, `tenant-b` (`alias` = name, one unverified domain each). So the backend was only ever tested against 26.3 dev mode; the hub runs 26.8.0 production mode. The Organizations code paths that matter here are the same in both (verified by diffing `26.8.0` against `main`; see 5.4 for the one alias-validation difference). |

---

## 3. Endpoint table: Organizations Admin REST API (Keycloak 26.8)

All paths are under `{base}/admin/realms/{realm}`; auth is `Authorization: Bearer <access token>`. Only the endpoints the console needs are detailed; the rest are listed for completeness. Sources: OpenAPI `Organizations` tag; `OrganizationsResource.java`, `OrganizationResource.java`, `OrganizationMemberResource.java`, `OrganizationIdentityProvidersResource.java` (26.8.0).

### 3.1 Organizations

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/organizations` | Query: `search` (name or domain), `exact` (bool), `q` (`key1:value1 key2:value2` attribute query), `identityProvider` (alias; cannot be combined with `q`), `first` (default 0), `max` (default **10**), `briefRepresentation` (default `true`; `false` adds `attributes`) | `200` JSON array of `OrganizationRepresentation`, ordered by `name` ascending | `400 {"errorMessage":"The 'identityProvider' and 'q' parameters cannot be combined."}`, `400 {"errorMessage":"Identity provider 'x' not found."}`; `401 {"error":"HTTP 401 Unauthorized"}`; `403 {"error":"HTTP 403 Forbidden"}` when the caller lacks `query-organizations`/`view-organizations`/`manage-organizations`/`manage-realm`; **`200 []`** when the caller has only `query-organizations`; `404 {"errorMessage":"Organizations not enabled for this realm."}` when the realm has `organizationsEnabled=false` (403 instead if the caller cannot even query); `404 {"error":"Realm not found."}` when the realm does not exist |
| GET | `/organizations/count` | Same filters minus paging | `200` integer (JSON number) | as list; `0` for query-only callers |
| POST | `/organizations` | JSON `OrganizationRepresentation` (`name` required; `alias` optional; `domains`, `description`, `redirectUrl`, `attributes`, `enabled` optional) | **`201`**, empty body, `Location: {base}/admin/realms/{realm}/organizations/{new-id}` | `400 {"errorMessage":"Organization cannot be null."}`; `400 {"errorMessage":"Name can not be null"}`; `400 {"errorMessage":"Name cannot be used as alias: ..."}` (name contains whitespace and no alias given); `400 {"errorMessage":"Organization redirect URL is not valid."}`; `400 {"errorMessage":"Domain name cannot be empty"}`; `400 {"errorMessage":"Invalid domain format: not a domain"}`; `400 {"errorMessage":"Domain acme.example.com is already linked to organization acme-robotics in realm ai-grid"}`; **`409 {"errorMessage":"A organization with the same name already exists."}`**; **`409 {"errorMessage":"A organization with the same alias already exists"}`** (sic, no period); `403` without `manage-organizations`; `404 ... not enabled` |
| GET | `/organizations/{org-id}` | | `200` full `OrganizationRepresentation` (always `briefRepresentation=false`, so `attributes` included) | `400 {"errorMessage":"Id cannot be null."}`; **`404 {"errorMessage":"Organization not found."}`** (403 instead if the caller cannot query) |
| PUT | `/organizations/{org-id}` | JSON `OrganizationRepresentation` (full representation; see 5.6 for replace semantics) | **`204`**, empty body | `409 {"errorMessage":"A organization with the same name already exists."}` when `name` changes to an existing one; `400 {"errorMessage":"Cannot change the alias"}`; `400` redirect URL / domain validation messages as for create; `404 {"errorMessage":"Organization not found."}`; `403` |
| DELETE | `/organizations/{org-id}` | | **`204`** | `404 {"errorMessage":"Organization not found."}`; `403`; `400 {"errorMessage":"organization couldn't be deleted"}` (provider returned false; not reachable with the JPA provider) |
| GET | `/organizations/members/{member-id}/organizations` | `briefRepresentation` | `200` array of orgs the user belongs to | `400 {"errorMessage":"id cannot be null"}`; `404 {"error":"HTTP 404 Not Found"}` when the user does not exist |

### 3.2 Members (`/organizations/{org-id}/members`)

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/members` | `search` (username, email, first or last name), `exact`, `first` (0), `max` (**10**), `membershipType` (`MANAGED`/`UNMANAGED`), `briefRepresentation` (true) | `200` array of `MemberRepresentation`, ordered by `username` | `403` without `query-users`; **`200 []`** with `query-users` but no `view-users` |
| GET | `/members/count` | | `200` integer | `0` for query-only callers |
| POST | `/members` | Body is the **user id as a JSON string** (`"7f0c2a9e-..."`; quotes optional, whitespace trimmed), `Content-Type: application/json` | **`201`**, `Location: .../members/{user-id}` | `404 {"error":"HTTP 404 Not Found"}` user does not exist (403 if the caller cannot query users); **`409 {"errorMessage":"User is already a member of the organization."}`**; `400 {"errorMessage":"User is already a managed member of another organization"}`; `403` without `manage-organizations` **and** `manage-users` |
| GET | `/members/{member-id}` | | `200` full `MemberRepresentation` (includes `membershipType`) | `400 {"errorMessage":"id cannot be null"}`; `404 {"error":"HTTP 404 Not Found"}` when not a member |
| DELETE | `/members/{member-id}` | | **`204`** | `404 {"error":"HTTP 404 Not Found"}` when user is not a member; `400 {"errorMessage":"Not a member of the organization"}`; `403` |
| PUT | `/members/{member-id}/membership-type` | JSON string `"MANAGED"` or `"UNMANAGED"` | `204` | `400 {"errorMessage":"membershipType cannot be null"}`; `404 {"errorMessage":"Not a member of the organization"}` |
| POST | `/members/invite-user` | `application/x-www-form-urlencoded`: `email` (required), `firstName`, `lastName`; query `client_id` optional | `204` (an email is sent) | `400` invalid email / SMTP not configured; `409` already a member; `500` mail failure |
| POST | `/members/invite-existing-user` | form `id` | `204` | `400`, `500` |
| GET | `/members/{member-id}/groups`, `/members/{member-id}/organizations` | paging | `200` arrays | `400`, `404` |

### 3.3 Identity providers (`/organizations/{org-id}/identity-providers`)

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/identity-providers` | | `200` array of `IdentityProviderRepresentation` | `403` |
| POST | `/identity-providers` | Body: IdP **alias as a JSON string** | `204` | `400 {"errorMessage":"Identity provider not found with the given alias"}`; `409 {"errorMessage":"Identity provider already associated to the organization"}` |
| GET | `/identity-providers/{alias}` | | `200` | `404 {"errorMessage":"Identity provider not associated with the organization"}` |
| PUT | `/identity-providers/{alias}` | JSON `OrganizationIdentityProviderLinkRepresentation {autoMembership, membershipType}` | `204` | `400 {"errorMessage":"Invalid membership type: X"}`, `400 {"errorMessage":"Auto-membership must be enabled when membership type is MANAGED"}`, `404` |
| DELETE | `/identity-providers/{alias}` | | `204` | `404 {"errorMessage":"Identity provider not found with the given alias"}`; `400 {"errorMessage":"Identity provider not associated with the organization"}` |

Also present but not needed by the console: `/organizations/{org-id}/groups/**` (organization-scoped groups) and `/organizations/{org-id}/invitations/**` (list, get, resend, delete invitations).

### 3.4 Realm-level

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| POST | `/admin/realms` | `RealmRepresentation {"realm":"ai-grid","enabled":true,"organizationsEnabled":true}` | `201`, `Location` | `409 {"errorMessage":"Conflict detected. See logs for details"}` when the realm exists; `403` |
| PUT | `/admin/realms/{realm}` | `RealmRepresentation` (partial is fine for this endpoint) | `204` | `404 {"error":"Realm not found."}` |

### 3.5 Token endpoint (`{base}/realms/{realm}/protocol/openid-connect/token`)

| Grant | Request (form) | Success | Errors |
|---|---|---|---|
| `password` (what the backend does today, realm `master`) | `grant_type=password&client_id=admin-cli&username=admin&password=...` | `200 {"access_token":"...","expires_in":60,"refresh_expires_in":1800,"refresh_token":"...","token_type":"Bearer","not-before-policy":0,"session_state":"...","scope":"profile email"}` | wrong password / unknown user: **`400 {"error":"invalid_grant","error_description":"Invalid user credentials"}`** (26.8.0 `ValidatePassword`/`ValidateUsername` use `Status.BAD_REQUEST`; older releases returned 401 for the same body, so a mock should accept either); disabled user: `400 {"error":"invalid_grant","error_description":"Account disabled"}`; user with pending required actions: `400 {"error":"invalid_grant","error_description":"Account is not fully set up"}`; missing `grant_type`: `400 {"error":"invalid_request","error_description":"Missing form parameter: grant_type"}`; unknown realm: `404 {"error":"Realm does not exist"}` |
| `client_credentials` (proposed, realm `ai-grid`) | `grant_type=client_credentials&client_id=ai-grid-backend&client_secret=...` (or HTTP Basic) | `200 {"access_token":"...","expires_in":300,"refresh_expires_in":0,"token_type":"Bearer","not-before-policy":0,"scope":"profile email"}` (no refresh token by default for service accounts) | wrong or unknown client/secret: **`401 {"error":"invalid_client","error_description":"Invalid client or Invalid client credentials"}`**; service accounts not enabled on the client: `401 {"error":"unauthorized_client","error_description":"Client not enabled to retrieve service account"}`; public client: `401 {"error":"unauthorized_client","error_description":"Public client not allowed to retrieve service account"}`; service-account user disabled: `401 {"error":"invalid_request","error_description":"User 'service-account-ai-grid-backend' disabled"}` |

Token lifetimes: the master realm is bootstrapped with `accessTokenLifespan = 60` seconds (`ApplianceBootstrap.java`), SSO idle 1800 s, SSO max 36000 s. New realms default to `Constants.DEFAULT_ACCESS_TOKEN_LIFESPAN = 300` seconds. The token is a JWS; `exp` is authoritative, `expires_in` is the hint to cache against.

---

## 4. JSON shapes (fictional examples)

### 4.1 `OrganizationRepresentation` (full, `briefRepresentation=false`): org with two domains

```json
{
  "id": "3f1c6a52-7d0e-4b1a-9c3e-5a6d7e8f9a01",
  "name": "acme-robotics",
  "alias": "acme-robotics",
  "enabled": true,
  "description": "Acme Robotics, EU region",
  "redirectUrl": "https://console.acme.example.com/welcome",
  "attributes": {
    "ai-grid/region": ["europe-west"],
    "billing-account": ["ACME-0042"]
  },
  "domains": [
    { "name": "acme.example.com", "verified": true,  "identityProviderAlias": "acme-oidc", "autoRedirect": true },
    { "name": "*.acme.example.org", "verified": false, "identityProviderAlias": null, "autoRedirect": false }
  ]
}
```

Notes: `members`, `identityProviders` and `groups` exist in the schema but are **never populated by GET**; they are only read on import. Brief representation (the list default) omits `attributes` only; `id`, `name`, `alias`, `enabled`, `description`, `redirectUrl`, `domains` are always present. Keycloak serialises `null` fields as absent or `null` depending on the field (Jackson `NON_NULL` is not applied to this class, so expect `"description": null`).

### 4.2 Disabled organization (brief, as it appears in a list)

```json
{
  "id": "b9d2e4f6-1a3c-4e5f-8b7d-0c1e2f3a4b05",
  "name": "globex-labs",
  "alias": "globex",
  "enabled": false,
  "description": null,
  "redirectUrl": null,
  "domains": []
}
```

A list call returns disabled organizations like any other; there is no `enabled` filter on the API.

### 4.3 `MemberRepresentation` (brief, from `GET /members`)

```json
{
  "id": "7f0c2a9e-5b6d-4c8e-9f1a-2b3c4d5e6f07",
  "username": "jane.doe",
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane.doe@acme.example.com",
  "emailVerified": true,
  "createdTimestamp": 1760000000000,
  "enabled": true,
  "totp": false,
  "disableableCredentialTypes": [],
  "requiredActions": [],
  "notBefore": 0,
  "membershipType": "UNMANAGED"
}
```

`MemberRepresentation` is `UserRepresentation` plus `membershipType` (`"MANAGED"` or `"UNMANAGED"`). Full representation adds `attributes`, `access`, `federationLink` etc.

### 4.4 Error bodies

```json
{"errorMessage": "A organization with the same name already exists."}   // 409 from ErrorResponse.error
{"errorMessage": "Organization not found."}                              // 404
{"errorMessage": "Invalid domain format: not a domain"}                  // 400
{"error": "HTTP 401 Unauthorized"}                                       // 401, no/expired token (KeycloakErrorHandler)
{"error": "HTTP 403 Forbidden"}                                          // 403, missing role
{"error": "Realm not found."}                                            // 404, unknown realm on /admin/realms/{realm}/...
{"error": "Realm does not exist"}                                        // 404, unknown realm on /realms/{realm}/...
{"error": "invalid_grant", "error_description": "Invalid user credentials"}            // token endpoint
{"error": "invalid_client", "error_description": "Invalid client or Invalid client credentials"}
```

`ErrorRepresentation` also has optional `field`, `params`, `errors[]` (used by user-profile validation, not by organizations).

---

## 5. Behavioural details a faithful mock must reproduce

Sources: `JpaOrganizationProvider.java`, `OrganizationAdapter.java`, `Organizations.java`, `RepresentationToModel.toModel(OrganizationRepresentation, OrganizationModel)`, `ModelToRepresentation.toRepresentation(OrganizationModel, boolean)`, admin guide "Creating an organization", "Managing organization domains", "Deleting an organization".

1. **Pagination**: `first` and `max` are offset/limit. Defaults `first=0`, `max=10` (not 100; the backend passes `max=100` explicitly). `max=-1` is treated as unlimited by `paginateQuery`. There is no total in the list response; use `GET /organizations/count` with the same filters. Results are ordered by `name` ascending (`orderBy(builder.asc(org.get("name")))`).
2. **Search**: `search` without `exact` is case-insensitive **contains** on `name` OR on any domain `name` (`LIKE %term%` on lower-cased name; domain names are stored lower-case). With `exact=true` it is case-sensitive equality on name or domain. `q=key1:v1 key2:v2` matches attributes (and the special key `alias`). Blank `search` returns everything.
3. **Uniqueness**: `name` unique per realm (checked case-sensitively via `getByName`); `alias` unique per realm; domains unique per realm (compared case-insensitively, stored lower-case). Both name and alias conflicts are 409 on create; on update only a name conflict is checked (409) because the alias cannot change.
4. **Alias**: defaults to `name` when omitted or blank. In 26.8.0 a name containing whitespace cannot be used as alias (400 "Name cannot be used as alias: ...") and an explicit alias with whitespace is rejected (400). The admin guide says the alias "must be URL-friendly" and "cannot be changed afterwards" (update with a different alias gives 400 "Cannot change the alias"; sending the same alias or omitting it is fine).
5. **`enabled`**: defaults to `true` (`OrganizationRepresentation.enabled = true`, and `create` calls `setEnabled(true)`). Note the Java default means an update body that omits `enabled` re-enables the organization.
6. **Update is a full replace**, not a merge: `toModel` calls `setName`, `setAlias`, `setEnabled`, `setRedirectUrl`, `setDescription`, `setAttributes` unconditionally with whatever the body has (`null` clears description/redirectUrl/attributes; a missing boolean becomes `true`). Only `domains` is skipped when `null`, but an empty array `[]` removes all domains (`setDomains` deletes entities not in the new set and claims/creates the rest). Clients must therefore GET, modify, PUT the whole representation.
7. **Domain validation** (`Organizations.validateDomain`): non-blank; valid as the domain part of an email (`user@<domain>`); wildcard form `*.base.tld` only, prefix must be at the start and appear once, base must have at least 2 and at most 10 parts (`*.com` rejected). Messages: "Invalid domain format: X", "Wildcard domain must specify a base domain: X", "Wildcard domain must start with the wildcard", "Multiple wildcards are not allowed: X", "Domain must have at least 2 parts (e.g. 'example.com'): X", "Domain has too many parts (max 10 allowed): X". Cross-organization reuse: "Domain X is already linked to organization Y in realm Z". `verified` is free-form metadata (no verification flow), default `false`.
8. **Ids** are `KeycloakModelUtils.generateId()` = random UUID v4 strings (36 chars, lower-case). A client may supply `id` on import but not through `POST /organizations` (the resource ignores it; `provider.create(name, alias)` generates one).
9. **Delete**: removes the organization, its internal group, its IdP links (IdPs themselves stay) and its invitations. Members: **managed** members (federated through an IdP link with `membershipType=MANAGED`) are deleted from the realm; **unmanaged** members (existing realm users added via `POST /members`) remain as realm users. Deleting a member via `DELETE /members/{id}` follows the same rule.
10. **Disabled org**: still listed and manageable; members cannot authenticate through the organization's IdP links, unmanaged members still log in as realm users but without organization claims.
11. **`ListTenants` today** includes disabled organizations (no filter), returns at most 100 (one page, no follow-up), never sends `briefRepresentation=false` (so attributes would be absent anyway), and drops `alias`, `enabled`, `description`, `redirectUrl`, `attributes`, `verified`.
12. **Create response**: 201 with empty body and a `Location` header ending in the new id; the client must parse the id from `Location` or do a follow-up `GET`/search (`search=<name>&exact=true`).
13. **Permissions quirk**: `query-organizations` without `view-organizations` gives `200 []` and `count=0`, not 403. The backend README's advice to use "a dedicated service account with the `query-organizations` role" is therefore insufficient; see section 7.
14. **Content type**: all admin responses are `application/json`; a `GET` on a resource that does not exist under `/admin` without a token is 401 before 404 (auth is checked first).
15. **Admin events**: every create/update/delete/member change emits an admin event (`ResourceType.ORGANIZATION` / `ORGANIZATION_MEMBERSHIP`) if admin events are enabled on the realm; not visible through this API.

---

## 6. Authorization model

Source: `OrganizationPermissions.java` (26.8.0), `OrganizationMemberResource.java`, `AdminRoles.java`. Roles are **client roles of the `realm-management` client in the same realm** (`ai-grid`), or the corresponding `master` realm roles `<realm>-realm` client roles when administering from `master`.

| Operation | Permission check in code | Minimal realm-management role(s) |
|---|---|---|
| `GET /organizations`, `/count` | `orgs().requireQuery()`, then `canView()` to return non-empty | `view-organizations` (implies query). `query-organizations` alone: 200 `[]`. |
| `GET /organizations/{id}` | `requireView(org)`; 404 vs 403 decided by `canQuery()` | `view-organizations` |
| `POST`, `PUT`, `DELETE /organizations[/{id}]` | `orgs().requireManage()` | `manage-organizations` (implies view and query). `manage-realm` also works. |
| `GET /organizations/{id}/members[/count]` | `users().requireQuery()`, `canView()` for non-empty | `query-users` + `view-users` (plus `view-organizations` to reach the org: 404/403 otherwise) |
| `GET /members/{id}` | `users().requireView(user)` | `view-users` + `view-organizations` |
| `POST /members`, `DELETE /members/{id}`, `PUT .../membership-type` | `orgs().requireManage(org)` **and** `users().requireManage(user)` | `manage-organizations` + `manage-users` |
| `.../identity-providers` | `requireManage(org)` plus `realm().requireViewIdentityProviders()`/`requireManageIdentityProviders()` | `manage-organizations` + `view-identity-providers` (`manage-identity-providers` to link) |
| `/invitations`, `invite-user` | `requireManage(org)`, needs realm SMTP configured | `manage-organizations` |

The admin console's "fine-grained admin permissions v2" (`admin-fine-grained-authz:v2`, enabled by default in 26.8) can scope these further per organization, but with it off (the default for a new realm; it is a realm switch `adminPermissionsEnabled`) the role table above is exact.

**Today's backend** authenticates as the bootstrap admin of `master` with the `password` grant on the public `admin-cli` client. That user has the `admin` realm role in `master` and therefore every `<realm>-realm` role for every realm, including `ai-grid-realm/manage-organizations`; it can also create and delete realms. Drawbacks: a shared human credential, a 60 s token fetched on every RPC (no caching in `client.go`), the password in a Secret that the backend reads at start, and no way to scope to one realm.

**Proposed**: a confidential client `ai-grid-backend` in the `ai-grid` realm with `serviceAccountsEnabled: true`, `standardFlowEnabled: false`, `directAccessGrantsEnabled: false`, `publicClient: false`. Its service-account user `service-account-ai-grid-backend` gets the `realm-management` client roles `manage-organizations`, `view-users`, `query-users`, `manage-users` (the last only once member management ships). Token request: `POST /realms/ai-grid/protocol/openid-connect/token` with `grant_type=client_credentials`, `client_id=ai-grid-backend`, `client_secret=<secret>`; cache the token until `exp - 30s`; on a 401 from the admin API, refetch once and retry.

---

## 7. Backend mapping today and gaps

`internal/keycloak/client.go` (`ListOrganizations`):

1. `POST {KEYCLOAK_URL}/realms/{KEYCLOAK_ADMIN_REALM}/protocol/openid-connect/token` with `grant_type=password`, `client_id=admin-cli`, `username`, `password`. Non-2xx: `fmt.Errorf("Keycloak token request returned %s: %s", status, body)` (first 4 KiB of body, which for a bad password is the `invalid_grant` JSON).
2. `GET {KEYCLOAK_URL}/admin/realms/{KEYCLOAK_REALM}/organizations?first=0&max=100` with `Authorization: Bearer`. Non-2xx: `fmt.Errorf("Keycloak organizations request returned %s: %s", status, body)`. Decodes into `struct{ID, Name string; Domains []struct{Name string}}`.
3. Network/DNS failure: `fmt.Errorf("request Keycloak token: %w", err)` / `"request Keycloak organizations: %w"`. No timeout beyond the gRPC context (`http.DefaultClient`).
4. `Service.ListTenants` returns these errors unchanged; a `nil` client yields `fmt.Errorf("Keycloak tenant client is not configured")`.

Consequence: every failure (unreachable, realm missing 404, bad credentials 400/401, forbidden 403, orgs disabled 404) reaches the BFF as gRPC `codes.Unknown` with a message containing Keycloak's status line and body; `bff-api.md` maps "any other backend code" to 502 with a generic message and logs the detail. Nothing is `Unavailable`, `NotFound` or `FailedPrecondition` today, so the BFF cannot distinguish "Keycloak down" from "misconfigured".

Config: env `KEYCLOAK_URL` (default `http://keycloak.ai-grid.svc:8080`), `KEYCLOAK_ADMIN_REALM` (`master`), `KEYCLOAK_REALM` (`ai-grid`), `KEYCLOAK_ADMIN_USERNAME`, `KEYCLOAK_ADMIN_PASSWORD` (`cmd/ai-grid-backend/main.go`). The console's deploy already provides these from a deploy-time Secret (recent commits `69059c0`, `7a7d947`).

Mapping: `Tenant{Id: org.id, Name: org.name, Domains: [d.name for d in org.domains]}`. The BFF (`bff/internal/api/tenants.go`) sorts by name and normalises `domains` to `[]`; the frontend type `Tenant {id, name, domains}` matches.

Gaps versus Keycloak and versus `bff-api.md` / `work-breakdown.md` Step 6:

| Needed by the console | Proto today | Keycloak has |
|---|---|---|
| Create, update, delete tenant (POST/PUT/DELETE `/api/v1/tenants[/{name}]`) | only `ListTenants` | `POST`/`PUT`/`DELETE /organizations` |
| Paging and search for a long tenant list | none (hard-coded 100) | `first`, `max`, `search`, `exact`, `count` |
| Show/toggle enabled | missing | `enabled` |
| Stable short handle (used in URLs; the BFF route uses `{name}` today) | `name` only | `alias` (immutable, URL-safe) |
| Description, free-form metadata | missing | `description`, `attributes` |
| Domain verification state, per-domain IdP routing | `domains: []string` | `domains[]{name, verified, identityProviderAlias, autoRedirect}` |
| Members (list, add existing user, remove, invite) | missing | `/members`, `/members/invite-user` |
| Error semantics (409/404/400 to the UI) | all `Unknown` -> 502 | distinct HTTP codes and messages |
| Credential | master bootstrap admin, password grant | realm-local service account, client_credentials |

---

## 8. Proposal: `Tenants` service

### 8.1 Proto sketch (`ai_grid.v1`)

```proto
service Tenants {
  rpc ListTenants(ListTenantsRequest) returns (ListTenantsResponse);
  rpc GetTenant(GetTenantRequest) returns (Tenant);
  rpc CreateTenant(CreateTenantRequest) returns (Tenant);
  rpc UpdateTenant(UpdateTenantRequest) returns (Tenant);
  rpc DeleteTenant(DeleteTenantRequest) returns (google.protobuf.Empty);
  rpc ListTenantMembers(ListTenantMembersRequest) returns (ListTenantMembersResponse);
  rpc AddTenantMember(AddTenantMemberRequest) returns (TenantMember);
  rpc RemoveTenantMember(RemoveTenantMemberRequest) returns (google.protobuf.Empty);
}

message Tenant {
  string id = 1;                 // Keycloak organization id (UUID v4), output only
  string name = 2;               // unique per realm
  repeated string domains = 3;   // kept for compatibility: domain names only
  string alias = 4;              // unique, URL-safe, immutable after create; defaults to name
  bool enabled = 5;              // default true
  string description = 6;
  string redirect_url = 7;
  map<string, string> attributes = 8;        // first value of each Keycloak attribute (Keycloak stores string lists)
  repeated TenantDomain domain_details = 9;  // full domain records
}

message TenantDomain { string name = 1; bool verified = 2; string identity_provider_alias = 3; bool auto_redirect = 4; }

message ListTenantsRequest {
  int32 page_size = 1;    // -> max; server default 50, cap 200; Keycloak default is 10
  string page_token = 2;  // opaque; encodes the offset (-> first)
  string search = 3;      // -> search (contains on name or domain)
  bool exact = 4;         // -> exact
}
message ListTenantsResponse { repeated Tenant tenants = 1; string next_page_token = 2; int64 total_size = 3; /* from /count */ }

message GetTenantRequest    { string id = 1; }
message CreateTenantRequest { Tenant tenant = 1; }          // id, alias optional; enabled defaults true
message UpdateTenantRequest { Tenant tenant = 1; google.protobuf.FieldMask update_mask = 2; }  // backend does GET+merge+PUT
message DeleteTenantRequest { string id = 1; }

message TenantMember {
  string id = 1; string username = 2; string email = 3; string first_name = 4; string last_name = 5;
  bool enabled = 6; MembershipType membership_type = 7;
}
enum MembershipType { MEMBERSHIP_TYPE_UNSPECIFIED = 0; UNMANAGED = 1; MANAGED = 2; }
message ListTenantMembersRequest  { string tenant_id = 1; int32 page_size = 2; string page_token = 3; string search = 4; }
message ListTenantMembersResponse { repeated TenantMember members = 1; string next_page_token = 2; int64 total_size = 3; }
message AddTenantMemberRequest    { string tenant_id = 1; string user_id = 2; }   // existing realm user
message RemoveTenantMemberRequest { string tenant_id = 1; string user_id = 2; }
```

Design notes:
- Keep `Tenant.id/name/domains` field numbers 1-3 so the current BFF and frontend keep compiling; the new fields are additive.
- `UpdateTenant` with a field mask lets the backend hide Keycloak's replace semantics (GET, apply mask, PUT), so the UI can toggle `enabled` without resending attributes. The backend must never send `alias` different from the stored one.
- `CreateTenant` returns the created `Tenant`: the backend reads the id from `Location` and does a follow-up `GET` (one extra call; keeps the API self-contained).
- The BFF route should key tenants by `id` (`/api/v1/tenants/{id}`) rather than `{name}` as `bff-api.md` currently sketches; names can change, ids and aliases cannot.

### 8.2 gRPC status codes the real backend should return

| Keycloak outcome | gRPC code | BFF HTTP (per `bff-api.md`) |
|---|---|---|
| `409 {"errorMessage": "A organization with the same name already exists."}` / alias / `"User is already a member of the organization."` | `AlreadyExists`, message = `errorMessage` | 409 |
| `404 {"errorMessage": "Organization not found."}`, member `404` | `NotFound` | 404 |
| `400 {"errorMessage": ...}` (domain, alias, redirect URL, name blank) | `InvalidArgument`, message = `errorMessage` | 422 |
| Request validation before calling Keycloak (empty name, bad page token) | `InvalidArgument` | 422 |
| `404 {"errorMessage": "Organizations not enabled for this realm."}`, `404 {"error": "Realm not found."}` | `FailedPrecondition` (deployment misconfiguration, not a caller error) | 412 |
| Token endpoint `400/401 invalid_grant` / `invalid_client`, admin API `401`/`403` (backend credential problem) | `Internal`, generic message, detail logged (never forward the Keycloak body: it can echo the credential context) | 502 (generic) |
| Connection refused, DNS, TLS failure, 502/503 from the route, 5xx from Keycloak | `Unavailable` | 503 |
| Context deadline hit while talking to Keycloak | `DeadlineExceeded` | 504 |
| Caller is not a provider admin (once the backend checks the caller) | `PermissionDenied` | 403 |

### 8.3 What the fake backend must simulate

- In-memory store keyed by id; generate UUID v4 ids; seed with a handful of tenants including one disabled and one with two domains and attributes.
- Uniqueness of `name` and `alias` (409 `AlreadyExists` with the exact Keycloak messages), alias defaulting to name, alias immutability (400 `InvalidArgument` "Cannot change the alias"), domain format rules and cross-tenant domain uniqueness (400 messages from 5.7), `enabled` default true.
- Paging: offset-based under the hood, `total_size` from the count, results sorted by name; `search` as case-insensitive contains on name or domain; `exact` as equality.
- Full-replace semantics on update when no mask is given (so a client that forgets a field sees the same data loss it would see against Keycloak); mask-based merge when given.
- Delete removes the tenant and its memberships; members are "unmanaged" realm users and remain available for re-adding (keep a small fake user list to pick from).
- Error-injection hooks (as `backendtest.Fake.Err` does today) to return `Unavailable`, `FailedPrecondition` and `Internal`, and an optional latency knob (Keycloak via the route typically answers in 50-300 ms; the real backend does two HTTP round trips per RPC today: token + list).
- A token-expiry scenario is not visible to the BFF (it is internal to the backend), so the fake does not need one.
- Frontend `MockConsoleService` mirrors the same rules (409 on duplicate name, 404 on unknown id, 422 on invalid domain) using the BFF's `{"error": {"code", "message"}}` envelope so the UI's error handling is exercised without a backend.

---

## 9. Bootstrap plan: `ai-grid` realm and service-account client

Suitable for a deploy script run once per hub with a one-time admin credential (bootstrap admin or a temporary `master` user with the `admin` role). Fictional values throughout. `kcadm.sh` lives in `/opt/keycloak/bin` in the Keycloak image; the REST equivalents are given for a `curl`-only Job like the backend's `deploy/kind/keycloak.yaml`.

1. Authenticate the script (once, short-lived):
   ```sh
   kcadm.sh config credentials --server https://sso.example.com --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"
   # REST: POST /realms/master/protocol/openid-connect/token  grant_type=password client_id=admin-cli username=... password=...
   ```
2. Create the realm with organizations enabled (idempotent: 201 or 409):
   ```sh
   kcadm.sh create realms -s realm=ai-grid -s enabled=true -s organizationsEnabled=true -s displayName="AI Grid"
   # REST: POST /admin/realms  {"realm":"ai-grid","enabled":true,"organizationsEnabled":true}
   # If it already exists: PUT /admin/realms/ai-grid {"organizationsEnabled":true}  -> 204
   ```
3. Create the confidential service client:
   ```sh
   kcadm.sh create clients -r ai-grid -s clientId=ai-grid-backend -s protocol=openid-connect \
     -s publicClient=false -s serviceAccountsEnabled=true -s standardFlowEnabled=false \
     -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false -s 'description=AI Grid backend service account'
   # REST: POST /admin/realms/ai-grid/clients {...same fields...}  -> 201, Location: .../clients/<client-uuid>
   CID=$(kcadm.sh get clients -r ai-grid -q clientId=ai-grid-backend --fields id --format csv --noquotes)
   kcadm.sh get clients/$CID/client-secret -r ai-grid        # {"type":"secret","value":"<generated>"}
   # or set your own: kcadm.sh update clients/$CID -r ai-grid -s secret="$GENERATED_SECRET"
   ```
   Store the secret in the backend's Secret (`KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_REALM=ai-grid`, `KEYCLOAK_URL=https://sso.example.com` or the in-cluster `http://keycloak.grid-sso.svc:8080`).
4. Grant the service-account user the minimal `realm-management` roles:
   ```sh
   kcadm.sh add-roles -r ai-grid --uusername service-account-ai-grid-backend --cclientid realm-management \
     --rolename manage-organizations --rolename view-users --rolename query-users
   # add --rolename manage-users when member add/remove ships; use view-organizations instead of manage-organizations for a read-only deployment
   # REST: GET /admin/realms/ai-grid/clients?clientId=realm-management -> <rm-id>
   #       GET /admin/realms/ai-grid/clients/<rm-id>/roles/manage-organizations -> role rep
   #       GET /admin/realms/ai-grid/clients/<client-uuid>/service-account-user -> {"id": "<sa-user-id>", ...}
   #       POST /admin/realms/ai-grid/users/<sa-user-id>/role-mappings/clients/<rm-id>  [ {role rep}, ... ] -> 204
   ```
5. Verify without the admin credential:
   ```sh
   TOKEN=$(curl -fsS -X POST https://sso.example.com/realms/ai-grid/protocol/openid-connect/token \
     -d grant_type=client_credentials -d client_id=ai-grid-backend -d client_secret="$SECRET" | jq -r .access_token)
   curl -fsS -H "Authorization: Bearer $TOKEN" 'https://sso.example.com/admin/realms/ai-grid/organizations?max=10'   # 200 []
   curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -X POST -H 'Content-Type: application/json' \
     https://sso.example.com/admin/realms/ai-grid/organizations -d '{"name":"acme-robotics","domains":[{"name":"acme.example.com","verified":false}]}'   # 201
   ```
6. Optional hardening: set `accessTokenLifespan` for the client (`attributes."access.token.lifespan"`) to 300-900 s; turn on admin events for the realm (`adminEventsEnabled=true`) so tenant mutations are auditable; do not give the service account `manage-realm`.
7. Backend change: replace the password grant in `internal/keycloak/client.go` with `client_credentials` against `/realms/ai-grid/...` (same realm as the admin API), cache the token by `exp`, and drop `KEYCLOAK_ADMIN_REALM/USERNAME/PASSWORD`.

---

## 10. Open questions

1. **Which Keycloak and realm is authoritative for tenants?** The hub's `grid-sso` already imports a SaaS-style realm with `organizationsEnabled: true` and two organizations linked to per-tenant IdP realms. Is `ai-grid` a new realm, or should the console read that existing realm? (`work-breakdown.md` open question for Lindani Phiri / Andrew Ballantyne / Swati's team.)
2. **Tenant identity in URLs**: `bff-api.md` plans `/api/v1/tenants/{name}`; Keycloak's stable, URL-safe handle is `alias` (immutable) and the primary key is `id`. Recommend `id` in the API and `alias` for display/links.
3. **Members**: are AI Grid tenant members realm users of `ai-grid` (unmanaged, added by id), or federated through each tenant's IdP (managed, auto-membership)? This decides whether the console needs `AddTenantMember` or only read access plus `invite-user` (which also needs SMTP on the realm).
4. **Attribute conventions**: Keycloak attributes are `map<string, list<string>>`. Which keys does AI Grid want (region, billing account, quota)? The proto above flattens to the first value.
5. **Error detail exposure**: should Keycloak's `errorMessage` text be shown to users verbatim (it is reasonably user-friendly: "A organization with the same name already exists.") or re-worded by the backend?
6. **Admin permissions v2**: if the realm later enables fine-grained admin permissions, `query-only` callers get per-organization filtered lists instead of `[]`; the mock does not need this, but the role table in section 6 would change.
7. **Direct-grant status code**: 26.8.0 returns 400 for `invalid_grant` on bad credentials; some docs and older servers return 401. The backend only checks `/100 != 2`, so it does not matter today, but a mock's token endpoint should pick 400 for 26.8.
8. **Version drift**: the backend's Kind setup pins Keycloak 26.3; the hub runs 26.8.0. The Organizations endpoints used are identical, but the invitation API and domain routing fields (`identityProviderAlias`, `autoRedirect` on domains) are newer and only matter if the console starts using them.
