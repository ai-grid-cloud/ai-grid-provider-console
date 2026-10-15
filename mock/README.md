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

1. **The proto is the contract.** The console imports only the backend's generated
   `ai_grid.v1` package. The fake implements the same services from the same package. A
   test fails when the pinned proto gains a service or method the fake does not register,
   so the fake can never silently fall behind the backend.
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

## Fixtures (`fixtures/`)

| File | Shape | Notes |
|---|---|---|
| `managedclusters.json` | `ai_grid.v1.ManagedCluster[]` in protojson | Labels are exactly what ACM writes on an imported cluster (`name`, `cloud`, `vendor`, `clusterID`, `openshiftVersion*`, `clusterset=default`, `feature.open-cluster-management.io/addon-*`) plus the console's `ai-grid/*` conventions. Includes the hub's own `local-cluster` and one cluster whose add-ons are `unreachable`, as an unreachable cluster looks. |
| `tenants.json` | `ai_grid.v1.Tenant[]` | Keycloak Organizations as the backend maps them. Replace with `{"unavailable": "..."}` to reproduce the dev hub, where the `ai-grid` realm does not exist. |
| `access.json` | who is a provider admin | Drives the fake hub's access review. |
| `settings.json` | latency | A hub list from a pod on the hub takes tens of milliseconds. |

Fixtures are protojson so they use the field names grpcurl shows and fail to load on any
unknown field. A test loads the shipped directory and checks the ACM labels are present.

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

Fake: grow `ManagedCluster` with annotations, conditions, claims, capacity, taints and a
derived status enum; seed clusters in every state (ready with GPUs, ready but not enrolled,
unknown with the `unreachable` taint, offline, pending import, detaching); simulate enrol
(accepted, joined, imported, add-ons appear over about a minute), lease loss and recovery,
label and annotation updates, and detach with finalizers.
Frontend: cluster status badges from the derived enum, console link from the claim, GPU
capacity, a map from the `ai-grid/*` annotations, enrol and location editing.
Backend ask: the `GetManagedCluster` and `UpdateManagedCluster` RPCs and the richer message
drafted in `research/backend-conventions.md` section 6.4, derived status computed server-side
as in `research/acm.md`.

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

1. **Proto first.** A new RPC starts as a backend PR that touches only `proto/` and `gen/`;
   the embedded `Unimplemented*Server` makes it compile and answer `Unimplemented`. Both
   teams review the shape. On merge the backend tags a version.
2. **Console bumps and the fake follows.** The console bumps the pin, the drift test fails
   until the fake registers the new service, the fake gains the behaviour from the research,
   the BFF handler lands, the page switches from mock to real types. Each step is a small
   PR.
3. **Stubs are fine in production.** A deployed console in front of a backend that lacks an
   RPC shows "not available yet" on that page and works everywhere else.
4. **Drift is caught nightly.** A scheduled build against the backend's `main` reports a
   breaking proto change the day it merges.
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
