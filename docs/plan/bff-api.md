# BFF plan

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
  See `mock/README.md`, "The draft proto".
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
| Response envelope | Success: `{"data": ...}`. Error: `{"error": {"code": "<http status>", "message": "..."}}`. | Same as the odh-dashboard BFFs. |
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

## Endpoints

Paths are under `/api/v1`.

### Implemented

| Method | Path | Returns | Backend RPC |
|---|---|---|---|
| GET | `/healthcheck` | `{status, version}` | none; liveness, no auth |
| GET | `/readyz` | `{status, version, backend}` | `AiGrid/Ping`; readiness, 503 when the backend does not answer |
| GET | `/api/v1/user` | `{username, email, groups, isProviderAdmin}` | none; from the proxy headers |
| GET | `/api/v1/config` | `{gridEndpoint, mapTileUrl, billingUrl, version}` | none; env `GRID_CONSUMER_URL`, `MAP_TILE_URL`, `BILLING_URL` |
| GET | `/api/v1/clusters` | `GridCluster[]` sorted by name | `ManagedClusters/ListManagedClusters` |
| GET | `/api/v1/clusters/{name}` | `GridCluster` | `ManagedClusters/GetManagedCluster`; 404 with the backend's message when absent. Against a backend without that RPC (the shipped one answers `Unimplemented`) the BFF filters `ListManagedClusters` by name instead, so the detail works either way |
| PATCH | `/api/v1/clusters/{name}` | `GridCluster` after the write | `GetManagedCluster` then `UpdateManagedCluster` with mask `labels` and/or `annotations` and `lock: true` on the fetched `resource_version`; 409 when the hub object changed in between, 422 on a bad body, 413 over 1 MiB |
| GET | `/api/v1/tenants` | `Tenant[]` sorted by name | `Tenants/ListTenants` |

`GridCluster` (fields the shipped backend does not fill are omitted or empty, so the page
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
  "addons": {"work-manager": "available", "cluster-proxy": "unreachable"},
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
  backend that sends no status at all) `status` is omitted and the UI shows a grey
  "No status". The ACM console shows `failed` for a cluster with no conditions; the console
  deliberately does not, because the same value also means "the backend did not derive one".
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
{"aiGridEnabled": true, "provisioned": false, "location": "paris", "site": "paris-dc1", "region": "europe-west",
 "siteName": "Paris DC1", "latitude": 48.8566, "longitude": 2.3522}
```

An absent field is left alone; an empty string removes that label or annotation; `null`
removes a coordinate. Latitude must be within -90..90 and longitude within -180..180, and
unknown fields are rejected (422). The body is exactly one JSON object of at most 1 MiB:
anything after the object is 422, more than 1 MiB is 413, and the body is validated in full
before the backend is called. The BFF sends the whole `labels` and `annotations` maps
back (field masks replace a map as a whole) and only the maps it changed are in the mask.

`Tenant`: `{"id": "<keycloak org id>", "name": "tenant-a", "domains": ["a.example.com"]}`.

### Waiting on backend RPCs

Each row is a request to the backend repository. The BFF mapping is small once the RPC
exists; the frontend uses the mock service meanwhile.

| Method | Path | Needs in the proto | Feature plan |
|---|---|---|---|
| GET | `/api/v1/user` (`isProviderAdmin`) | Optional: `AiGrid/GetCurrentUser` returning roles, once the backend acts as the caller; today the BFF asks the hub directly | Step 1 |
| GET/PATCH | `/api/v1/clusters[/{name}]` (implemented against the draft) | The backend has to ship the draft's `GetManagedCluster`, `UpdateManagedCluster` and the richer `ManagedCluster` (`mock/proto/ai_grid/v1/managed_cluster*.proto`), with `status.state` derived server-side; `patch` on managedclusters in its ClusterRole | Steps 2, 10 |
| GET | `/api/v1/grid/overview?range=1h|6h|24h&site=&metrics=false` | `Grid/GetOverview` with the POC's metric contract: requests, errors, latency, gpu from Thanos with a `cluster` label; `metricsSource: thanos|demo` | Steps 5, 10 |
| GET/POST/PATCH/PUT/DELETE | `/api/v1/models[/{name}]` | `Models/*` over Placement and ManifestWorkReplicaSet (feature plan 3a: `feedbackRules`, `SelectivelyOrphan`); needs the `ManifestWorkReplicaSet` feature gate on the hub | Steps 3, 4 |
| GET/POST/PUT/DELETE | `/api/v1/catalog[/{name}]` | `Catalog/*` on ConfigMaps | Step 9 |
| GET/POST/PUT/DELETE | `/api/v1/subscriptions[/{name}]` | `Subscriptions/*` over MaaSSubscription | Step 8 |
| POST/PUT/DELETE | `/api/v1/tenants[/{name}]` | `Tenants/CreateTenant`, `UpdateTenant`, `DeleteTenant` on Keycloak Organizations | Step 6 |
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
| Invalid PATCH body (unknown field, wrong type, coordinate out of range) | 422, BFF message |
| Backend `InvalidArgument`, `OutOfRange` | 422, backend message kept |
| Backend `AlreadyExists`, `Aborted` (the cluster changed between the BFF's read and write) | 409 |
| Backend `FailedPrecondition` | 412 |
| Backend `ResourceExhausted` | 429 |
| Backend `Unimplemented` | 501 |
| Backend `Unavailable`, `Canceled` | 503 |
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
