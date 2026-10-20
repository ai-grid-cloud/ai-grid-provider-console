# BFF plan

> **Most of this page is scheduled for deletion.** It documents a hand-written REST API that
> [ADR-0002](../adr/0002-connect-end-to-end-with-vanguard-for-rest.md) replaces with Connect:
> the `{"data"}`/`{"meta"}` envelope, the `ETag`/`If-Match`/428 protocol, the error-status
> table and the endpoint table all go. What survives is the deployment topology and the
> identity flow. See also [ADR-0001](../adr/0001-the-contract-lives-in-the-backend.md)
> (the contract moves to the backend) and
> [ADR-0004](../adr/0004-the-bff-is-a-thin-relay.md) (what the BFF keeps doing).
>
> Two corrections to what follows, both verified on 2026-10-19:
>
> - The backend is **`ai-grid-cloud/ai-grid-provider-backend`**, not `yuvalturg/ai-grid-backend`.
>   The repository referenced below, and vendored in `mock/proto/upstream/COMMIT`, is a
>   different one — so the nightly drift job has been green while real divergence accumulated.
> - "The backend decides what the caller may do" is **aspirational, not current**. The backend
>   builds its gRPC server with no interceptors and talks to Kubernetes with its own
>   ServiceAccount, so the forwarded token is read by nothing. ADR-0004 has the agreed fix.

The console is a React and PatternFly frontend served by a thin Go backend-for-frontend
(BFF). The BFF owns login, static assets and the JSON API the browser uses. Everything
else, every call to the ACM hub, to Keycloak and to metrics, is the job of
`ai-grid-backend`, a gRPC service in its own repository.

```
browser --JSON--> kube-auth-proxy + bff --gRPC--> ai-grid-backend --> hub API, Keycloak, Thanos
```

The feature plan that this implements is `ai-grid-provider-portal-ui-plan.md` (Steps 0 to
11), written against Kris Verlaenen's Node POC (`krisv/ai-grid-cloud-provider-poc`). Its
page designs and ACM conventions are kept. Its backend is replaced by two pieces: the
backend service for cluster access and this BFF for the browser.

## The backend

- Repository: https://github.com/yuvalturg/ai-grid-backend (Yuval Turgeman). The Go module
  path is `github.com/osac-project/ai-grid-backend`; the console does not import the module.
- Contract: `proto/ai_grid/v1/ai_grid.proto` in the backend repository. The console pins it
  by a vendored copy, `mock/proto/upstream/ai_grid.proto` with its commit in
  `mock/proto/upstream/COMMIT` (`hack/sync-upstream-proto.sh <ref>` refreshes both).
- What the BFF compiles against: the console's draft proto in `mock/proto/ai_grid/v1`,
  generated into `bff/gen/ai_grid/v1` (`make -C bff generate`). The draft carries the
  backend's three RPCs unchanged plus the shapes proposed in
  `mock/research/backend-conventions.md` section 6; `bff/internal/protodrift` fails when it
  stops being a superset of the vendored backend file. When the backend ships the RPCs the
  console switches the import back to the backend's `gen/ai_grid/v1` and deletes the draft.
  See `mock/proto/README.md`.
- Runs with its own ServiceAccount (`get/list/watch` on `ManagedCluster`) and Keycloak admin
  credentials. It is aligned with OSAC's fulfillment-service and is the "OSAC-like API
  layer" from the 2026-10-14 thread.
- RPCs on 2026-10-15: `AiGrid/Ping`, `ManagedClusters/ListManagedClusters` (name, labels,
  hubAcceptsClient), `Tenants/ListTenants` (Keycloak Organizations in the `ai-grid` realm).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Language | Go, standard library `net/http` router, `google.golang.org/grpc` client against the draft `ai_grid.v1` package generated in `bff/gen` from `mock/proto`. No `client-go`, no backend module dependency. | The BFF reads nothing from the hub; its one Kubernetes call is a `SelfSubjectAccessReview` over plain HTTPS (`internal/hub`). One dependency less to keep in step with the hub. Compiling against the draft lets the BFF, the fake and the UI move ahead of the backend; the drift test keeps the draft honest against the vendored backend proto. |
| Identity | kube-auth-proxy authenticates the browser and sets `x-forwarded-user`, `x-forwarded-email`, `x-forwarded-groups` and `x-forwarded-access-token`. The BFF reads them (`internal/identity`) and forwards the token as `authorization: Bearer` plus the user, email and groups as gRPC metadata on every RPC (`internal/backend`). The draft proto's `AiGrid/GetCurrentUser` is the RPC that will return the backend's view of the caller. | The backend decides what the caller may do; the BFF has no credential of its own and no authorization logic. The proxy's provider can change (OpenShift OAuth today, a Keycloak realm later) without touching the BFF. |
| `isProviderAdmin` | The hub's answer to a `SelfSubjectAccessReview` for `patch` on `managedclusters`, asked with the caller's own token (`HUB_API_URL`, in-cluster by default). | The user's RBAC decides, not a console setting, as PR 1 did (review of 2026-10-15). The UI only uses it to show or hide actions; the backend authorizes every call. A `GetCurrentUser` RPC can take this over once the backend acts as the caller. |
| Login in development | The Vite dev server and `hack/api.sh` set the same headers from `oc whoami` and `oc whoami -t`. The backend runs locally with `--kubeconfig` (`hack/dev-backend.sh`). | Any developer who has run `oc login` works against a real hub. |
| Deployment | One pod: kube-auth-proxy (:8443), bff on `127.0.0.1:8080`, ai-grid-backend on `127.0.0.1:9090`. The BFF dials the backend in plaintext over loopback; plaintext to any other address is refused unless `BACKEND_INSECURE=true`. The kubelet probes `/readyz` through the proxy (`--skip-auth-route=^/readyz$`); neither the BFF nor the backend has a probe of its own. | Nothing on the pod network can reach the BFF with forged identity headers or the backend at all. When the backend gets its own Deployment, set `BACKEND_ADDRESS` to its Service and `BACKEND_CA_FILE` to its serving CA. |
| Cluster labels | `ai-grid/enabled`, `ai-grid/provisioned`, `location`, `ai-grid/site`, `ai-grid/region`, and ACM's `openshiftVersion`. | The POC's conventions (site and region were added to the POC on 2026-10-14) so that Placements written by either tool select the same clusters. The BFF derives fields from the labels the backend returns. |
| Response envelope | Success: `{"data": ...}`; a paged list adds `"meta": {"size", "total", "offset", "limit"}` next to `data` (`limit` omitted when the caller asked for everything, `total` omitted when it is unknown; see "Writes, versions and lists"). Error: `{"error": {"code": "<http status>", "message": "..."}}`. `DELETE` answers 204 with no body. | Same as the odh-dashboard BFFs; `meta` is only on list endpoints that page, so the shape of `data` never changes. |
| Tests | `httptest` against an in-memory backend (`internal/backend/backendtest`, gRPC over `bufconn`). | No cluster, no binaries; the fake records incoming metadata so identity forwarding is tested. `hack/smoke.sh` checks a live backend. |

## Modules

```
bff/
  cmd/                  flags, server start and graceful stop
  internal/config       flags and env vars
  internal/identity     Identity from proxy headers, context helpers
  internal/backend      gRPC client, identity-forwarding interceptor; backendtest/ fake server
  internal/api          App, routes, middleware, gRPC-to-HTTP error mapping, handlers, SPA
```

Adding an endpoint: draft the RPC in `mock/proto/ai_grid/v1` (and propose it to the backend),
`make -C bff generate`, implement or stub it in the fake, map it in a handler under `internal/api`, add it to the table below and to
`frontend/src/api/ConsoleService.ts`.
The handler does transport only; validation, defaults, versions, filtering and derived fields
belong to the backend (the root `AGENTS.md`, which also lists the exceptions the BFF still has).

## Endpoints

Paths are under `/api/v1`, except `/healthcheck` and `/readyz` at the root.

### Implemented

| Method | Path | Returns | Backend RPC |
|---|---|---|---|
| GET | `/healthcheck` | `{status, version}` | none; liveness, no auth |
| GET | `/readyz` | `{status, version, backend}` | `AiGrid/Ping`; readiness, 503 when the backend does not answer |
| GET | `/api/v1/user` | `{username, email?, groups, isProviderAdmin}` (`email` omitted when the proxy sends none) | none; the identity from the proxy headers, `isProviderAdmin` from a hub `SelfSubjectAccessReview` |
| GET | `/api/v1/config` | `{gridEndpoint, mapTileUrl, mapTileAttribution, billingUrl, version, modelsNamespace, fakeBackend}`: `modelsNamespace` is the namespace the console creates models in (default `ai-grid-models`) and `fakeBackend` makes the UI show its fake-backend banner | none; env `GRID_CONSUMER_URL`, `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` (the attribution shown with `MAP_TILE_URL`'s tiles; with no `MAP_TILE_URL` the map shows no basemap), `BILLING_URL`, `MODELS_NAMESPACE`, `FAKE_BACKEND` |
| GET | `/api/v1/clusters` | `GridCluster[]` sorted by name | `ManagedClusters/ListManagedClusters` |
| GET | `/api/v1/clusters/{name}` | `GridCluster`, `ETag: "<resourceVersion>"` | `ManagedClusters/GetManagedCluster`; 404 with the backend's message when absent. Against a backend without that RPC (the shipped one answers `Unimplemented`) the BFF filters `ListManagedClusters` by name instead, so the detail works either way |
| PATCH | `/api/v1/clusters/{name}` | `GridCluster` after the write, with its `ETag` | `UpdateManagedCluster` (no read first) with the present body fields as the object and the mask (`labels`, `annotations`) and `lock: true` on the `If-Match` version; an empty body is 422; 409 when the hub object is not at that version, 428 without `If-Match`, 422 on a bad body or `If-Match`, a coordinate annotation the backend refuses or a change to a key outside the console's (`ai-grid/*`, `location`), 413 over 1 MiB, 415 when the body is not `application/json` |
| GET | `/api/v1/tenants?offset=&limit=&filter=` | `Tenant[]` in Keycloak's order (by name, the realm database's collation) plus `meta`; `filter` is a CEL expression the client writes, over `this` (a Tenant), see "Writes, versions and lists"; `limit` omitted returns everything; the removed `search` is 422 | `Tenants/ListTenants` with `offset`, `limit` and `filter` exactly as sent |
| GET | `/api/v1/tenants/{id}` | `Tenant`, `ETag: "<resourceVersion>"` | `Tenants/GetTenant`; 404 with the backend's message when absent |
| POST | `/api/v1/tenants` | 201, `Tenant` as created, `Location: /api/v1/tenants/{id}`, `ETag` | `Tenants/CreateTenant`; 422 with Keycloak's message on a bad name, alias or domain, 409 on a taken name or alias |
| PATCH | `/api/v1/tenants/{id}` | `Tenant` after the write, with its `ETag` | `Tenants/UpdateTenant` with the present body fields as the mask (`alias` included) and the `If-Match` version as `object.resource_version`; an empty body is 422; 422 "Cannot change the alias", 409 on a taken or blank name (Keycloak's own answer to a blank one) or a stale `If-Match`, 428 without `If-Match` |
| DELETE | `/api/v1/tenants/{id}` | 204 | `Tenants/DeleteTenant` with the `If-Match` version as `resource_version`; 404 when absent, 409 on a stale `If-Match`, 428 without `If-Match` |
| GET | `/api/v1/models?offset=&limit=&filter=` | `Model[]` by namespace and name plus `meta`; `filter` is CEL over `this` (a Model) as for tenants; the removed `namespace` and `label` are 422 | `Models/ListModels` with `offset`, `limit` and `filter` exactly as sent |
| GET | `/api/v1/models/{namespace}/{name}` | `Model`, `ETag: "<resourceVersion>"` | `Models/GetModel`; 404 with the backend's message (`object with identifier '<ns>/<name>' not found`) |
| POST | `/api/v1/models` | 201, `Model` with no conditions yet, `Location: /api/v1/models/{namespace}/{name}`, `ETag` | `Models/CreateModel`; 422 with the API server's or the CRD's message (a name that is not a DNS-1123 subdomain, a negative `replicas`, `replicas` with `scaling`, `scaling` without `maxReplicas`, without a trigger, with `maxReplicas` below 1 or a negative `minReplicas` (`minReplicas: 0` counts as unset and defaults to 1) or with `minReplicas` above `maxReplicas`) or the console's own (URI scheme, Placement operators, rollout fields, `rollout` without `placement`), 409 on a taken name, 412 `ManifestWorkReplicaSet feature gate disabled on hub` when `placement` is set on a hub without the controller |
| PATCH | `/api/v1/models/{namespace}/{name}` | `Model` after the write, with its `ETag` | `UpdateModel` (no read first) with every present field as the mask (`spec.replicas`, `spec.main.image`, `spec.main.env`, `spec.placement`, `spec.rollout`, `metadata.labels`, `metadata.annotations`) and `lock: true` on the `If-Match` version; an empty body is 422; 409 when the object is not at that version, 428 without `If-Match`, 412 when a placement is added on a gated hub |
| DELETE | `/api/v1/models/{namespace}/{name}` | 204; the model is gone at once (the MWRS cascades `Background`, its works drain out of sight) | `Models/DeleteModel` with the `If-Match` version as `resource_version`; 404 when absent, 409 on a stale `If-Match`, 428 without `If-Match`, 412 while a catalog entry, a subscription or an auth policy references the model (on the fake, subscriptions and auth policies block it; catalog entries don't exist yet) |
| GET | `/api/v1/capabilities` | `{manifestWorkReplicaSetEnabled, observabilityInstalled, acmVersion}` | `AiGrid/GetHubCapabilities`; 501 against a backend without the RPC, which a client reads as "unknown" |
| GET | `/api/v1/locations` | `string[]`: the `location` labels a model can be placed on, in the backend's order | `Models/ListLocations` (proposal P7, `mock/proto/README.md`) |
| GET | `/api/v1/subscriptions` | `Subscription[]` in the backend's order | `Subscriptions/ListSubscriptions` |
| GET | `/api/v1/subscriptions/{name}` | `ETag: "<resourceVersion>"`, `{subscription, authPolicies, modelRegistrations, modelRefs}`: the subscription, the authorization policies that cover its models, the status of each referenced model's registration, and the referenced models in the `Model` JSON | `Subscriptions/GetSubscription`; 404 with the backend's message when absent |
| POST | `/api/v1/subscriptions` | 201, `{subscription, authPolicy?}`, `Location: /api/v1/subscriptions/{name}` | `Subscriptions/CreateSubscription` with `createAuthPolicy` from the body; 422 with `fieldErrors` on a bad body, 409 on a taken name |
| PUT | `/api/v1/subscriptions/{name}` | `{subscription}` after the write, with its `ETag` | `Subscriptions/UpdateSubscription`; the `If-Match` version is `object.resource_version` with `lock: true` (below), 409 when stale, 428 without `If-Match`, 422 with `fieldErrors` |
| DELETE | `/api/v1/subscriptions/{name}` | 204 | `Subscriptions/DeleteSubscription` with the `If-Match` version as `resource_version`; 404 when absent, 409 when stale, 428 without `If-Match` |
| GET | `/api/v1/grid/overview?range=1h\|6h\|24h&site=&metrics=false` | `GridOverview`: `{updatedAt, inventorySource?, demo, metricsSource?, clusters, metrics}`; `inventorySource` (`acm\|git`) and `metricsSource` (`thanos\|demo`) are omitted when the backend does not say, and each metric's `status` (`ok\|no-data\|unavailable\|not-configured`) likewise | `Grid/GetOverview`; `range` is forwarded as sent (the backend defaults it to `1h` and refuses anything but `1h`, `6h` and `24h` with 422), an empty `site` selects every site and only `metrics=false` leaves the metrics out |

`GridCluster` (fields the shipped backend does not fill are omitted or empty, so a client
also works against a backend that only returns `name`, `labels`, `hubAcceptsClient`):

```json
{
  "name": "site-paris-1",
  "aiGridEnabled": true,
  "provisioned": true,
  "hubAcceptsClient": true,
  "location": "paris",
  "site": "paris-dc1",
  "region": "europe-west",
  "openshiftVersion": "4.22.15",
  "status": "ready",
  "statusMessage": "Managed cluster is available",
  "consoleUrl": "https://console-openshift-console.apps.site-paris-1.example.com",
  "kubernetesVersion": "v1.35.6",
  "platform": "BareMetal",
  "product": "OpenShift",
  "gpuCapacity": 16,
  "siteName": "Paris DC1",
  "latitude": 48.8566,
  "longitude": 2.3522,
  "addons": {"work-manager": "available", "cluster-proxy": "available", "...": "..."},
  "conditions": [{"type": "ManagedClusterConditionAvailable", "status": "True", "reason": "ManagedClusterAvailable", "message": "Managed cluster is available", "lastTransitionTime": "2026-10-01T09:00:08Z"}],
  "resourceVersion": "48811204",
  "labels": {"ai-grid/enabled": "true", "...": "..."},
  "annotations": {"ai-grid/site-name": "Paris DC1", "...": "..."}
}
```

- `status` is the backend's `status.state`, derived server-side from the conditions in the
  ACM console's order (`mock/research/acm.md` section 1), in the ACM console's words:
  `ready | offline | unknown | pendingimport | importing | importfailed | detaching | notaccepted`.
  `statusMessage` is the message of the condition that decided it. When the backend reports
  no state (`MANAGED_CLUSTER_STATE_UNSPECIFIED`: a cluster with no conditions, or today's
  backend that sends no status at all) `status` is omitted. The ACM console shows `failed`
  for a cluster with no conditions; the BFF deliberately does not, because the same value also means "the backend did not derive one".
- `consoleUrl`, `platform`, `product` come from the claims
  `consoleurl.cluster.open-cluster-management.io`, `platform.open-cluster-management.io`,
  `product.open-cluster-management.io`; `gpuCapacity` from `status.capacity["nvidia.com/gpu"]`
  (0 when absent); `addons` from the `feature.open-cluster-management.io/addon-*` labels.
- `siteName`, `latitude`, `longitude` come from the `ai-grid/site-name`, `ai-grid/latitude`,
  `ai-grid/longitude` annotations; coordinates are omitted when absent or not a finite number
  in range (`NaN` and `Inf` parse but cannot be encoded, so they count as absent).
- `conditions[].lastTransitionTime` is omitted when the hub recorded none; it is never the
  Unix epoch.

`PATCH /api/v1/clusters/{name}` body, every field optional:

```json
{"labels": {"name": "site-paris-1", "ai-grid/enabled": "true", "location": "paris", "...": "..."},
 "annotations": {"ai-grid/site-name": "Paris DC1", "ai-grid/latitude": "48.8566", "...": "..."}}
```

A present map replaces the stored one as a whole (FieldMask semantics, as in OSAC; there are no
per-key paths), so a page that enrols a cluster sends the `labels` map it loaded with
`ai-grid/enabled` set to `"true"`, and removes a label or annotation by leaving it out of the
map; an absent field or `null` is left alone. The BFF writes the present fields into one
`UpdateManagedCluster` (object, mask, `lock: true` on `If-Match`) without reading the cluster
first and without merging, comparing or validating the maps; unknown fields, wrong types and
anything after the object are 422, more than 1 MiB is 413. A body that names no field is 422
`the request body names no field to change`, before any call. Hub acceptance
(`hubAcceptsClient`) is read-only here: no page needs to write it, and turning it off makes the
hub drop a live site. The backend does the rest: the hub's webhook and controllers put back what
they own (the `name` and default clusterset labels, the add-on labels, `clusterID`,
`openshiftVersion*` and the `open-cluster-management/created-via` annotation; not a removed
`cloud` or `vendor`), and the fake does the same before `UpdateManagedCluster` answers, so the
response shows the labels as the hub keeps them; an `ai-grid/latitude` or `ai-grid/longitude`
annotation must be a number within -90..90 or -180..180 when it is present and not blank,
surrounding whitespace allowed as on the read side (422 `annotation "ai-grid/latitude" must be a
number between -90 and 90, got "<v>"`, a console proposal for the backend, which owns the
convention); only the console's keys may change: adding, changing or removing a label or
annotation outside `ai-grid/*`, `ai-grid-mock/*` (the fake's test switches) and the `location`
label is 422 `label "<k>" cannot be changed through the console; only ai-grid/* labels and
annotations and the location label can` (compared after the hub has put back its own labels, so
leaving one of those out is fine; a console proposal, the hub lets a provider admin patch any
label); and an update that leaves labels and annotations as stored is not written (the response
keeps the stored `resourceVersion`, as the API server's does).

The lock is on the ManagedCluster's `resourceVersion`, which the hub also moves when its
registration agent or controllers write the cluster (conditions, capacity, add-on labels). On a
busy hub a page that waits before saving can get 409 although nobody edited its labels; the
page reloads and retries. Whether the backend should instead retry once by itself when the
stored labels and annotations still equal what the client loaded is an open question for the
backend team (`mock/areas/clusters.md`, "What remains").

`Tenant` (a Keycloak Organization in the `ai-grid` realm, `mock/research/keycloak.md` section 4;
the collections are always present even though Keycloak omits an empty `domains`):

```json
{
  "id": "3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c",
  "name": "acme-robotics",
  "alias": "acme-robotics",
  "enabled": true,
  "description": "Acme Robotics, EU region",
  "domains": ["acme-robotics.example.com", "acme.example.org"],
  "domainDetails": [
    {"name": "acme-robotics.example.com", "verified": true, "autoRedirect": true},
    {"name": "acme.example.org", "verified": false, "autoRedirect": false}
  ],
  "attributes": {"ai-grid/region": "europe-west", "billing-account": "ACME-0042"},
  "identityProvider": {"...": "..."},
  "resourceVersion": "1",
  "createTime": "2026-10-10T08:00:00Z"
}
```

- `alias` is the URL-safe handle: it defaults to `name` on create and cannot change
  afterwards. Against today's backend (fields `id`, `name`, `domains` only) the BFF fills it
  from `name`, derives `domainDetails` from `domains` and reads the absent `enabled` as true
  (Keycloak's default), so a client does not see every tenant as disabled.
- `domains` are the names of `domainDetails`, lower-case, unique across tenants; Keycloak
  accepts the domain part of an e-mail address or one wildcard `*.base.tld`.
  `identityProviderAlias` is present only for a domain routed to one of the organization's
  identity providers; the fake realm has none, so the fake never returns it.
- `identityProvider` is the organization's OIDC identity provider as the console's organization
  wizard configures it (proposal P1, `Tenant.identity_provider = 11`); omitted for an
  organization without one. A write that sets it is validated by the backend, whose field
  violations come back as `fieldErrors` under `identityProvider.*`.
- `createTime` is when the backend created the organization (proposal P3,
  `Tenant.create_time = 12`, output only); omitted for an organization created some other way,
  which the console shows as "—".
- `resourceVersion` is the version the backend keeps for the tenant (Keycloak has none), also
  sent as the `ETag`; omitted from a backend that keeps none (today's).

`POST /api/v1/tenants` body: `{"name": "acme-robotics", "alias": "acme", "description": "...",
"enabled": true, "domains": ["acme.example.com"], "attributes": {"k": "v"}}`; only `name` is
required, `alias` defaults to the name, an omitted `enabled` is passed through as unset and
the backend applies Keycloak's default (true). Unknown fields, trailing content after the JSON
value and malformed JSON are rejected (422), a body over 1 MiB with 413; everything else is
validated by the backend, whose Keycloak message comes back as the 422 or 409 message.

`PATCH /api/v1/tenants/{id}` body, every field optional: `{"name": "...", "description": "...",
"enabled": false, "domains": ["..."], "attributes": {"k": "v"}, "alias": "<unchanged>"}`. An
absent field is left alone; a present field replaces the stored one as a whole (`domains: []`
removes every domain, `attributes: {}` every attribute; a domain that stays keeps its `verified`
and identity-provider metadata); `null` is the same as absent. The present fields become the
field mask of one `UpdateTenant` call, `alias` included: the backend keeps the stored alias and
answers a different one with Keycloak's 422 "Cannot change the alias", so a form can send back
the alias it loaded. A body that names no field is 422, before any call. The backend skips a PUT
that would change nothing (console proposal, so Keycloak writes no admin event) and answers the
tenant with its stored `resourceVersion`. Keycloak Organizations carry no version; the backend
keeps one for them (see "Writes, versions and lists").

`Model` (a KServe `LLMInferenceService`, `mock/research/models-maas.md` 2.1, with the ACM
`Placement` and `ManifestWorkReplicaSet` the backend keeps for a multi-site model,
`mock/research/acm.md` 3 and 4; close to the POC's `ManagedModel` without its inventions:
no `revision`, `status: Saved`, `hasDeployment`; collections are always present). Abridged
(fewer conditions, times elided); `mock/examples/get-models.json` has the full objects:

```json
{
  "name": "granite-8b-instruct", "namespace": "ai-grid-models",
  "displayName": "Granite 8B Instruct", "description": "Served on every enrolled and provisioned site.",
  "modelUri": "hf://example-org/granite-8b-instruct", "modelName": "example-org/granite-8b-instruct",
  "runtimeImage": "quay.io/example/vllm-cuda:v0.11.0", "replicas": 1,
  "baseRefs": ["v3-6-0-kserve-config-llm-template"],
  "requests": {"cpu": "8", "memory": "32Gi", "nvidia.com/gpu": "1"}, "limits": {"nvidia.com/gpu": "1"}, "env": [],
  "gateways": [{"name": "openshift-ai-inference", "namespace": "openshift-ingress"}],
  "phase": "ready", "reason": "Complete",
  "addresses": [], "conditions": [], "appliedConfigs": [],
  "placement": {
    "clusterSets": ["global"], "matchLabels": {"ai-grid/enabled": "true", "ai-grid/provisioned": "true"},
    "selectedClusters": ["site-paris-1"], "locations": ["paris"], "satisfied": true, "reason": "AllDecisionsScheduled", "message": "All cluster decisions scheduled",
    "conditions": [{"type": "PlacementSatisfied", "status": "True", "reason": "AllDecisionsScheduled", "message": "All cluster decisions scheduled", "lastTransitionTime": "..."}]
  },
  "rollout": {
    "strategy": "All", "progressDeadline": "15m",
    "summary": {"total": 1, "applied": 1, "available": 1, "progressing": 0, "degraded": 0},
    "rolledOut": true, "applied": true, "reason": "AsExpected",
    "conditions": [{"type": "PlacementVerified", "status": "True", "reason": "AsExpected"}, {"type": "PlacementRolledOut", "status": "True", "reason": "Complete"}, {"type": "ManifestworkApplied", "status": "True", "reason": "AsExpected"}],
    "works": [{
      "cluster": "site-paris-1", "workName": "model-granite-8b-instructx7k2p",
      "applied": "True", "available": "True", "progressing": "False", "degraded": "False",
      "feedback": {"ready": "True", "url": "https://openshift-ai-inference.apps.site-paris-1.example.com/ai-grid-models/granite-8b-instruct"},
      "conditions": [{"type": "Applied", "status": "True", "reason": "AppliedManifestWorkComplete", "message": "Apply manifest work complete"}],
      "generation": 1, "observedGeneration": 1
    }]
  },
  "labels": {"ai-grid/family": "granite"}, "annotations": {"openshift.io/display-name": "Granite 8B Instruct"},
  "resourceVersion": "48760230", "generation": 1, "creationTimestamp": "2026-10-10T08:00:00Z"
}
```

- `phase` is the backend's derivation (`ModelPhase` in `mock/proto/ai_grid/v1/model_type.proto`):
  for a hub deployment from the `Ready` condition (True `ready`; False with a reason that does
  not recover on its own, `ConfigNotFound`, `RefsInvalid` or `GatewaysNotReady`, `failed` with
  its reason and message; False with any other reason, absent or Unknown `pending` with the
  condition's reason); for a placed model from the ManifestWorkReplicaSet conditions
  (`PlacementRolledOut` and `ManifestworkApplied` True `ready`; `ManifestworkApplied`
  False/`NotAsExpected` with a degraded or unapplied work `failed`; otherwise `pending` with the
  deciding reason). KServe reports `Ready=False` with `WaitingForGateway`, `Progressing` or
  `MinimumReplicasUnavailable` while a healthy model starts, so those read `pending`. A
  workload that never becomes available keeps `MinimumReplicasUnavailable`, which no condition
  tells apart from a slow start, so it stays `pending` with that reason, as a stuck spoke does.
- `url`, `addresses`, `conditions` and `appliedConfigs` are the hub LLMInferenceService's
  and stay empty for a placed model (`url` is then omitted, as it is for a hub model until
  KServe has written its route, about 5 s after creation, or when its Gateway does not
  exist), whose per-site state is in `rollout.works[]`:
  `applied`, `available`, `progressing`, `degraded` are the work's condition statuses
  (`True|False|Unknown`, absent until the agent writes them) and `feedback` the `ready` and
  `url` values the agent scraped from the spoke object. `workName` is `model-<name>` plus five
  random characters, no separator (the API server's `generateName` on the MWRS name, cut to 58
  characters).
- `placement.locations` are the `location` labels of the decided clusters, unique and sorted
  (proposal P8, `PlacementStatus.locations = 4`); a decided cluster without the label adds
  nothing. The console shows a model's locations from it, whatever selected the clusters.
- `rollout.summary` counts the works at the current template; the CRD's `desiredTotal` and
  `updated` are never written by OCM, so the JSON leaves them out. `maxConcurrency` applies to
  `Progressive` only (`All` and `ProgressivePerGroup` have no such field; the backend refuses
  it there).
- `displayName` and `description` are the `openshift.io/display-name` and
  `openshift.io/description` annotations; a client sets them through `annotations`, on
  create and on PATCH alike.

`POST /api/v1/models` body (the POC deploy wizard's inputs mapped to the spec,
`mock/research/models-maas.md` 7.3): `{"name", "namespace", "modelUri", "modelName",
"runtimeImage", "runtime", "replicas" | "scaling": {"minReplicas", "maxReplicas", "triggers":
[{"type", "metadata"}]}, "baseRefs": ["..."], "cpu": "8", "memory": "32Gi", "gpuCount": 1,
"env": [{"name", "value"}], "gateway": {"name", "namespace"}, "placement": {"clusterSets",
"matchLabels", "matchExpressions": [{"key", "operator", "values"}], "claimExpressions",
"tolerations": [{"key", "operator", "value", "effect", "tolerationSeconds"}],
"numberOfClusters"}, "rollout": {"strategy": "All|Progressive|ProgressivePerGroup",
"maxConcurrency", "maxFailures", "progressDeadline", "minSuccessTime"}, "labels",
"annotations"}`. `name`, `namespace` and `modelUri` are required by the backend; `cpu`, `memory`
and `gpuCount` become the main container's requests (the GPU also its limit); `scaling` becomes
a `spec.scaling.keda` block and is refused with the CRD's own messages when it comes with
`replicas`, without `maxReplicas`, without a trigger, with `maxReplicas` below 1 or a negative
`minReplicas` (`minReplicas: 0` counts as unset and defaults to 1) or with `minReplicas` above
`maxReplicas`; the gateway defaults to `openshift-ingress/openshift-ai-inference`, the route and
the scheduler are always managed; `rollout` without `placement` is 422. The display name and
description go in `annotations` (`openshift.io/display-name`, `openshift.io/description`), as on
PATCH; `displayName` and `description` are not body fields (422 unknown field). The same body
rules as the other POSTs apply (unknown fields 422, over 1 MiB 413).

`PATCH /api/v1/models/{namespace}/{name}` body, every field optional: `{"replicas", "runtimeImage",
"env": [...], "placement": {...} | null, "rollout": {...}, "labels", "annotations"}`. A present
field replaces the stored one as a whole (`env: []` removes every variable, `placement: null`
makes the model a hub deployment again, `labels` and `annotations` are whole maps) and goes into
the mask whatever the stored value; the BFF does not read the model first. `displayName` and
`description` are not body fields (422 unknown field), here as on POST: a page edits the
`openshift.io/display-name` and `openshift.io/description` keys of the `annotations` map it
loaded. A rollout is sent only when the client sends one; the backend drops the stored rollout
when the placement is removed without a new one. A body that names no field is 422, before any
call. A spec change bumps `generation`; a change of
anything but `placement` and `rollout` also rolls the Deployment out again and makes a placed
model re-apply its works, while a change of only `rollout` or `placement` re-applies none (a new
placement adds and removes the works of clusters entering and leaving the decision). An update
that leaves the spec, labels and annotations as stored is not written and keeps the
`resourceVersion`.

The list response:

```json
{"data": [...], "meta": {"size": 10, "total": 42, "offset": 0, "limit": 10}}
```

### Writes, versions and lists

Rules every handler shares; the BFF only moves them between HTTP and the RPCs, the backend
decides.

- **Request bodies must be JSON.** Every POST, PATCH and PUT whose `Content-Type` is not
  `application/json` (case-insensitive, parameters such as `charset` allowed) is 415
  `request body must be JSON: send Content-Type: application/json`, before the body is read
  and before the hub or the backend is called. A browser sends an HTML form or a `text/plain`
  `fetch` cross-site without a CORS preflight; this is what keeps another app under the
  cluster's `apps` domain from writing with an admin's session.
- **`ETag` and `If-Match`.** `GET` of one cluster, tenant or model, and the answer to its POST
  or PATCH, and `GET` of one subscription and the answer to its PUT, carry `ETag: "<resourceVersion>"` (the same value as `resourceVersion` in the
  JSON; no header when the backend reports no version, as today's backend does for tenants).
  The draft's backend must return a non-empty `resource_version` on every object it serves:
  with If-Match required, an object without one could never be updated or deleted.
  Every PATCH and DELETE must send it back as `If-Match`; the BFF passes it to the backend as
  the request's expected version and the backend refuses a stale one with `Aborted`, 409, so a
  tab opened before a colleague's change cannot overwrite or delete it:

  | Request | `If-Match` becomes |
  |---|---|
  | PATCH `/clusters/{name}` | `object.resource_version` with `lock: true` |
  | PATCH `/models/{namespace}/{name}` | `object.metadata.resource_version` with `lock: true` |
  | PATCH `/tenants/{id}` | `object.resource_version` (the draft's precondition: set means checked) |
  | DELETE `/tenants/{id}` | `DeleteTenantRequest.resource_version` |
  | DELETE `/models/{namespace}/{name}` | `DeleteModelRequest.resource_version` |
  | PUT `/subscriptions/{name}` | `object.resource_version` with `lock: true` |
  | DELETE `/subscriptions/{name}` | `DeleteSubscriptionRequest.resource_version` |

  A PATCH, PUT or DELETE without `If-Match` is 428 Precondition Required (RFC 6585) before the body
  is read and before any call: `this write needs an If-Match header: send the ETag that GET
  answered (the object's resourceVersion), for example If-Match: "42"`; `If-Match: *`, which
  names no version, is 428 too (`If-Match: * names no version: ...`). So every write carries the
  version its client read. The checks run in this order: 415 for a body that is not JSON, then
  428, then the body (422, 413). `If-Match` must be one strong entity tag exactly as `ETag` sent
  it (`"42"`); a bare value, a weak tag (`W/"42"`) or a list is 422 `If-Match must be one entity
  tag as the ETag header sent it, for example "42"` before any call. The tenant version is the
  backend's (`Tenant.resource_version`, kept in an organization attribute;
  `mock/areas/tenants.md`, "Version"), so it changes only on writes through the backend.
- **Every PATCH is one update; the backend decides what changes.** The BFF reads nothing before
  a PATCH: each field present in the body goes into the update's object and its mask, whatever
  the stored value, and the backend applies the mask under optimistic locking. A body that names
  no field is 422 `the request body names no field to change` before any call (there is nothing
  to send; answering it like the GET would skip the version check). Whether an update changes
  anything is the backend's answer: a cluster or model update that leaves the object as stored
  is not written and comes back with the stored `resourceVersion` (the Kubernetes API server
  does the same with an unchanged update), and a tenant update that changes nothing is not PUT
  to Keycloak (console proposal). The version is still checked first, so a stale `If-Match` is
  409 even when nothing would change, and a viewer's update is 403.
- **`filter` is the client's CEL.** `GET /tenants` and `GET /models` take `filter`, a CEL
  expression over `this` (the proto message, `ai_grid.v1.Tenant` or `ai_grid.v1.Model` with its
  status, fields by their proto names) and `now` (the backend's time), in cel-go's standard
  library plus its strings extension (`ext.Strings()`). The BFF puts the decoded query value in
  the request's `filter` with surrounding whitespace trimmed (an empty or whitespace-only
  `filter=` is no filter; a repeated `filter` is 422 `query parameter "filter" must be sent
  once; join the conditions with && in one expression`) and never builds, rewrites or checks it;
  the backend evaluates it over the whole list before paging, so `meta.total` counts the
  matches. The client writes it, for example:

  | The page wants | `filter` |
  |---|---|
  | tenants whose name or a domain contains `acme`, ignoring ASCII case (the client lowers the term: `lowerAscii()` folds A-Z only) | `this.name.lowerAscii().contains("acme") \|\| this.domains.exists(d, d.lowerAscii().contains("acme"))` |
  | disabled tenants | `!this.enabled` |
  | models in one namespace | `this.metadata.namespace == "ai-grid-models"` |
  | models with a label, guarded | `"ai-grid/family" in this.metadata.labels && this.metadata.labels["ai-grid/family"] == "granite"` |
  | failed models | `this.status.phase == ai_grid.v1.ModelPhase.MODEL_PHASE_FAILED` |

  Values are CEL string literals (escape `"` and `\`), and the whole expression is URL-encoded
  in the query. The field names are the proto's (`this.metadata.labels`, `this.domains`), so
  they are part of this HTTP contract: renaming a proto field breaks the filters clients have
  written. `GET /clusters` takes no `filter` yet. CEL is strict: `contains` is a literal
  substring (`%` and `_` match themselves), and indexing a missing map key is a `no such key`
  error, not false, so a label term without the `in` guard fails on the first model that lacks
  the label. A filter that does not compile, is not a bool or fails on an object is the
  backend's `InvalidArgument`, 422 with its message: `filter <f> is not a valid CEL expression:
  <cel-go's error>`, `filter <f> must evaluate to a bool, not <type>`, `filter <f> failed on
  '<id>': no such key: <key>`. The parameters earlier versions of the BFF turned into CEL
  themselves, `search` on tenants and `namespace` and `label` on models, are 422 `query
  parameter "<name>" is not supported; send a CEL filter in "filter"`, so a client written for
  them gets an error, not the unfiltered list.
- **`meta.total` and backends that do not page.** `total` is the backend's count over the whole
  filtered list. The list responses carry it as an optional field: the draft's backends always
  set it, and a backend without it (today's: its `ListTenantsRequest` is empty, so `offset`,
  `limit` and `filter` are dropped on the wire) returns every item unfiltered. When the caller
  sent a `filter`, a `limit` or an `offset` above 0 and the answer has no `total`, the BFF
  answers 501 `the AI Grid backend does not support filtering or paging tenants yet; list them
  without filter, offset or limit` (`models` for the models list) instead of showing unfiltered
  rows as the result. Without those parameters the list is the whole list and `total` falls
  back to `offset + size`; in general the BFF omits `total` (unknown) when a page without a
  count is full (`size == limit`), because more may follow. This is compatibility with the
  shipped backend, not a check of the filter: the BFF only notices the missing count.

- **Field errors.** An `InvalidArgument` answer (422) that carries `BadRequest` field violations
  also carries `error.fieldErrors`, a map from the JSON path of the request body (for example
  `domains` or `modelRefs.0.tokenRateLimits.0.window`) to the backend's message, so the form
  can show each next to its field; when a path has several violations the first wins. No other
  code carries `fieldErrors`, whatever details the backend attached.
- **Lists.** The console's pages send none of the list parameters (`offset`, `limit`,
  `filter`): Clusters, Organizations and Models fetch the whole list and filter, sort and page
  in the browser. The subscriptions list takes no query parameters.

### The BFF is thin

The BFF does transport only (the root `AGENTS.md`), and the port's handlers follow it.
**`ai-grid-backend` must therefore validate every write RPC before that RPC goes live behind
the console.** The BFF forwards what it decodes. A write RPC that does not validate stores
whatever a client sends, and the page's inline messages, which only repeat the PoC's rules
before submit, are no protection. The fake's `BadRequest` field violations are the reference
for what to check and which message to send.

### Waiting on backend RPCs

Each row is a request to the backend repository. The BFF mapping is small once the RPC
exists; the frontend uses the mock service meanwhile.

| Method | Path | Needs in the proto | Feature plan |
|---|---|---|---|
| GET | `/api/v1/user` (`isProviderAdmin`) | Optional: `AiGrid/GetCurrentUser` returning roles, once the backend acts as the caller; today the BFF asks the hub directly | Step 1 |
| GET/PATCH | `/api/v1/clusters[/{name}]` (implemented against the draft) | The backend has to ship the draft's `GetManagedCluster`, `UpdateManagedCluster` and the richer `ManagedCluster` (`mock/proto/ai_grid/v1/managed_cluster*.proto`), with `status.state` derived server-side; `patch` on managedclusters in its ClusterRole | Steps 2, 10 |
| GET/POST/PATCH/DELETE | `/api/v1/tenants[/{id}]` (implemented against the draft) | The backend has to ship the draft's `GetTenant`, `CreateTenant`, `UpdateTenant`, `DeleteTenant`, the paged `ListTenants` and the richer `Tenant` (`mock/proto/ai_grid/v1/tenant*.proto`), mapping Keycloak outcomes to the codes in `mock/research/keycloak.md` 8.2 instead of `Unknown`, and gating mutations on the provider-admin check | Step 6 |
| GET/POST/PATCH/DELETE | `/api/v1/models[/{namespace}/{name}]`, GET `/api/v1/capabilities` (implemented against the draft) | The backend has to ship the draft's `Models` service and `Model` message (`mock/proto/ai_grid/v1/model*.proto`) over LLMInferenceService, Placement and ManifestWorkReplicaSet with the status derived server-side, and `AiGrid/GetHubCapabilities`; the `ManifestWorkReplicaSet` feature gate on the hub for multi-site models (`FailedPrecondition` otherwise) | Steps 3, 4 |
| GET/POST/PUT/DELETE | `/api/v1/catalog[/{name}]` | `Catalog/*` on ConfigMaps | Step 9 |
| GET/POST/PUT/DELETE | `/api/v1/subscriptions[/{name}]`, GET `/api/v1/grid/overview` (implemented against the draft) | The backend has to ship the draft's `Subscriptions` service and `Grid/GetOverview` (`mock/proto/ai_grid/v1/subscription*.proto`, `grid_service.proto`) with the POC's metric contract (requests, errors, latency, gpu from Thanos with a `cluster` label), and validate every subscription write itself ("The BFF is thin") | Steps 5, 8, 10 |
| GET/POST/DELETE | `/api/v1/tenants/{id}/members[/{userId}]` | Member RPCs on `Tenants` (not drafted yet; `mock/research/keycloak.md` open question 3) | Step 6 |
| GET | `/api/v1/grid` | `Grid/GetNetwork` from `grid.praxis.fast/v1alpha1` once the RHOAI AI Gateway component installs the CRDs | Step 10a |

## Errors

| Situation | Status |
|---|---|
| Missing or malformed token header | 401 |
| Hub rejects the token in the access review | 401 |
| Hub unreachable or failing during the access review | 502, generic message, detail in the BFF log |
| Backend `Unauthenticated` | 401 |
| Backend `PermissionDenied` (the hub's RBAC denies the caller, e.g. a PATCH by a user who may not patch ManagedClusters) | 403, backend message kept |
| Backend `NotFound` | 404, backend message kept (`object with identifier '<name>' not found`) |
| Invalid POST, PATCH or PUT body (unknown field, wrong type, trailing content), bad `offset`/`limit` query, a removed list parameter (`search`, `namespace`, `label`), malformed `If-Match` | 422, BFF message |
| POST, PATCH or PUT body not declared `application/json` | 415, BFF message |
| PATCH, PUT or DELETE without `If-Match`, or with `If-Match: *` | 428, BFF message |
| `filter`, `limit` or `offset` against a backend whose list answer has no `total` | 501, BFF message |
| Request body over 1 MiB | 413 |
| Backend `InvalidArgument`, `OutOfRange`: Keycloak's validation messages ("Name can not be null", "Invalid domain format: x", "Cannot change the alias", "Domain x is already linked to organization y in realm ai-grid"), the API server's and the CRD's for a model (the DNS-1123 name message, the schema's "spec.replicas: Invalid value: -1: spec.replicas in body should be greater than or equal to 0" and "spec.scaling.maxReplicas: Required value", "replicas and scaling are mutually exclusive; ...", "at least one trigger is required when using direct KEDA scaling", "minReplicas cannot exceed maxReplicas"), and the backend's own checks with the console's proposed wording (URI scheme, Placement operators, rollout fields, `spec.rollout requires spec.placement`, the reserved tenant version attribute, an `ai-grid/latitude` or `ai-grid/longitude` annotation that is not a number in range, a list `filter` that does not compile, is not a bool or fails on an object) | 422, backend message kept; with `fieldErrors` for `InvalidArgument` only |
| Backend `AlreadyExists` (Keycloak: "A organization with the same name already exists.", also for a blank name on update), `Aborted` (the object is not at the `If-Match` version) | 409, backend message kept |
| Backend `FailedPrecondition` (hub feature gate missing, e.g. "ManifestWorkReplicaSet feature gate disabled on hub"; a model still referenced by a catalog entry or subscription; Keycloak realm missing or organizations disabled) | 412, backend message kept |
| Backend `ResourceExhausted` | 429 |
| Backend `Unimplemented` | 501 |
| Backend `Unavailable` (hub or Keycloak unreachable), `Canceled` | 503 |
| Backend `DeadlineExceeded` or BFF timeout (`BACKEND_TIMEOUT`, 10s) | 504 |
| Any other backend code | 502, generic message, detail in the BFF log |

## Out of scope for the BFF

- No Kubernetes client and no hub resources. The backend owns them. The one exception is
  the `SelfSubjectAccessReview` behind `isProviderAdmin`, which asks the hub about the
  caller with the caller's own token and reads nothing.
- No session handling. The proxy owns login and cookies.
- No billing data. Nothing in the platform stores it (Andrew Ballantyne, 2026-10-14) and
  whether AI Grid gets a cost or spend view is an open product question. `billingUrl` in
  `/api/v1/config` is a plain external link that stays empty until a page exists.
- No metering. Praxis AI's `external_metering` filter emits CloudEvents to a metering
  service; nothing on the dev hub receives them yet.
- No OSAC integration in this round; the backend is the OSAC-like layer.
