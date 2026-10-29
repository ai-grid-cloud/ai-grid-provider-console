# Clusters (ACM ManagedCluster)

What the fake backend and the BFF implement for this area, where they deviate from the
real hub, which texts are the console's own, and what remains. The fixture files are
described in `mock/fixtures/README.md`, the HTTP contract in `docs/plan/bff-api.md`, the
proto in `mock/proto/README.md`. Every hub string the fake writes is a constant in
`bff/internal/fakebackend/acm.go` with the upstream source line beside it (OCM `ocm` and
`api`, stolostron `managedcluster-import-controller`, `multicloud-operators-foundation` and
`console`); the research reports in `mock/research/` are background reading.

## Implemented

Fake: `ManagedCluster` carries annotations, conditions, claims, capacity, taints, finalizers,
`generation` and a derived `status.state`/`state_message`, computed on every read in the ACM
console's order (`bff/internal/fakebackend/state.go`). `scenarios.json` drives join, import,
add-ons, lease loss and recovery, API-server outage, detaching and removal against an injectable
clock with a `speed` factor; the hub controllers' reactions are applied as each event fires
(taint controller, add-on discovery and health check, autodetect, gc controller; see
`scenarios.go`). `GetManagedCluster` answers `NotFound` with the conventions' message.
`UpdateManagedCluster` validates the field mask (`labels`, `annotations`; `hub_accepts_client`
is refused, see below), replaces maps as a whole and then puts back what the hub's webhook and
controllers own (`name`, `cluster.open-cluster-management.io/clusterset=default` when empty, the
add-on labels, `clusterID`, `openshiftVersion*`, `open-cluster-management/created-via`; a
removed `cloud` or `vendor` stays removed), honours `lock` with `Aborted`, refuses an
`ai-grid/latitude` or `ai-grid/longitude` annotation that is present, not blank and not a number
within -90..90 or -180..180 once trimmed (`InvalidArgument`, a console proposal: the backend
owns the AI Grid annotation convention, the hub accepts any string; whitespace and an empty
value pass because the BFF's read side ignores them), refuses a change to any label or
annotation outside `ai-grid/*`, `ai-grid-mock/*` and the `location` label, compared after the
hub has put back its own labels on both sides (`InvalidArgument`, a console proposal: a provider
console writes only what the POC writes, so a buggy page cannot move a site to another cluster
set or strip labels the hub does not put back), answers an update that leaves labels and
annotations as stored (after putting back what the hub owns) with the stored object, without
bumping `resource_version` or `generation`, as the API server skips an unchanged update
(`k8s.io/apiserver` v0.35.8 `pkg/storage/etcd3/store.go:553-577`; the lock, the coordinate check
and the key check run first), bumps `resource_version` on a real write, and answers
`PermissionDenied` with the API server's forbidden message for a token `access.json` denies.
Every RPC but `Ping` needs `authorization` metadata (`Unauthenticated` otherwise).

BFF: no cluster routes any more. The fake's ManagedClusters service stands in for the backend's
`Clusters` List, Get and Update (`fakebackend_test.go`, standIns), and its clusters feed the
Monitoring fallback's `GET /api/v1/grid/overview`, whose `GridCluster` exposes `status`,
`statusMessage`, `consoleUrl`, `kubernetesVersion`, `platform`, `product`, `gpuCapacity`,
`capacity`, `allocatable`, `gpus`, `creationTimestamp`, `siteName`, `latitude`, `longitude`,
`addons`, `conditions`, `resourceVersion`.

GPUs: the draft's `ManagedClusterStatus.gpus` (`ClusterGPUs`, the backend's field 10) is each
cluster's GPU inventory. The real backend reads it from ACM Search (search-v2's `search` query for
`kind=Node` with `nvidia.com/gpu.present=true`), because `ManagedClusterInfo` keeps only instance
type, region, zone and node-role labels (checked on a dev hub); the fake derives the same from
`mock/fixtures/gpunodes.json` (`bff/internal/fakebackend/gpus.go`), following the backend's
`internal/servers/cluster_gpus.go` field for field: each node from GPU Feature Discovery's labels
(`gpu.product`, `gpu.count`, `gpu.memory` MiB, `gpu.family`, `gpu.compute.major/minor`, the driver
and CUDA versions, full or from their major, minor and revision labels, `gpu.machine` or else
`node.kubernetes.io/instance-type`, `gpu.replicas` at least 1, `gpu.sharing-strategy`,
`mig.capable`, `mig.strategy`); sharing `mig` when the MIG strategy is `single` or `mixed`; a
malformed or negative count read as 0 and the total capped at the largest int32. Then the distinct
configurations (product, memory, GPUs per node and sharing, MIG capability included), most nodes
first, then by product, then most GPUs per node. A cluster without GPU nodes has no `gpus`.

UI: the Clusters pages and the map read the backend's `Clusters/List` and `Clusters/Get` over
Connect and write `Clusters/Update` (`docs/connect.md`, "The Clusters area"), with the
membership, the lifecycle state and the location the backend derives. So they run on the backend's own fakes (`make dev-fake-infra`), not on this fake, whose
draft the relay can't reach. The Clusters page (`frontend/src/pages/clusters/ClustersPage.tsx`) lists every
ManagedCluster under nested column headers that match the details page's cards: **Cluster** (name,
the hub's connection status), **AI Grid** (status, with "Not added" outside it, location, role: Ingress, the
cluster organizations' users send requests to, Inference or Combined, each with a help icon that describes it; the
`ai-grid/role` values stay `ingress`, `inference` and `combined`) and
**GPUs** (capacity, "4 nodes, 32 GPUs", or "8 GPUs" from `capacity["nvidia.com/gpu"]` read as a
plain integer, as the BFF's `gpuCapacity` reads it, when the backend has no inventory; configuration, "NVIDIA H200, 8 GPUs/node", with ", Time-sliced ×4",
", MPS ×2" or ", MIG 3g.20gb" when shared, and "+N more" for more configurations), as provider-admin
feedback asks (the OpenShift version is on the details page, to leave the list room). The actions
column sticks to the table's right edge, so a narrow window scrolls the table under it instead of
hiding it. The page adds a cluster to AI Grid or removes it, and links each name to the cluster's
details page (`ClusterDetailsPage.tsx`, `/clusters/:name`). That page shows the membership (status,
location, role, in the list's order), the cluster as the hub knows it (its connection status, the
OpenShift version when it is OpenShift, the Kubernetes version, platform, product, creation time,
console link), its capacity (with "Schedulable GPUs": the hub's `nvidia.com/gpu` as `gpuCapacity`, and the GPU Feature
Discovery count beside it when time-slicing or MPS makes them differ; "MIG slices not counted" when
a configuration's MIG strategy is `mixed`, whose slices the device plugin advertises as
`nvidia.com/mig-<profile>` instead), its GPUs (capacity, each configuration with memory and sharing, and its
node count only when the cluster mixes configurations; manufacturer, architecture, driver and CUDA)
and a table of its GPU nodes (model, GPUs, memory, architecture and compute capability, driver,
sharing, instance type, status), with the same Add and Remove actions. Add-ons and the hub's
conditions are left out: UX found them not needed there. The wording of products, memory, architecture and sharing is
presentation only (`pages/clusters/gpuText.ts`). The real backend's cluster status details (Kubernetes version, capacity, allocatable and
claims) fill the same sections; against a backend without them those parts say
so instead of showing zeros. The map (`/ai-grid`) shows the members among the same
`Clusters/List`, placed by their `ai-grid/latitude` and `ai-grid/longitude` annotations; on the
dev hub no member has them yet, so it shows no pins there. Placement recomputation and
ManifestWorkReplicaSet belong to the models area (`mock/areas/models.md`).

Backend ask: ship the draft's `GetManagedCluster`, `UpdateManagedCluster` and richer
message (`mock/proto/ai_grid/v1/managed_cluster*.proto`), with the state derived server-side.

## Fixture coverage

`mock/fixtures/managedclusters.json` holds ten clusters. They derive eight of the ten
`ManagedClusterState` values, `AVAILABLE` three times and the others once:

| State | Clusters |
|---|---|
| `AVAILABLE` | `local-cluster`, `site-paris-1`, `site-frankfurt-1` |
| `UNKNOWN` | `site-madrid-1` (lease expired) |
| `UNAVAILABLE` | `site-ashburn-1` (API server down) |
| `IMPORTING` | `site-berlin-1` |
| `PENDING_IMPORT` | `site-oslo-1` (`ManagedClusterWaitForImporting`) |
| `IMPORT_FAILED` | `site-dublin-1` |
| `NOT_ACCEPTED` | `site-lisbon-1` (denied after it had been accepted) |
| `DETACHING` | `edge-lyon-2` |

No fixture derives `UNSPECIFIED` (none has an empty condition list) or `PENDING` (never
derived). Other values seeded: add-on labels `available` (local-cluster with ten add-ons,
paris, frankfurt, ashburn, lyon), `unhealthy` (frankfurt's `application-manager`, an add-on
whose own lease stopped) and `unreachable` (madrid, lisbon); taint `unreachable` on madrid,
lisbon and the three not-joined clusters, `unavailable` on ashburn; `Deleting`
False/`ResourceRemaining` on lyon. Not seeded: `ManagedClusterForceDetaching`,
`ManagedClusterClockOutOfSync`, `HubAcceptedManagedCluster` reason `Error`, `Deleting`
`NoResource` (a `detaching` event on a cluster without add-on labels produces it) and
`DeletingError`. The region claim is present only on the AWS and Azure clusters; the
bare-metal ones omit it as the agent does when it finds none.

## Scenario

The shipped scenario (`mock/fixtures/scenarios.json`), in scenario time after the fake starts
(wall-clock time is that divided by `speed` in `mock/fixtures/settings.json`), and what each
event changes in the BFF's `GridCluster`:

| At | Cluster | Event | Visible change |
|---|---|---|---|
| 20s | `site-berlin-1` | `joined` | `status` importing to ready, `statusMessage`, three new conditions, `consoleUrl`, `kubernetesVersion`, `platform`, `product`, `gpuCapacity` 8, `openshiftVersion`, autodetect labels |
| 30s | `edge-lyon-2` | `detached` | the cluster is gone (404, absent from the list) |
| 70s | `site-berlin-1` | `imported` | only the `ManagedClusterImportSucceeded` entry of `conditions` (False/Importing to True/Imported) and `resourceVersion`; `status` is already ready |
| 90s | `site-berlin-1` | `addons-available` | `addons`: work-manager, cluster-proxy, managed-serviceaccount |
| 130s | `site-berlin-1` | `addons-available` | `addons`: the seven default add-ons |
| 300s | `site-madrid-1` | `lease-recovered` | `status` unknown to ready, `statusMessage`, add-ons `available` |

## Deviations from the real hub

- Controllers act at once: each scenario event applies the hub controllers' reactions at the
  event's time, and `UpdateManagedCluster` applies the webhook's and controllers' follow-up
  writes before it answers. On a hub the controller writes land shortly after the request, and
  a lease is declared lost from `leaseDurationSeconds`, not by a scheduled event.
- `cloud`, `vendor` and `clusterID` are written at `joined`. On a hub they follow once the
  work-manager add-on has synced ManagedClusterInfo; `openshiftVersion*` does come at join.
- `addons-available` writes `available` directly. On a hub each label first appears as
  `unreachable` when its ManagedClusterAddOn is created. `lease-recovered` sets every add-on
  label `available`; on a hub each add-on reports its own state again.
- `Deleting` counts the add-on labels as the ManagedClusterAddOns left in the cluster
  namespace and the add-ons that carried a finalizer on the dev hub (config-policy-controller,
  hypershift-addon, submariner) as "finalizer pending". The later ManifestWorks phase, the
  step-by-step finalizer removal and the namespace cleanup are not modelled; `detached`
  deletes the object at once.
- `hub_accepts_client` is not writable (no page needs it, and turning it off makes the hub
  drop a live site), so accepting and denying a cluster are not simulated; `site-lisbon-1`
  shows a cluster the hub has not accepted. The registration controller's rewrite of
  `HubAcceptedManagedCluster` was implemented before and is in this file's git history for
  when a page needs it.
- The default clusterset label is put back for every token the fake hub accepts; the real
  webhook does so only for a caller allowed to join the `default` ManagedClusterSet.
- `generation` bumps on hub taint changes, the only spec changes the fake makes, and once when
  deletion is requested (the API server's `markAsDeleting`); fixture generations follow that
  history. `resourceVersion` is a counter.
- Finalizers are static fixture data; the fake neither adds nor removes them.
- No CertificateSigningRequests, HostedClusters or ClusterDeployments: the ACM console's
  `needsapproval`, hosted-import and provisioning states are not derived.
- `filter` and `order` on `ListManagedClusters` are drafted but answer `InvalidArgument`.

## Console-invented texts

Nothing on the hub writes these; the console (fake and draft proto) does:

- `state_message` on every state. The ACM console shows a message only for importing,
  importfailed, offline and unknown; for ready, pendingimport, notaccepted and detaching the
  console's backend proposal repeats the deciding condition's message.
- `NotFound`: `object with identifier '<name>' not found` (the conventions' shape, from OSAC).
- `Aborted`: `object with identifier '<name>' has resource version <v>, the request carries "<v>"; fetch it again and retry`.
- `InvalidArgument`: `annotation "ai-grid/latitude" must be a number between -90 and 90, got
  "<v>"` and the same for `ai-grid/longitude` with -180 and 180 (a console proposal; the hub
  stores any annotation), `name is required`, `object.name is required`,
  `update_mask must name at least one of labels, annotations`,
  `update_mask path "<p>" is not supported; supported paths: labels, annotations`,
  `label "<k>" cannot be changed through the console; only ai-grid/* labels and annotations
  and the location label can` (and the same for an annotation),
  `offset must not be negative, got <n>`, `limit must not be negative, got <n>`,
  `filter is not supported by this server yet`, `order is not supported by this server yet`.
- `Unauthenticated`: `missing authorization metadata`,
  `authorization metadata must be 'Bearer <token>'`, `the hub rejected the token: Unauthorized`.
- The `PermissionDenied` text is the Kubernetes API server's forbidden message, not invented.
- The `api-down` default detail `the server is currently unable to handle the request` is
  the Kubernetes 503 text; the event can carry another code and detail.

## What remains

The UI pages for this area (owned by the UI port), the grid map, and the backend shipping
the draft RPCs. Filter and order on the list wait for the backend's choice of language.

Open question for the backend team: a cluster PATCH locks on the ManagedCluster's
`resource_version`, which the hub also moves when its registration agent and controllers write
the cluster (conditions, capacity, add-on labels). A page that waits before saving can get 409
although nobody edited the labels. The fake does not simulate background status writes, and how
often they happen on a hub has not been measured. The backend could retry once by itself when
the stored labels and annotations still equal what the client loaded, or keep the lock and let
the page reload; the console's proposal is to keep the lock until the hub shows it matters.
