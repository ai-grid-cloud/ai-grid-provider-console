# Developing the console without the backend

This directory is the console's stand-in for everything that will one day come from
`ai-grid-backend` and the hub: fixtures for a fake gRPC backend, the research that says how
the real systems behave, and a plan per area for keeping the fake faithful. Nothing here is
real data. Every name, id, host and number is invented.

## Why this exists

The frontend and the BFF live in this repository. The backend is written by another team
in another repository and lands RPC by RPC. If the console only worked against a real
backend on a real hub, every page would wait for its RPC, every developer would need a
cluster, and every demo would depend on a hub being healthy.

So the console runs against a fake. The point of the fake is not convenience; it is
**faithfulness**. When the real backend arrives, the BFF mapping and the UI must need only
small changes, because the fake already produced the same field names, the same condition
and reason strings, the same error codes and the same timing the hub produces. Anything
the fake invents is a future bug, so nothing in it is invented without a source: every
behaviour comes from a CRD on the dev hub, from upstream controller source, from vendor
documentation, or from the backend's own conventions. The sources are in `research/`.

## Principles

1. **The proto is the contract.** The console imports one generated `ai_grid.v1` package,
   today built from the draft proto in `proto/` (see "The draft proto" below), and the fake
   implements the same services from the same package. One test fails when the proto gains
   a service or method the fake does not register; another fails when the draft stops being
   a superset of the backend's real proto, so the fake can never silently fall behind the
   backend and the draft can never silently diverge from it.
2. **Mirror the real objects, not the POC's inventions.** ACM `ManagedCluster`, `Placement`,
   `ManifestWorkReplicaSet`, Keycloak Organizations, KServe `LLMInferenceService`, MaaS
   `MaaSModelRef`, `MaaSSubscription`, `MaaSAuthPolicy`, Kuadrant policies and Praxis grid
   CRDs are what runs on the cluster. The fake carries their fields, phases, condition types
   and reason strings verbatim. Fields the POC invented (`revision`, `status: Saved`,
   `hasDeployment`) do not exist here.
3. **"Not implemented yet" is a normal state.** RPCs that are not agreed yet answer
   `Unimplemented`, exactly as the real server does for a stub. The BFF maps it to 501 and
   the UI shows "not available on this backend yet", so a page can ship before its RPC.
4. **Errors use the same codes the backend will use.** `NotFound`, `AlreadyExists`,
   `InvalidArgument` with the CRD's own validation message, `FailedPrecondition` when the
   hub lacks a feature gate, `Unavailable` when the hub or Keycloak is down, `Unimplemented`
   for stubs. The BFF already maps all of them to HTTP; the UI's error paths are exercised
   against the fake, not discovered in production.
5. **Time passes.** Objects do not appear Ready. They go through the same transitions the
   controllers drive, on timers the fixtures control: a cluster imports in stages, a model
   starts Pending with the real reason strings and becomes Ready, a subscription waits for
   its rate-limit policy to be enforced, a lease expires and a cluster becomes Unknown.
6. **No real data, ever.** Fixtures use `example.com`, invented UUIDs and fictional sites.
   Research notes name field paths and string constants from the real cluster, never its
   hosts, ids or people.

## How to run it

```sh
make dev-fake                              # fake backend :9090, fake hub :9091, BFF :8080, frontend :9000
AUTH_TOKEN=viewer-token make dev-fake      # as a user who is not a provider admin
AUTH_TOKEN=expired-token make dev-fake     # the signed-out path (401 from the hub)
```

No `oc login`, no cluster. `bff/cmd/fake-backend` reads `mock/fixtures` and serves:

- the `ai_grid.v1` gRPC services on `127.0.0.1:9090`, with health and reflection registered
  like the real server, a per-RPC latency, and every forwarded identity header logged;
- the one slice of the Kubernetes API the BFF itself calls, `SelfSubjectAccessReview`, on
  `127.0.0.1:9091`, answering allowed, denied or 401 by token as `fixtures/access.json` says.

`bff/internal/fakebackend` is the implementation; `bff/internal/backend/backendtest` is its
in-memory sibling for Go tests. Both will grow together as RPCs are added.

## The draft proto (`proto/`)

The backend's proto has three RPCs. The areas below need more, so the console carries a
**draft** of the next proto in `proto/ai_grid/v1/`, split by type as the style guide in
`research/backend-conventions.md` section 5 says (`ai_grid.proto`, `condition_type.proto`,
`metadata_type.proto`, `managed_cluster_type.proto`, `managed_clusters_service.proto`,
`tenant_type.proto`, `tenants_service.proto`, and the placeholder services `grid_service.proto`,
`models_service.proto`, `catalog_items_service.proto`, `subscriptions_service.proto`). It is the
console's **proposal** to the backend team, nothing more: the shapes are the ones drafted in
section 6 of that report, every file says so in its header, and the `go_package` is the
console's own (`bff/gen/ai_grid/v1`), not the backend's.

What keeps it honest:

- **The backend's three services are in it unchanged.** `AiGrid/Ping`,
  `ManagedClusters/ListManagedClusters` and `Tenants/ListTenants`, with `ManagedCluster`
  fields 1-3 and `Tenant` fields 1-3 byte-for-byte as the backend defines them. New fields
  and methods are only appended.
- **The backend's real file is vendored.** `proto/upstream/ai_grid.proto` is a copy of
  `proto/ai_grid/v1/ai_grid.proto` from the backend repository at the commit in
  `proto/upstream/COMMIT`. `hack/sync-upstream-proto.sh <ref>` refreshes both;
  `hack/dev-backend.sh` runs the backend at that commit.
- **A test proves the superset.** `bff/internal/protodrift` compiles the vendored file with
  `protocompile` and checks, against the draft's generated descriptors, that every upstream
  service, method (same input and output), message, field (same number, name, cardinality
  and type) and enum value exists. The day the backend changes its proto, the sync script
  plus this test name every difference. `TestFakeImplementsEveryProtoService` in
  `bff/internal/fakebackend` then checks the fake registers every service and method of
  the draft, the placeholders included (they answer `Unimplemented`).
- **Generated code is committed and checked.** `bff/gen/ai_grid/v1` is produced by
  `make -C bff generate` (`buf generate` with `protoc-gen-go` and `protoc-gen-go-grpc` at
  pinned versions, all run through `go run`, so nothing is installed); `make -C bff lint-proto`
  runs `buf lint` (STANDARD minus `SERVICE_SUFFIX`); `make -C bff check-generated` generates
  into a temporary directory and `diff -r`s it against `gen/`, so CI fails on a stale file,
  on a missing one and on one the proto no longer produces, not only on uncommitted edits.

When the backend ships an RPC from the draft, the console bumps the vendored copy, the drift
test confirms the shapes agree (or shows exactly where they do not), and the BFF keeps
working against the real server because the wire format is the same. When the backend has
shipped all of it, the console switches its import from `bff/gen/ai_grid/v1` back to the
backend's generated package, deletes `proto/` and `bff/gen`, and the fake stays as it is.

The Clusters area added, additively, what `research/acm.md`'s richer `ManagedCluster`
proposal needs and the fake now simulates: `taints` (with `time_added`), `generation`,
`finalizers`, `status.state_message`, and the finer `ManagedClusterState` values
(`PENDING_IMPORT`, `IMPORTING`, `IMPORT_FAILED`, `NOT_ACCEPTED`, `UNKNOWN`) with the ACM
console's derivation order documented on the enum. The flattened claim fields and the
`addon_status` map from that proposal were not added: the BFF derives them from
`cluster_claims` and the `feature.open-cluster-management.io/addon-*` labels, which the proto
already carries verbatim.

## Fixtures (`fixtures/`)

| File | Shape | Notes |
|---|---|---|
| `managedclusters.json` | `{"clusters": [ai_grid.v1.ManagedCluster...]}` in protojson | Full hub objects: labels exactly as ACM writes them (`name`, `cloud`, `vendor`, `clusterID`, `openshiftVersion*`, `clusterset=default`, `feature.open-cluster-management.io/addon-*`) plus the console's `ai-grid/*` labels and annotations, `uid`, `resourceVersion`, `creationTimestamp`, finalizers, taints, client configs, and a `status` with every condition's exact type, reason and message, name-sorted claims, capacity (`nvidia.com/gpu` on GPU clusters) and version. One cluster per state the ACM console distinguishes: `local-cluster`, `site-paris-1`, `site-frankfurt-1` ready (Paris enrolled with GPUs, Frankfurt not enrolled); `site-madrid-1` unknown (lease expired, taint `unreachable`, add-ons `unreachable`); `site-ashburn-1` offline (API server down, taint `unavailable`); `site-berlin-1` importing and `site-oslo-1` pending import (`auto-detect` labels, no claims); `site-dublin-1` import failed; `site-lisbon-1` not accepted (`hubAcceptsClient: false`, `HubClusterAdminDenied`); `edge-lyon-2` detaching (`deletionTimestamp`, `Deleting/ResourceRemaining`; the research verified that reason but not its message, which is left empty). `status.state` and `status.stateMessage` are derived by the server on every read and must not be written here. |
| `tenants.json` | `{"tenants": [ai_grid.v1.Tenant...]}` | Keycloak Organizations as the backend maps them. Replace with `{"unavailable": "..."}` to reproduce the dev hub, where the `ai-grid` realm does not exist. |
| `access.json` | who is a provider admin | Drives the fake hub's access review **and** the fake backend's answer to a mutating RPC: a token in `deniedTokens` (or any token when `defaultAllowed` is false) gets `PermissionDenied` with the API server's forbidden message from `UpdateManagedCluster`, a token in `rejectedTokens` gets `Unauthenticated` from every RPC, reads included, like an expired OpenShift token at the hub; so `AUTH_TOKEN=viewer-token` sees the clusters but cannot enrol one (the BFF answers 403 and the UI hides the actions) and `AUTH_TOKEN=expired-token` sees nothing but the signed-out path. |
| `settings.json` | latency, speed | A hub list from a pod on the hub takes tens of milliseconds. `speed` multiplies the scenario clock (`10` plays the five-minute scenario in 30 seconds; default `1`). |

Fixtures are protojson so they use the field names grpcurl shows and fail to load on any
unknown field. Tests load the shipped directory and check the ACM labels, that every
condition uses only a type, reason and message the research verified, that claims are
sorted, that hub taints match the Available condition, and that each cluster derives the
state it was seeded for.

## What the research found, in one paragraph each

The full reports are in `research/`. Read them before changing a fixture or adding a
simulated behaviour; they cite the CRD path or source file for every string.

**ACM hub** (`research/acm.md`). A `ManagedCluster`'s health is five conditions with fixed
reason strings, written by three controllers; the ACM console derives
`pendingimport | importing | importfailed | ready | offline | unknown | detaching | notaccepted`
from them, and the fake will do the same. ACM auto-labels every imported cluster; the hub
adds `unreachable`/`unavailable` taints that Placements must tolerate. Placements only see
cluster sets bound into their namespace, write `PlacementDecision`s named
`<placement>-decision-<n>` sorted by cluster name, and recompute within seconds when labels
change. `ManifestWorkReplicaSet` fans one `ManifestWork` per selected cluster with
`Applied`/`Available` and rule-driven `Progressing`/`Degraded` conditions and a summary. On
the dev hub the MWRS feature gate is off: the CRD accepts objects that nothing reconciles,
so the backend must detect that and answer `FailedPrecondition`.

**Keycloak tenants** (`research/keycloak.md`). The hub runs Keycloak 26.8 with Organizations
available but no `ai-grid` realm. The Organizations admin API lists by name with offset
paging (default page 10), returns 201 plus a `Location` header on create, replaces the whole
representation on update, enforces unique `name`, `alias` and domains with exact 409 and 400
messages, and needs `view-organizations` to return anything (`query-organizations` alone
yields an empty list). The backend today logs in as the master realm admin with a password
grant on every call and returns every failure as `Unknown`. The report proposes the
`Tenants` CRUD proto, the gRPC code for each Keycloak outcome, and the bootstrap steps for a
realm plus a scoped service-account client.

**Models, MaaS, Kuadrant, Praxis** (`research/models-maas.md`). Models are KServe
`LLMInferenceService` (v1alpha2) with Knative-style conditions; there is no phase, so
Pending/Ready/Failed is derived from `Ready`, and the reason strings on failure are known.
MaaS entitlement is a dual check: `MaaSAuthPolicy` grants access by group, `MaaSSubscription`
sets quota per model; a `MaaSModelRef` stays `Pending/NoPairingFound` until both reference
it, and each subscription materialises a Kuadrant `TokenRateLimitPolicy`. On the hub the
model MaaS serves is an `ExternalModel` pointing at the Praxis grid gateway, not a local
model. Praxis grid CRDs are documented but not installed; their phase machines are in the
report. API keys live in `maas-api`, not in a CRD. The POC stores CR-shaped JSON in Git and
does not use ConfigMaps for the catalog.

**Observability** (`research/observability.md`). The fleet Thanos behind ACM's
`rbac-query-proxy` is the right endpoint and labels every series with `cluster=<ManagedCluster
name>`. AI metrics reach it through RHOAI's OpenTelemetry collector at a 300 second cadence,
so rate windows must be 15 minutes or more. vLLM metrics with `model_name` are real and
fleet-visible today. The gateway request, error and latency metrics the POC assumed do not
exist; Istio ones are wired but empty, and GPU utilisation arrives divided by 100. No metric
carries a tenant label yet, so per-tenant usage is `unavailable` until a Kuadrant
`TelemetryPolicy` or the Praxis metering service exists. The POC's overview JSON and its
deterministic demo generator are transcribed so the fake reproduces them sample for sample.

**Backend conventions** (`research/backend-conventions.md`). The backend is a single-file
proto with three RPCs, generated code committed by hand, no interceptors and errors returned
as plain Go errors. It says it is aligned with OSAC, whose conventions are precise:
`List/Get/Create/Update/Delete`, offset and limit paging with `size` and `total`, CEL
filters, field masks with optimistic locking, `id/metadata/spec/status` objects, a shared
condition type, and a fixed gRPC error table. The report proposes a style guide that keeps
the shipped method names, drafts the next proto files in that style, and describes the
two-repository workflow: proto first with `Unimplemented` stubs, tag, console bumps, fake
implements, nightly drift build.

## Plan per area

Each area lists what the fake will simulate, what the frontend builds against it, and what
the backend has to agree to. Field names and strings are in the research; this is the order
of work.

### 1. Clusters (ACM ManagedCluster)

Implemented. Fake: `ManagedCluster` carries annotations, conditions, claims, capacity,
taints, finalizers and a derived `status.state`/`state_message` computed on every read in
the ACM console's order; the fixtures seed one cluster per state (ten clusters, every enum
value but the superseded `PENDING`); `scenarios.json` drives import (joined, imported,
add-ons), lease loss and recovery, API-server outage, detaching (with `Deleting`) and removal
against an injectable clock with a `speed` factor; `GetManagedCluster` answers `NotFound`
with the conventions' message; `UpdateManagedCluster` validates the field mask (`labels`,
`annotations`, `hub_accepts_client`), replaces maps as a whole, honours `lock` with
`Aborted`, bumps `resource_version` (and `generation` on a spec change), flips
`HubAcceptedManagedCluster` to `HubClusterAdminDenied` when acceptance is withdrawn, and
answers `PermissionDenied` for a token `access.json` denies; every RPC but `Ping` needs
`authorization` metadata (`Unauthenticated` otherwise).
BFF: `GET /api/v1/clusters/{name}` uses the Get RPC; `PATCH /api/v1/clusters/{name}` writes
labels and annotations through the Update RPC under optimistic locking; `GridCluster` exposes
`status`, `statusMessage`, `consoleUrl`, `kubernetesVersion`, `platform`, `product`,
`gpuCapacity`, `siteName`, `latitude`, `longitude`, `addons`, `conditions`, `resourceVersion`.
Frontend: status labels per state, GPU column, console link, enrol and remove per row for
provider admins only (hidden otherwise); the browser mock mirrors the fixture file and a test
keeps the two in step.
Remaining here: location and coordinate editing in the UI (the PATCH exists) and the map
(area 5). Placement recomputation and ManifestWorkReplicaSet belong to area 3.
Backend ask: ship the draft's `GetManagedCluster`, `UpdateManagedCluster` and richer
message (`proto/ai_grid/v1/managed_cluster*.proto`), with the state derived server-side.

### 2. Tenants (Keycloak Organizations)

Fake: an in-memory organization store with UUID ids, unique name and alias, alias defaulting
to name and immutable, domain validation with Keycloak's messages, full-replace update
semantics unless a field mask is given, offset paging and search, delete, and members from a
small fictional user list; error injection for a missing realm (`FailedPrecondition`) and an
unreachable Keycloak (`Unavailable`).
Frontend: tenant list with search and paging, create and edit forms whose validation errors
are the ones Keycloak would send, delete with confirmation, a members view.
Backend ask: the `Tenants` CRUD proto in `research/keycloak.md` section 8, keyed by `id`;
the gRPC code table there; a scoped service-account client instead of the master admin.

### 3. Models (LLMInferenceService, Placement, ManifestWorkReplicaSet)

Fake: `CreateModel` returns an object with no conditions, then on timers walks through the
real condition set to `Ready` or stops at a failure chosen by name or URI
(`ConfigNotFound`, `ReconcileSingleNodeWorkloadError`, `GatewaysNotReady`); multi-site models
get a Placement whose decisions are recomputed from cluster labels and taints, and an MWRS
whose per-cluster works go `Applied`, `Available`, `Progressing`, then complete, with
progressive rollout and failure injection; a capability flag reproduces the dev hub's
disabled MWRS gate with `FailedPrecondition`.
Frontend: model list and detail with per-site status from the works, create wizard with the
POC's inputs mapped to the real spec, delete blocked while a subscription references the
model.
Backend ask: the `Models` service shape in `research/models-maas.md` section 8.1, the
`Placements` and `ManifestWorkReplicaSets` messages in `research/acm.md`, and a
`GetHubCapabilities` RPC so the UI can explain a disabled gate.

### 4. Catalog and subscriptions (MaaSModelRef, MaaSSubscription, MaaSAuthPolicy)

Fake: a catalog entry starts `Pending/NoPairingFound` and becomes `Ready` only once an
`Active` subscription and an auth policy reference it, turns `Unhealthy` when its model
fails; a subscription validates the CRD rules (`tokenRateLimits` or `unlimited`, window
regex, limit range), starts `Pending`, flips to `Active` when its generated
`TokenRateLimitPolicy` is enforced, and optionally creates its `<name>-policy` auth policy
with the same description annotation the hub uses. The pairing of subscription and auth
policy is a mode switch, because the product decision on whether they are mirrored or
managed separately is still open.
Frontend: subscriptions table keyed on phase, create and edit with per-model quotas,
tenant linkage through `tokenMetadata.organizationId`, a visible consistency check between a
subscription's owners and the auth policies that cover its models.
Backend ask: the `Catalog` and `Subscriptions` services in `research/models-maas.md`
section 8.1, and a decision on the subscription and auth policy pairing.

### 5. Grid overview and monitoring (Thanos)

Fake: the POC's `GetOverview` contract with the four metric series, per-metric status
(`ok`, `no-data`, `unavailable`, `not-configured`), the deterministic demo generator ported
verbatim so browser mock and fake agree, 300 second sample cadence when emulating the fleet,
clusters that are not Ready emitting nothing, and a fake Thanos HTTP server that reproduces
the observed error cases (JSON `bad_data`, plain-text resolution error, 302 on a bad token,
warnings, more than one series). Per-model usage from the vLLM metric names that exist;
per-tenant usage `unavailable` until the platform has a tenant label.
Frontend: map and monitoring pages with a simulation banner driven by `metricsSource`, charts
that show gaps rather than zeros.
Backend ask: the `Grid` RPCs and PromQL in `research/observability.md`, the fleet endpoint
and credential choice, and the two gateway and tenant-label questions listed there.

### 6. Grid network (Praxis CRDs)

Fake: default to "CRDs not installed" with the `AIGateway` condition the hub shows; a flag
flips to a network with one local site stuck `Pending/AwaitingDiscovery`, remote sites
cycling through the documented phases, and one `InferenceProvider` per Ready model with the
values the ODH bridge writes.
Frontend: a grid topology view that renders the not-installed state as information.
Backend ask: `Grid/GetNetwork` once the CRDs ship through the AI Gateway component.

## Working in parallel with the backend team

1. **Proto first.** A new RPC starts in the console's draft (`proto/ai_grid/v1`), proposed
   to the backend as a PR that touches only its `proto/` and `gen/`; the embedded
   `Unimplemented*Server` makes it compile and answer `Unimplemented`. Both teams review the
   shape. On merge the backend tags a version.
2. **Console syncs and the fake follows.** The console runs `hack/sync-upstream-proto.sh`,
   the drift test shows where the shipped shape differs from the draft and the draft is
   reconciled, the fake gains the behaviour from the research, the BFF handler lands, the
   page switches from mock to real types. Each step is a small PR.
3. **Stubs are fine in production.** A deployed console in front of a backend that lacks an
   RPC shows "not available yet" on that page and works everywhere else.
4. **Drift is caught nightly.** `.github/workflows/drift.yaml` runs every night (and on
   demand) on a throwaway checkout: `hack/sync-upstream-proto.sh main`, then the drift test.
   Nothing is committed; a red run means the backend changed its proto, and the fix is to
   run the sync locally, reconcile the draft and commit both. CI on pull requests tests the
   draft against the vendored copy only, so a backend change that lands between syncs
   shows up in the nightly run, not in the pull request.
5. **The research is the shared source.** When the backend team implements an area, the
   report for that area is the specification both sides test against; disagreements go into
   the report's open questions and are resolved there before code.

## Open questions that affect the mock

- Subscription and auth policy: mirrored one-to-one by the provider console, or managed
  separately? The fake supports both; the UI differs.
- Which Keycloak realm holds tenants: a new `ai-grid` realm, or the organization-enabled
  realm the hub already imports?
- Will the backend act as the caller on the hub (so hub RBAC decides) or validate tokens
  and apply its own policy? This decides what `GetCurrentUser.is_provider_admin` means.
- Method naming: keep `ListManagedClusters` or move to OSAC's bare `List` while the console
  is the only consumer?
- Field masks on maps: whole-map replacement or per-key paths for a single label toggle?
- Which gateway carries AI Grid traffic, and who adds the tenant label to metrics?
- Can the MWRS feature gate be enabled on an MCE-owned `ClusterManager` without being
  reverted?

The complete lists, with context, are at the end of each report in `research/`.
