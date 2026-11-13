# The backend's API in the console: types, calls and changes

The console uses the backend's own API, `ai_grid.v1` in ai-grid-cloud/ai-grid-provider-backend,
called from the browser over Connect with clients generated from that proto (ADRs 0001, 0002 and
0004). This page is the working guide:
how a call travels, where the types come from, how a page uses them, how to test, and what to do
when the API has to change. The backend's side of the same rules is its
`docs/API_CONTRACT.md`.

The Clusters area (the list, a cluster's page, Add, Edit and Remove), the Models area (the list, a
model's page, the Deploy model wizard, its edit and delete), the Subscriptions area, the
Organizations area and the AI grid map are on it; each move deleted that area's draft RPCs, fake
data, BFF handlers and hand-written frontend types, and the console's draft proto and fake
backend are gone. What still reads the BFF's JSON API is the shell (`/api/v1/user`,
`/api/v1/config`, the BFF's own answers), which calls no backend, and Monitoring reads the hub's
Perses; `frontend/src/api`'s hand-written layer for those two answers is what is left of the old
API.

## How a call travels

```text
page ── generated client ──► kube-auth-proxy ──► BFF relay ──► backend :9090 ──► hub
        POST /ai_grid.v1.Clusters/List      (login,      (identity,    (connect-go:
        Content-Type: application/json       401 on       gates; never  validation,
                                             --api-route) reads bodies) handlers)
```

- **The page** calls a method on a client generated from the backend's proto
  (`frontend/src/api/connect/clients.ts`) or a generated Connect Query descriptor. The request
  and the answer are typed from the same `.proto` files the backend's Go code is generated from.
- **kube-auth-proxy** signs the user in. For paths matching `--api-route=^/ai_grid\.v1\.` it
  answers an expired session with 401 instead of a login redirect, which a Connect client can't
  follow.
- **The BFF relay** (`bff/internal/relay`) checks the caller as `/api/v1` does (signed in, provider
  admin), drops every identity header the browser sent, sets the caller's token and identity the
  way the gRPC client does, and forwards the bytes unchanged. It accepts only the Connect protocol,
  bounds the wait, and passes back only the response headers a Connect client needs. It never
  decodes a body and has no per-RPC transport code. Until the backend authorizes callers,
  its procedure allowlist requires an explicit review before a new RPC is exposed. Rules and errors:
  `docs/bff.md`, "The Connect relay".
- **The backend** decodes the request into the same generated message, runs its checks and
  answers. Its REST surface (vanguard, `/api/v1/...` on the backend's own port) is for other tools;
  the console never uses it.

## Where the types come from

- `.backend-api-version` holds one full commit SHA of the backend. The console is built against
  that commit's `proto/` (package `ai_grid.v1`; `ai_grid/draft` is excluded), and deploys that
  commit's image: the chart's `images.backend`, `manifests/base` and `hack/test-chart-kind.sh` name
  `ghcr.io/ai-grid-cloud/ai-grid-provider-backend:sha-<sha>` with its digest. `make backend-pin`
  sets all of them (`hack/backend-pin.sh`).
- `make generate-api` writes `frontend/src/gen` with protoc-gen-es v2 (a pinned devDependency,
  run locally by buf through `go run`), and Connect Query descriptors, plus
  `google/rpc/error_details.proto` for field errors.
- `frontend/src/gen` is committed and never edited by hand. `make check-generated-api` regenerates
  into a temporary directory and fails CI when anything differs: stale, hand-edited, missing or
  left-over files. It also fails when one of the backend images above names another build, and
  says to run `make backend-pin SHA=<pin>`.
- Never write a TypeScript type that repeats a message the generated code already has. A page may
  have small display helpers (formatting a quantity, a label for an enum value); anything that
  decides what data means belongs in the backend (ADR-0002, and AGENTS.md "The BFF does transport
  only").

## Using it in a page

`App` wraps every page in `BackendProvider` (`frontend/src/api/connect/BackendProvider.tsx`): the
Connect transport to the console's origin, which calls the console's `checkSession` on
Unauthenticated, and a Query v5 `QueryClient`. A page needs no provider of its own; it calls the
generated Connect Query descriptors (`frontend/src/gen/ai_grid/v1/*_connectquery.ts`, one export
per RPC) with the hooks from `@connectrpc/connect-query`:

```tsx
import { createConnectQueryKey, useMutation, useQuery } from '@connectrpc/connect-query';
import { useQueryClient } from '@tanstack/react-query';
import { Clusters } from '../gen/ai_grid/v1/clusters_service_pb';
import { list, update } from '../gen/ai_grid/v1/clusters_service-Clusters_connectquery';
import { describeError } from '../api/connect/errors';

const queryClient = useQueryClient();
const clusters = useQuery(list, { limit: 50 }, { refetchInterval: 30_000 });
const save = useMutation(update, {
  // Refetch every Clusters query once the write lands.
  onSuccess: () =>
    queryClient.invalidateQueries({ queryKey: createConnectQueryKey({ schema: Clusters, cardinality: undefined }) }),
});

save.mutate({
  object: { id: c.id, metadata: { labels: next, version: c.metadata?.version } },
  updateMask: { paths: ['metadata.labels'] },
  lock: true, // the backend answers Aborted if someone changed it since c was read
});
// clusters.error and save.error are ConnectErrors: describeError(error) gives the page's state.
```

`frontend/src/api/connect/BackendProvider.test.tsx` runs this pattern against a fake. Outside a
component (a one-off call, a script), `createConsoleClients(createConsoleTransport({ checkSession }))`
gives plain typed clients.

- **Errors.** `describeError` and `toServiceError` (`errors.ts`) turn a `ConnectError` into the
  states the pages already show: NotFound, Aborted (a conflict: reload and say so),
  PermissionDenied, Unauthenticated (the session-ended flow; the transport also calls
  `checkSession`), Unimplemented (not available on this backend), and InvalidArgument with the
  field errors from `google.rpc.BadRequest`. Only request-related codes show the backend's own
  message; server-side failures show the console's generic text, as the BFF's `/api/v1` errors do.
- **Optimistic locking.** Send the version the page read, with `lock: true` where the request has
  it; a stale version answers Aborted. `Metadata.version` is `int32` at today's pin. ADR-0003
  proposes a string; use the shipped integer contract until a compatible migration is agreed.
- **Field masks.** An Update changes only the paths in `updateMask`; a map field (labels) is
  replaced whole, so send the whole map the page edited.
- **Enums.** A value the console's pin doesn't know arrives as the field's zero value
  (`..._UNSPECIFIED`). Give every `switch` over an enum a default branch that reads as "unknown";
  an exhaustive `switch` also makes `tsc` point at the code to update when a new value appears.
- **Unknown fields** in an answer from a newer backend are ignored, so the console keeps working
  until the pin moves.

### Query v5 and the Monitoring page

The console and the Perses packages share one Query v5 runtime: the `@perses-dev` packages that
use Query declare `@tanstack/react-query` `^5.105.0` as their peer, which the console's own
dependency satisfies, so `pnpm why @tanstack/react-query` finds one copy. Bump every
`@perses-dev` package together, with the `echarts` and `immer` versions their peers name.
`e2e/perses.spec.ts` renders real Perses panels; keep it passing when updating Perses, its
plugins or Query. `frontend/patches/` holds two pnpm patches: one to `@perses-dev/components`,
whose time series tooltip reads ECharts scale internals that ECharts 6.1 moved, and showed no
tooltip without it; and one to `@perses-dev/bar-chart-plugin`, which escapes the names in its
tooltip. A patch is keyed by the exact version it applies to, so moving a patched package means
renaming its patch, and checking that it still applies; `pnpm-workspace.yaml` says when to drop
each.

Navigations render as React transitions, React Router's default. On React 18 the console turned
them off (f24e1aa, `routerProps` in the `frontend/src/router.ts` this move deletes): React 18 can drop a class component's update that lands mid-render, which left
Perses's time-range menu's invisible popover blocking the page. React 19 fixed that
(facebook/react#24663), so the setting went with the move to React 19 and the Perses 0.56
prereleases, the first with React 19 support (perses/shared#390, perses/plugins#889).
`e2e/perses.spec.ts` picks a time range and clicks the page right after, on the real renderer.

The page's one Connect call is `Clusters/List`, for a dashboard's cluster details
(`docs/bff.md`, "The Perses relay"). `PersesDashboardView` makes it above Perses's own
`QueryClientProvider`, so it shares the console's cache with the Clusters pages and the map; a hook
called inside that provider would get Perses's query client instead.

### The Clusters area

- **Reads.** `useClusterList` and `useCluster` (`frontend/src/pages/clusters/useClusters.ts`) call
  `Clusters/List` and `Clusters/Get` with Connect Query, polling every 30 s as the other pages do,
  with no retries (the page offers Retry). `toClusterView` (`clusterView.ts`) is the thin selector
  layer ADR-0002 allows: the backend decides what a cluster is, and the page words it:
  `status.ai_grid_member` (membership), `status.state` and `state_message` (Ready, Unavailable for the backend's `OFFLINE`, or
  Unknown with the ACM state behind it), `status.location` (site name, coordinates, where they
  come from, what is wrong with them, the cloud region), `provisioning` `Compliant` as
  Provisioned, the `location`, `ai-grid/site`, `ai-grid/role` and `openshiftVersion` labels, the
  claims `ManagedClusterStatus.cluster_claims` names, and `capacity["nvidia.com/gpu"]` as a number.
  The GPU sections read `status.gpus` as generated. The Models and Subscriptions pages take their
  site names from the same list.
- **Status messages.** On the Clusters list, a status with a non-empty `state_message`, and every
  Unavailable status, is a compact filled label that opens a popover (`ClusterStatusLabel`),
  including Ready. The hub message renders as text; Unavailable shows a "Cannot reach API server"
  warning instead, and the cluster's page keeps the hub message in its status tooltip. Other
  statuses without a message stay noninteractive, and AI grid membership stays outline. An open
  popover follows its row as the list refreshes, preserving list controls.
- **Writes.** Add and Remove call `Clusters/Update` (in the relay's allowlist): the labels map as
  read with `ai-grid/enabled`, `ai-grid/role` and `location` set (or `ai-grid/enabled` dropped),
  `update_mask: metadata.labels`, `metadata.version` with `lock: true`. Aborted is the conflict
  the dialog already handles, and the answer's `ai_grid_member` confirms the change. The dialog
  waits for the answer and keeps every refusal; once the backend answers, the notification
  center says so and follows what the hub does next ("Writes that take long"), in place of a page
  toast of its own. The BFF has
  no `/api/v1/clusters` routes any more. Remove's dialog for an Ingress or Ingress and inference cluster says
  what happens to organizations' users (`removeText`, `clusterInfo.ts`): their requests go
  through the other ingress clusters and their API keys keep working, because the backend refuses
  a Remove that would revoke them (below). Deleting a cluster's copy of a subscription runs MaaS's
  `maas.opendatahub.io/subscription-cleanup` finalizer, which revokes the subscription's keys in
  the shared database, on every cluster; so the backend refuses while the cluster holds a copy
  Argo CD would delete, which today is while any subscription exists, and once the catalog marks
  subscriptions as kept on removal (Argo CD `Delete=false`, label `ai-grid/kept-on-removal`),
  while a copy on it isn't kept. The dialog shows a refusal in the backend's words, with the form
  kept. It also says that a kept copy still has the finalizer, so deleting the copy, uninstalling
  MaaS or deleting the copy's namespace on the removed cluster revokes the keys on every cluster.
  It gives no cleanup procedure, because no safe one is known: maas-controller puts the finalizer
  back whenever it reconciles a subscription that isn't being deleted, and taking it off triggers
  such a reconcile, so a delete after it can find the finalizer back.
- **The backend's role rules.** The pinned backend checks every `Clusters/Update`, after the
  version, and answers the first rule that refuses (its `docs/UI_API_REFERENCE.md`, "Roles"):
  InvalidArgument for an `ai-grid/role` the update sets or changes to anything but `ingress`,
  `inference` or `combined`; then, for an AI grid member whose role changes or that leaves AI
  Grid, FailedPrecondition when it stops serving ingress while any subscription exists, when it
  stops serving ingress and no other member does (the last member may leave), and when it stops
  serving inference, or leaves whatever its role, while models are placed on it; Unavailable when
  the Git catalog can't be read for those checks. A cluster joining AI grid isn't checked. So a
  cluster that is AI grid's only ingress cluster stays in it until another cluster serves ingress,
  or until it is the last member. Edit and Remove show each refusal in the dialog, in the
  backend's words, with the form kept; Unavailable reads as the console's own text.
- **Edit** (`EditClusterModal.tsx`, `gridSettings.ts`, its words in `editClusterText.ts`), for AI
  Grid clusters, in the list's row menu and the cluster page's Actions: the location label
  (checked as Add checks it), and the role only of a cluster without one (no `ai-grid/role`, or a
  value that isn't one of the three). A role a cluster has is shown read-only: changing it isn't
  supported, because the hub doesn't fully remove what the old role installed (leaving
  inference uninstalls the GPU operators, leaving ingress leaves objects behind, its database
  credentials among them, and adding ingress needs per-cluster config in Git). Add to AI grid
  shows a role the cluster kept after Remove read-only in the same way. Selecting a role
  shows, before Save, what Save sets, what the hub then installs, and that the cluster shows
  Provisioning until it finishes, in an info alert that is a live region, so a screen reader
  announces it; it only adds, so no name is typed. Save sends one `Clusters/Update` of the labels map as read with
  those keys set, `update_mask: metadata.labels`, `metadata.version` with `lock: true`; it is off
  until something changes. Aborted reloads the cluster into the dialog as Add does; any other
  refusal (InvalidArgument for a value, FailedPrecondition for a change the backend won't make)
  stays in the dialog in the backend's words, with the form kept. Only Aborted means a stale
  version on these writes: FailedPrecondition, which `ServiceError.isConflict` also counts, is a
  refusal, for Add and Remove too. The site name and map position aren't edited in the console.
- **The map** (`pages/grid/AiGridPage.tsx`) shows the members among the same list, placed where
  `status.location` says. It links a member to the models whose placement chose it by cluster
  name (`status.placement.selected_clusters` of `Models/List`), not by `locations`, the `location`
  labels that several clusters share.

- **Where a cluster is**, read-only (`pages/clusters/ClusterSite.tsx`, `site.ts`): the list's Site
  column and the cluster page show the site name, else the cloud region marked approximate, and
  a warning with the backend's `problem` when the annotations are wrong; the cluster page adds
  the region and the map position with how a hub admin sets it (`oc annotate`, the backend's
  README, "Cluster locations"; geography is read-only in the console). On the map, clusters at one position share a pin labelled "site name · cluster
  name" for each, and the list counts the members that aren't on the map, by why. "Region" is
  the cloud region only: the `ai-grid/region` label isn't read.

Still worded in the page, and backend asks if another client needs them: a provisioning enum
instead of the Policy's compliance string, and typed `openshift_version`, `console_url`,
`platform` and `product`.

### The Models area

- **Reads.** `useModelList` and `useModel` (`frontend/src/pages/models/useModels.ts`) call
  `Models/List` and `Models/Get`, polling every 30 s as the Clusters pages do, and every 10 s while
  something shown is still changing (`isUnsettled`, under **Polling**); the
  edit page loads its model once, and keeps the first answer, so an edit is checked against the
  version it started from. `toModelView` (`modelView.ts`) words the generated `Model`: the display name and
  description from the `openshift.io/display-name` and `openshift.io/description` annotations
  the backend documents; the phase from `status.phase` (`MODEL_PHASE_PARTIALLY_AVAILABLE` is
  Partially ready; `UNSPECIFIED` with reason `SavedToGit` is Saved to Git, any other
  unspecified phase Unknown); `status.message` as the status's tooltip; the page's alert
  explains `status.state` from the placed clusters' reports, each cluster that isn't Ready with its
  word and its message, and for Failed the failure KServe names in `status.reason`
  (`rolloutExplanation`), never MaaS's, which the Availability section shows;
  `status.url` as the endpoint; `status.placement.selected_clusters` (cluster names) in the
  Clusters column (no Replicas column: the model page shows it); the main container's `requests` as CPU, memory and accelerators (any request
  with a domain, such as `nvidia.com/gpu`), worded as Accelerators ("1 GPU (nvidia.com/gpu)", or
  "None (CPU only)"; `acceleratorsText` in `modelHardware.ts`), and `base_refs` as Presets. A
  model's pages never match it against the config's `models.hardware`, which can change or fail
  to load. Only its edit does (`matchingHardware`): it starts on the first entry the model runs on
  (the same accelerator and no other; for an entry without one, no accelerator and the entry's
  environment variables; never the image, and no presets, which it checks again once the user
  removes them), or on none, and then shows the model's accelerators read-only until the user
  selects one. A matched entry is only preselected: the model keeps its own image, environment
  and resources, in the quantity forms they are stored in, until the user selects another entry
  or edits them. While presets remain, the hardware can't be selected, since a preset's image and
  environment would conflict with another entry's; keeping them again after removing them puts
  the model's own hardware back, and its image unless the user typed one. An empty image is the
  cluster's default vLLM image for NVIDIA GPUs, so the wizard requires an image unless the
  hardware's accelerator (for an edit without hardware, the model's request) is `nvidia.com/gpu`,
  or the model keeps presets; an edit that keeps the model's hardware and presets requires it only
  where it would clear an image the model has. Pages are at `/models/:id` and `/models/:id/edit`.
- **Status and Availability** follow the Models design at
  `jgiardino/ai-grid-provider-console@a4e6090` (Jenn Giardino, 2026-11-02). The Models
  list's **Status** is `status.state`, Git sync and deployment in one word: Saved to Git, Syncing,
  Synced, Starting, Ready, Partially ready, Failed, Stopped (`stateWordOf`), sorted in that rollout
  order by default. Syncing, Synced and Starting share the in-progress look (blue): Synced means
  Argo CD applied the model, not that it serves, so only Ready is green. Saved to Git, Syncing and Partially ready open `ModelStatusModal`: the design's sentence
  for the Git states (its Sync now button waits until after the 11-06 freeze), or each cluster's
  status for Partially ready. **Availability** is `status.maas` (`availabilityOf`): Available;
  Pending with Awaiting subscription, Configuring route or Awaiting subscription and backend;
  Unavailable (no cluster serves it, or its deployment serves a name other than its id, while MaaS
  publishes or routes it); Failed. The label and its reason open a dialog with the design's copy, MaaS's own
  message for each ingress cluster (`status.ingress`), and a link to Subscriptions where a subscription is
  missing. For Unavailable, the dialog's body is the backend's reason, `status.maas_message`, when it sent
  one, because each ingress cluster's MaaS message may still say Available; never `status.message`, the
  phase summary, which can open with "Ready on".
- **Each cluster.** The expanded row, the Partially ready dialog and the model's page list
  `status.clusters` with Cluster (a link to the cluster), Site and Region (the cluster's
  `status.location.site_name` and `status.location.region` from `Clusters/List`, as the deploy
  wizard and the Clusters pages show them; a dash for either when it is empty, never one in place
  of the other; `clusterPlaces.ts`; when `Clusters/List` fails, `ClusterLoadNote` says so above the
  page's content, `LoadFailedAlert` before any answer and `StaleDataAlert` after one, so a dash
  doesn't read as a cluster without a site or region), Status (`clusters[].state`, opening what that cluster
  reported: its Site and Region, Git sync, deployment, their messages, the backend's per-cluster
  message) and
  View (`view_url`: OpenShift AI's model deployments, or the OpenShift console on a cluster without
  the dashboard; only an absolute https URL with a host and no user name or password renders,
  `viewHref`). While no cluster has reported, the rows are
  `status.placement.selected_clusters`, each Pending sync, opening nothing; a reported cluster
  with no state yet also reads Pending sync, and opens nothing either, as the design has it (Pending
  sync stays an outline label). Inside the Partially ready dialog, cluster statuses open nothing:
  PatternFly's dialogs don't stack. The design's progress stepper isn't here: the backend doesn't
  report the `LLMInferenceService` condition tree. The design's Location column is Site and Region
  here; the Location label stays on the Clusters pages and the map.
- **The model page** keeps its layout: the Status label, an Availability section (the label, then
  each ingress cluster, a link to it, with its Site, Region and MaaS's message) and a Clusters
  section with the same table.
- **Polling.** A model counts as still changing (`isUnsettled`) while it is Saved to Git or Unknown,
  or Pending with no cluster entry; while a placed cluster is Syncing, Synced or Starting; or while
  MaaS is still routing the model, or hasn't reported it, and a cluster serves it. Ready, Failed and
  Stopped stay so until someone acts, and a cluster drifting from Git while it serves reads Ready.
  A cluster whose Application is gone (it left AI grid after the model was placed) reads Pending
  sync for good. Fast polling is capped (`useLoadOptions`, `UNSETTLED_WINDOW_MS`): after 5 minutes
  in which the status words of what is changing stay the same (`changingOf`: the model's state and
  phase, each cluster's state, phase, sync and deployment, each ingress cluster's MaaS word; never
  a message), the page polls every 30 s again. Argo CD looks at the catalog every 3 minutes by
  default, so a model waiting for its next sync isn't slowed first, and each rollout step changes
  a word. The fast window starts again when a word changes, after a Refresh or Retry, when a write
  the console sent lands (`noteUserAction`), and when the page mounts. Every load through
  `useLoadOptions` gets the cap; only the Models list and page, the Subscriptions list and a
  subscription's page poll fast at all.
- **Where status comes from.** The pinned backend reads it from the health the hub's catalog
  Argo CD Applications record for each cluster (`acm-models-catalog-{models,ingress}-<cluster>`
  in `openshift-gitops`; the chart grants the read, `templates/rbac.yaml`). A model's phase and
  each cluster's can be Failed (an object Degraded for a reason that isn't a step still under
  way, or Argo CD's sync of it failed for good), and a cluster's reason can be Stopped (the
  model carries `serving.kserve.io/stop`). A model waiting only for a subscription is Ready (or
  Partially ready), no longer Pending. Besides the Status and Availability above, the
  notification center's watches ("Writes that take long") read each placed cluster's
  `deployment` and `deployment_message`, whether its `sync` is FAILED and its `sync_message`,
  `status.maas` and each `status.ingress` entry's failure and message.
- **Writes.** The wizard calls `Models/Create` with the id and `metadata.name`, the annotations,
  `spec.model` (the URI only: no served name, because the backend serves a model as its id, the
  name users send; the wizard starts the id from the URI's last path segment and shows it on
  Review as "Model name in requests"), `replicas`, `base_refs` always empty (preset names carry the
  OpenShift AI version, so they exist only on clusters with it), `spec.main` from the selected
  Hardware (`models.hardware` in `/api/v1/config`, the chart's `console.models.hardware`): its
  image, or none for the cluster's default vLLM image for NVIDIA GPUs (KServe's default preset),
  the requests, its accelerator as `{<accelerator>: N}`, and its environment with
  `VLLM_ADDITIONAL_ARGS` for runtime arguments) and a `name In [...]`
  placement over the clusters `Models/ListPlacementClusters` offers, and the router
  `{ scheduler: true, managedRoute: true }` (`modelRequests.ts`): the backend defaults the
  scheduler to off, and a model needs it to be routed. It sets no rollout and no limits: the
  backend's defaults apply (gateway `openshift-ingress/openshift-ai-inference`), and it saves an
  accelerator request as the limit too (`ModelContainer.requests`). An edit can change everything
  the deploy wizard sets except the id, as OpenShift AI's deployment wizard edits a deployment:
  it calls `Models/Update` with only the paths it changed, in this order: `spec.model` (the URI
  only; Review warns that users of the model get the new one under the same name),
  `spec.replicas`, `spec.base_refs` (empty once the user removes the presets; none can be added),
  `spec.main.image` (an emptied image too), `spec.main.requests` (CPU, memory and the accelerator,
  every other resource as loaded: hardware replaces only the accelerators the console knows,
  NVIDIA and AMD GPUs and those the hardware list names, so a hand-written model's `rdma/hca`
  stays; the backend moves an accelerator's limit with its request),
  `spec.main.env`, `metadata.annotations` and `spec.placement`; the requests, the env and the
  annotations whole, as loaded with the change applied, and `metadata.version` with `lock: true`.
  Selecting other hardware applies it as Deploy does: its image, its environment in place of the
  variables any entry sets, and its CPU, memory and accelerator count where the user typed none;
  selecting the model's own hardware again goes back to the model's values. The name users send
  stays read-only: the backend serves every model as its id and refuses any other
  `spec.model.name` (`normalizeServedName`), so there is no other name to set. Delete calls
  `Models/Delete` with `resource_version`, the
  version the dialog read; Aborted is the conflict the dialog already handles, and
  FailedPrecondition the backend's refusal while a subscription uses the model.
- **References.** The delete dialog lists the subscriptions that use the model with
  `Subscriptions/List` and the filter `this.spec.model_refs.exists(r, r.model_id == "<id>")`: the
  backend joins a model ref to its model (`SubscriptionModelRef.model_id`) and evaluates the
  filter after the join.
- **The map** reads the same `Models/List`: a member's models are those whose
  `status.placement.selected_clusters` name it.

### The Subscriptions area

- **Reads.** `useSubscriptionList`, `useSubscription`, `useModelsByIds` and `useTenantList`
  (`frontend/src/pages/subscriptions/useSubscriptions.ts`) call `Subscriptions/List` and `Get`,
  `Models/List` and `Tenants/List`; the lists poll every 30 s, and the subscriptions list every
  10 s while a subscription isn't Active. A subscription's page polls `Get` every 10 s while the
  subscription isn't Active or a model it names is Pending, Saved to Git or Unknown
  (`isUnsettledSubscriptionInfo`), and stops once nothing is. A state that never settles, such as
  a subscription no ingress cluster reports or a model whose placement matches no cluster, is
  polled every 10 s for 5 minutes while its words stay the same, then every 30 s (the cap under
  the Models area's **Polling**). The edit page loads `Get` once and
  keeps the first answer, so a save is checked against the version it started from. Models are read with a CEL filter on their ids,
  `this.id in ["<id>", ...]`: the list page asks for the models its subscriptions name, the edit
  page for its subscription's, and a subscription's page for none, because the backend joins the
  names it shows. The model picker reads every model when it opens, and the create page for its
  "No models available" warning.
- **Words.** `subscriptionText.ts` reads the subscription: the display name and description
  annotations (as `modelView.ts` reads a model's), `spec.organization.id`, and `status.phase`,
  Active, Pending or Degraded in git mode and none until a cluster reports, which reads Unknown,
  with the Ready condition's message in the tooltip. Degraded (a cluster reports the
  subscription or its policy failed) is a warning label, as odh-dashboard shows MaaS's Degraded:
  MaaS also calls a subscription Degraded or Failed while a model it names has no MaaSModelRef or
  route on the cluster yet, and the catalog's health check reads both as Degraded, so a
  subscription created with its model reads Degraded until the model is published. A model is
  the Models pages' `ModelView`, its phase worded there. A referenced model's status on a
  subscription's page is its `model_registrations` entry: its phase (Ready, Failed or Pending);
  Saved to Git for one with no phase and a Ready condition of reason
  `SavedToGit`, the reading `phaseWordOf` gives a model; Not found without an entry, as the
  backend's `gitModelRegistrations` says a client takes it.
- **Create-form model status.** Partially ready in the selected-model table and Add models
  picker opens the shared `ModelStatusModal` with the backend rollout report and per-cluster View
  links. The picker is suspended while status is shown, preserving its filter, sort and pending
  selections; returning restores trigger focus without confirming changes. The subscription
  draft and token limits are retained. Other statuses, missing reports, and edit/view model tables
  remain noninteractive. Browser coverage supplies a rollout report at the Models/List boundary
  because the fake hub does not report deployments of newly created models; subscription writes
  still use the real backend.
- **The model join.** A ref names its model by `SubscriptionModelRef.model_id`, which the backend
  fills (with `display_name` and `description`) for a ref to a model in its catalog; a ref it
  can't join has no model and shows its name. A model the form adds is sent as the model's id in
  `name` with no `namespace`, as the field's comment says.
- **Writes.** Create sends `id`, the annotations and the spec (bare owner groups, the
  organization, the priority, the model refs with their token limits); the backend creates the
  managed `<id>-policy` with it. Update sends the whole spec, with what the form doesn't edit
  (users, token metadata, inference priority, guardrails, a ref's billing rate and guardrails) as
  loaded, and the whole annotations map it loaded with the display name and description changed,
  because an Update replaces a map whole: mask `spec` and `metadata.annotations`,
  `metadata.version` with `lock: true`. Delete sends `resource_version`, the version read (zero
  would skip the check). Aborted is the conflict the form and the delete dialog already show.
- **Testing.** Page tests answer from `frontend/src/__tests__/connectSubscriptions.ts`, an
  in-memory Subscriptions service over the generated messages that answers as git mode does,
  joined to `connectModels.ts`'s models; the browser test (`e2e/subscriptions.spec.ts`) runs on the
  backend's fakes and commits a model of its own first (`e2e/backend.ts`). The fake hub's catalog
  Applications are static: they report subscription `team-a` and its policy active on site3 and
  no other subscription there yet (the backend's `fixtures/poc/applications.json`), so any other
  subscription reads Pending for good, and the test creates `team-a` to see the notification
  center say it is active.
- The BFF has no `/api/v1/subscriptions` or `/api/v1/models` routes and no `--models-namespace`.

### The Organizations area

- **Reads.** `useOrganizationList` and `useOrganization`
  (`frontend/src/pages/organizations/useOrganizations.ts`) call `Tenants/List` and `Tenants/Get`.
  The list polls every 30 s, as the other lists do; an organization's page and its edit page load
  `Get` once, and the edit page keeps the first answer it read after it opened, so a save is checked
  against the version the form started from (a refetch on window focus never replaces it).
  `toOrganizationView`
  (`organizationView.ts`) reads the generated `Tenant`: the name (`metadata.name`, else the id),
  `spec.domains`, `spec.identity_provider` with its OIDC config (`validate_signature` unset reads
  as on, as the field documents), `metadata.version` and `metadata.creation_timestamp`. The list
  searches, sorts and pages in the browser, as before: the backend pages `Tenants/List` but
  doesn't evaluate a filter.
- **What isn't there.** The backend's `Tenant` has no enabled flag, description, attributes or
  per-domain details, and its `TenantStatus` is empty, so the pages show no status label or
  column, no description or attributes, and no Verified label on a domain. Backend asks if a page
  needs them.
- **Writes.** Create sends `metadata.name`, `spec.domains` and, when the form has one,
  `spec.identity_provider` (`enabled: true`, the config's `client_secret_secret_name` and the
  rest as typed). On every write of an identity provider the backend reads the client secret
  from the named Secret in `AI_GRID_IDP_SECRET_NAMESPACE`, and a missing one is `NotFound`, which
  the form shows in the backend's words (`identity provider secret "<name>" not found`). A change
  also reads the stored provider's Secret, to restore that client secret if the change fails; when
  it's missing the change is FailedPrecondition, also in the backend's words, which name that
  Secret (`read Secret "<old name>", the current identity provider's client secret, ...`). Keycloak
  also reads the issuer's discovery document and the JWKS, and refuses the write when it can't
  (FailedPrecondition) or when the document names another issuer (InvalidArgument), in words
  that name the URL. An edit sends `Tenants/Update` with `metadata.version` and `lock: true`,
  never the name, which can't change, and only what changed, each in the mask and the object:
  `spec.domains` when the domains differ from those the form loaded, and
  `spec.identity_provider` when the form adds an identity provider (to an organization without
  one, validated as on create; a blank step adds none) or changes the stored one. What isn't sent
  stays as stored, so an identity provider saved before a rule the form checks still lets the
  domains save. Save changes stays disabled, and leaving asks nothing, until there is something to
  send (`isDirty`). The backend changes an identity provider in place and refuses a removal
  (InvalidArgument), so every field stays editable and nothing removes one. Keycloak links a user
  who logged in by the provider's alias and the user ID it sends, not by the issuer, so the
  backend changes the issuer only while nobody has logged in through the provider; after that, a
  new issuer is FailedPrecondition, in the backend's words, which say to remove the users' links
  to the provider in Keycloak or create a new organization. The form says the same before the
  save: on an organization with a provider, the issuer's help says it can be edited only until a
  user logs in, and names those two ways out after that, and a plain inline warning stays
  under the field while it holds an issuer other than the stored one ("A new issuer is saved only
  if no user has logged in through this identity provider"), whatever its validation. An
  organization without one gets the create form's example instead. Adding a provider to an
  organization made in Keycloak directly, with a provider of its own under the organization's
  alias, is FailedPrecondition too, in words that name the alias. An edit
  answered Unavailable (the backend couldn't read the organization back after an error) or
  DeadlineExceeded may have been saved, so the form says so and to reload before trying again
  (`ORGANIZATION_MAYBE_SAVED`): a retry after a save that landed is Aborted. When the edit sent
  another issuer than the stored one, it adds that users may already log in through the new one
  (`ORGANIZATION_ISSUER_MAYBE_SAVED`), as the backend's Unavailable message does, which the form
  never shows because it embeds raw errors. Delete sends `id`
  and `version`, the version the dialog read; after a failed delete the dialog loads the
  organization again (`Get`) before it allows a retry. Aborted, on Update or Delete, is the
  conflict the form and the dialog already show; every other refusal shows in the backend's
  words (`describeError`), and AlreadyExists (a name or domain another organization has) is no
  longer worded as a conflict. A write drops the Tenants answers no page shows, and an update
  keeps its answer as the organization's `Get`, so the page the form returns to shows the write.
- **No identity provider.** The backend reports `spec.identity_provider` only for a provider it
  created (its own organization attribute), so an organization without one has none in AI grid,
  but may have one set up in Keycloak directly, as the realm export's example organizations do.
  The pages say only what the API knows: the list's Identity provider cell says "No identity
  provider configured in AI grid" with a warning icon and, in its tooltip, that unless one was
  set up directly in Keycloak its users cannot log in, as the Clusters list shows a cluster
  without a role (`MissingLabel`); the organization page and the wizard's Review show the same
  words as the section's empty state (`SectionEmptyState`; `NO_IDENTITY_PROVIDER` and
  `NO_IDENTITY_PROVIDER_REASON` in `organizationView.ts`).
- **Field errors.** The backend sends plain messages, without `google.rpc.BadRequest` violations,
  so its refusals show above the form. A violation, should one come, lands on its field:
  `formPathOf` maps the proto path (`metadata.name`, `spec.domains[0]`,
  `spec.identity_provider.config.issuer`) to the form's.
- **Testing.** Page tests answer from `frontend/src/__tests__/connectTenants.ts`, an in-memory
  Tenants service over the generated messages with the backend's rules and messages (versions
  from 1, Aborted on a stale one, AlreadyExists, NotFound, the identity provider added or changed
  in place but never removed) and the PoC's three organizations; `tenantsOf(service).before`
  makes a call wait or fail, and throws the refusals that depend on Keycloak's state (a new issuer
  after users logged in, a provider this API didn't create, a missing Secret).
  The browser test (`e2e/organizations.spec.ts`) runs on the backend's fakes, whose Keycloak
  can't read its issuer's discovery document, so it sees an identity provider refused (in words
  that name the document) and creates the organization without one.
- The BFF has no `/api/v1/tenants` routes, and so no JSON writes at all.

### Writes that take long

The backend commits Models and Subscriptions to a Git repository: a write takes seconds, and on
a slow day longer than the BFF waits (`BACKEND_WRITE_TIMEOUT`, 30 s, `docs/bff.md`, "The
Connect relay"). So these writes (deploy, edit and delete a model; create, edit and delete a
subscription) are sent from the app root, never from the form (`frontend/src/notifications`):

- `useModelWrites` and `useSubscriptionWrites` call `submitWrite` (`useBackgroundWrites`), which
  sends the RPC with `callUnaryMethod` from `BackgroundWritesProvider`. The form waits for it
  `FORM_WAIT_MS` (3 s), with its button busy. An answer within that wait is the form's as it
  always was, whatever its code: a refusal, or the backend unreachable (Unavailable), stays on the
  form as its error, and a success leaves it, the center saying so. Refusals usually come back
  within the wait, but not always: in git mode a create's name check and an update's version check
  run after the backend reads the Git head, which can take seconds once its cache has expired.
- Past the wait the form leaves as on success, and an info toast says the change is being saved
  ("Saving model <name>"). The request keeps running; its answer becomes the outcome of that same
  entry (one drawer entry per write, unread when it arrives): the success, or the backend's
  refusal with a link back to the form. A create refused after the form left keeps what was
  submitted (the provider's drafts, per user in the tab's storage): the link (`?draft=`) reopens the
  wizard or the create form with it, on Review for a model, the refusal as the form's error and the
  resource name editable. An edit refused after the form left says the changes weren't saved, and
  its link opens the edit page on the object as it is now.
- An answer lost after the form left (`isUnknownOutcome`: DeadlineExceeded, Unavailable,
  Canceled, a failed fetch; never a 4xx or an error the backend answered itself) is not an error: the
  center reads the object back every 10 s and says it was not done after 2 minutes. A create is
  done when `Get` finds the object holding what it sent, an update when the version moved past
  the one sent and the object holds what it sent (`writeFields.ts`: a model's display name,
  source, presets, image, runtime arguments and the rest of its environment, resources, clusters
  and replicas, of an edit the ones its mask names; a subscription's names,
  groups, organization, priority and models), a delete when `Get` answers NotFound. An object
  that exists, or moved on, with other content is someone else's write as far as anyone can
  tell: a warning that the write couldn't be confirmed, with a link to the object, never a
  success. Reads that keep failing are a warning too.
- A deployed model is then watched every 20 s until it runs on every cluster it is placed on:
  each entry of `status.clusters` (one per cluster in `placement.selected_clusters`) reporting its
  deployment `RUNNING`, which that cluster's LLMInferenceService reports Ready. Then "Model <name>
  is ready on <clusters>". Neither the model's overall phase nor a cluster's is used for this:
  the overall phase also counts the ingress clusters that publish the model through MaaS, and a
  combined cluster's phase its MaaSModelRef and ExternalModel, which stay pending while MaaS sets
  up the route, and a model whose Argo CD sync reads OutOfSync while it runs. "Ready" means
  running on its clusters; users reach it through MaaS once its route is set up and a subscription
  covers it (a model waiting only for a subscription reads Ready in the backend too). A placed
  cluster whose deployment KServe reports failed (`deployment` FAILED) is an error, "Unable to
  deploy model <name>", with the cluster and KServe's message (`deployment_message`); so is a
  placed cluster whose sync Argo CD gave up on (`sync` FAILED: an admission refusal, a bad
  manifest), with the cluster and Argo CD's message (`sync_message`), as the LLMInferenceService
  never lands there and its deployment would stay Unknown. A model with no placed cluster (on the
  hub alone) is ready when its phase is Ready, and "Unable to deploy model <name>", with the
  model's `status.message`, when its phase is Failed. Otherwise the model's overall Failed isn't
  a failure: the backend also reports it when MaaS fails to publish the model on an ingress
  cluster. When every placed cluster runs the
  model but MaaS failed (`status.maas`, or a `status.ingress` entry, FAILED), the watch ends with
  a warning instead of "ready": "Model <name> is running but isn't available to users", "It runs
  on <clusters>. MaaS couldn't publish it on <ingress cluster>: <MaaS's message>. Open the model
  to check its status." MaaS still routing, or waiting for a subscription, isn't a failure. A
  model stopped on a cluster isn't running there. After 30 minutes the watch warns "Model <name>
  isn't ready yet", naming the clusters it isn't ready on; a model that is gone stops it.
- An edited model is watched the same way, every 20 s for 30 minutes, but never said to be ready:
  its status doesn't say which revision it describes, and during a rolling update the previous pod
  keeps its cluster Ready, so the previous revision's Ready would read as the edit's. It reports
  one thing, a failure it sees happen: "Unable to roll out changes to model <name>", with the
  cluster, KServe's message and a link to the model, when a placed cluster's deployment turns
  failed, or with Argo CD's message when it gives up the sync of the changes on a placed cluster
  (MaaS failing to publish the model isn't one). Its first read comes as the edit lands,
  before Argo CD can have applied it, so a deployment already failed then is the previous
  revision's failure, reported only if its status (each cluster's phase, reason and deployment,
  and whether its sync failed) changes. After 30
  minutes it ends without a word; a model that is gone stops it. Edits get a "ready" once the
  backend reports the revision its status describes.
- A created subscription is watched the same way, every 20 s for up to 30 minutes, through
  `Subscriptions/Get`, until it and its authorization policy (the managed `<id>-policy`, which
  `Get` returns as `auth_policies`) both read Active: "Subscription <name> is active", "Users in
  its groups in the <organization> organization can use its models." (the organization's name as
  the form's select showed it, left out when it didn't load). MaaS needs both: the policy gives
  the users access to the models, the subscription their quota. A subscription `Get` lists no
  policy for isn't active: the backend creates the policy with it, so none listed is a policy not
  there yet, and the watch goes on to its deadline and warns about the policy. The backend reads
  both phases from the health the catalog's Argo CD Applications
  (`acm-models-catalog-subscriptions-<cluster>`) record for each cluster (`maasPhase` and
  `withAuthPolicyStatus` in its `internal/servers/subscriptions_git.go`): Active when every
  cluster reports the object ready, Degraded when any reports it failed, Pending while any
  reports it pending or doesn't list it yet, and empty when no cluster has an Application in that
  ApplicationSet (or the backend can't list them). Degraded doesn't end the watch, and it reports
  no error before the deadline: MaaS calls a subscription Degraded or Failed while a model it
  names has no MaaSModelRef or route on the cluster yet, which the health check reads as Degraded,
  so a subscription created with its model reads Degraded until the model is published, then
  Active. `Get`'s `model_registrations` say when each model is published, but nothing says how
  long MaaS and Argo CD take to turn the subscription Active after that, so the watch doesn't end
  early on a Degraded that persists. There is no per-cluster list for a subscription. After 30
  minutes, when the last read that found a status had the subscription or its policy Degraded,
  it warns "Subscription <name> isn't active" (no "yet": a cluster reported a failure): "An
  ingress cluster reports it failed: <message>. Open the subscription to check its status and its
  models' status.", or for the policy "An ingress cluster reports its authorization policy
  failed: <message>. Open the subscription to check the policy's status." The message is the
  Ready condition's (`status.conditions` for the subscription, which git mode leaves empty, so
  the sentence ends at "failed"; the policy's says which cluster reports it how, "Failed on
  site-a; ready on site-b"). Otherwise it warns "Subscription <name> isn't active yet", saying
  whether the subscription or its policy isn't active (from the last read that found a status)
  and where to look; when its last read failed, or no read found a
  status, it says "Unable to confirm subscription <name> is active" instead, as a model's watch
  says "Unable to confirm model <name> is ready". An empty phase claims nothing. Before any status
  has been found it describes the environment (no cluster has a catalog Application for
  subscriptions, or the backend may not list the Applications: the chart's Role), not the
  subscription, so three empty reads in a row (about 40 s) stop the watch
  without a word, rather than polling Git for 30 minutes to say nothing. After a status has been
  found it means the backend couldn't read the clusters' reports this time (its `readReports`
  logs that and reports nothing), and the watch goes on. A failed read isn't an empty one: it says
  nothing about the reports, and ends a run of empty reads, so empty, failed, empty, failed,
  empty goes on to the deadline and ends in "Unable to confirm". The count is kept in the watch's
  record, so a reload goes on counting. A subscription that is gone stops it.
- An edited subscription is watched every 20 s for 30 minutes too, and never said to be active:
  the clusters' reports name objects, not versions, and the previous version stays Active while
  the new one is applied. Degraded may be a model not published yet (above), so it only has the
  pages refetch when the phase changes, and ends without a word (or after three empty phases in a
  row with no status found, as above).
- A cluster's write is a labels update the backend makes at once, so its dialog sends it itself
  and keeps every refusal (InvalidArgument and FailedPrecondition from the role rules, 403,
  Aborted) with no notification. Once the backend answers, the page hands the write to the center
  (`followWrite`), which says it was saved, as read, and follows the hub with the same records,
  storage and outcome ids as the watches above (`watchCluster`, a `cluster` record of stage
  `ready`), reading `Clusters/Get` every 30 s for up to 60 minutes (an OpenShift AI install is
  slow):
  - Add to AI grid, or an Edit that sets the role a cluster lacked: "Cluster <name> added to AI
    Grid" (or "Changes to cluster <name> saved") with "The hub is installing what its <Role> role
    needs. You'll be notified when it's provisioned.", then, once the cluster is a member whose
    `status.provisioning` is `Compliant` (what the pages show as Provisioned), "Cluster <name> is
    provisioned". That is the hub's ai-grid-ready Policy, which checks OpenShift AI and the AI
    Grid operator and never MaaS, so the body claims no more: for an Inference cluster "You can
    select it when you deploy a model" (`Models/ListPlacementClusters` offers a provisioned one),
    for an Ingress cluster "Whether users can reach models through it depends on MaaS, which the
    hub's check doesn't cover", for an Ingress and inference cluster both. After 60 minutes, "Cluster <name>
    isn't provisioned yet", or "Unable to confirm cluster <name> is provisioned" when the last
    read failed or no read found a status, with a link to the cluster. An empty `provisioning`
    (the Policy doesn't list the cluster, or can't be read) follows the subscriptions' rule: three
    in a row before any status stop the watch without a word, and a failed read ends the run.
  - Remove from AI grid: "Cluster <name> removed from AI grid", then "Cluster <name> left AI
    Grid" once the cluster is no longer a member and the ready Policy no longer lists it
    (`provisioning` empty). Membership alone wouldn't do: the backend reads `ai_grid_member` from
    the `ai-grid/enabled` label the write removed, so the write's own answer already says it,
    while the Policy lets the cluster go once the hub's placement does. After 60 minutes, "Cluster
    <name> hasn't left AI grid yet" (or "Unable to confirm ...").
  - An Edit of the location label alone: "Changes to cluster <name> saved", and no watch.
  - One watch per cluster: an Add, a role set or a Remove replaces the cluster's earlier watch; a
    location-only edit leaves it running, since it changes neither what the hub installs nor the
    name (clusters can't be renamed). A cluster that leaves AI grid during a provisioning watch,
    joins it again during a remove watch, or is gone from the hub stops the watch without a word.
  - Every status change a cluster watch sees, and every end, invalidates the Clusters queries
    (the list, a cluster's page and the AI grid map), as the model and subscription watches do.
  - On the backend's fake hub (`make dev-fake`), the ready Policy is computed from the
    clusters: one added without an `ai-grid/provisioned` fixture label reads Pending for 5 s,
    NonCompliant until 20 s, then Compliant, and one with the label keeps what it says (in the
    backend's `fixtures/poc`, `site4` reads NonCompliant for good, `site1` to `site3` Compliant).
- An organization's save is complete, or rolled back, when the backend answers (a Keycloak
  write), so it isn't watched: the form or the delete dialog waits as it always did and keeps its
  errors there, and a success goes to the center as read: "Organization <name> created",
  "Changes to organization <name> saved" (both with View organization) and "Organization <name>
  deleted", with the name the backend answered with (the dialog's for a delete).
- One watch follows a model, and one a subscription, at a time, so nothing is said twice:
  deploying or creating an id again replaces its earlier watch; an edit replaces the previous
  edit's watch. An edit made while a create's readiness watch of the object still runs adds no
  watch of its own: that one follows the same status (and, for a model, reports the same
  failures), and records the edit, whose name its outcome then uses, so a model or subscription
  renamed meanwhile is "ready" or "active" (or not, or unconfirmed) under its new name. When it
  ends on its own terms (ready or active, failed, or its warning), it goes on as the edit's
  silent watch until 30 minutes after the edit, so an edit at minute 29 is followed until minute
  59. A delete stops the object's watch at once. A model and
  a subscription with the same id are watched apart.
- The pages refetch what a watch learns at once, rather than on their own next poll: every
  query of the object's kind, Models or Subscriptions (lists and `Get`s alike, so the
  Subscriptions list and a subscription's page, which doesn't poll), when its watch sees its
  status change (a model's phase or reason, or any `status.clusters` entry; a subscription's
  phase or its policy's), and when any watch ends. A poll that sees no change refetches nothing.
- The watches and the notifications are kept in the browser tab's session storage under the
  signed-in user (`storageKeys.ts`), so a reload resumes them: a write's record is kept before its
  request goes out, and one whose answer the page no longer awaits is read back. A watch's outcome
  is in storage before its record leaves it (`notify` writes storage at once), under an id that is
  the same for every run of the watch, so a reload between the two resumes the watch, which comes
  to the same outcome and replaces the entry: never lost, never said twice. When another user
  signs in to the tab, the previous user's records stop and leave it. They belong to that tab
  only: another tab, browser or admin sees none of them.

The words name each stage as it is, since the backend only commits to Git and Argo CD applies the
change later: "Model <name> saved to Git" with "It's being deployed to <clusters>", "Changes to
model <name> saved to Git", "Model <name> deleted from Git", and for a subscription that it takes
effect once the ingress clusters apply it. A model is "ready" once it runs on every cluster it
is placed on (each cluster's deployment), and only then, unless MaaS failed to publish it, when it
"is running but isn't available to users"; a subscription is "active" once it and its
authorization policy are active on every ingress cluster, and only then. The pages raise no success notice of their own for these writes:
the center says it on both paths (`writeText.ts`).

Every toast goes through the notification center (`NotificationToasts`), a page's own success
notice (`NoticeToast`) included, and every toast is also in the drawer the masthead's bell opens (on a
phone, the user menu's Notifications item, as it offers the theme there).

## Testing

`fakeClients` (`testing.ts`) gives typed clients over an in-memory backend
(`createRouterTransport`):

```ts
const { clients } = fakeClients({
  clusters: {
    list: () => ({ items: [siteA], size: 1, total: 1 }), // checked against ClustersListResponse
    update: () => { throw new ConnectError('stale', Code.Aborted); },
  },
});
```

- A method left out answers Unimplemented, like an RPC the backend doesn't have.
- A component test wraps the page in
  `<BackendProvider transport={transport} checkSession={vi.fn()}>` with the `transport` that
  `fakeClients` returns; a test of the whole console renders `<App service={...} transport={transport} />`
  (`frontend/src/__tests__/backend-root.test.tsx`).
- Page tests render through `renderAt` or `TestApp` (`frontend/src/__tests__`), which give `App`
  a transport whose Clusters service answers from the test's `MockConsoleService`
  (`connectClusters.ts`, through `fakeClients`), and whose Models, Subscriptions and Tenants
  services are the in-memory fakes keyed by that service (`connectModels.ts`,
  `connectSubscriptions.ts`, `connectTenants.ts`). A test that needs another backend passes its own
  transport (`fakeClients({}).transport` for one without the RPCs).
- The browser tests of the Clusters, Models, Subscriptions and Organizations pages and the map
  (`e2e/cluster-membership.spec.ts`, `e2e/cluster-edit.spec.ts`, `e2e/clusters.spec.ts`,
  `e2e/grid.spec.ts`, `e2e/models.spec.ts`, `e2e/subscriptions.spec.ts`,
  `e2e/organizations.spec.ts`), and every other browser test, run against the backend's own
  fakes on its PoC fixtures, which `frontend/playwright.config.ts` starts through
  `hack/backend-fakes.sh`, on ports of their own (9200, 8280, 9290-9294), so a running
  `make dev-fake` is never taken for them.
- The fake's answers are type-checked against the generated messages and go through the same
  serialization as the wire, so a fake can't drift from the API the way the hand-written
  `MockConsoleService` could.
- For the whole stack, `make dev-fake` runs the backend at the pinned commit on its own fake
  hub and fake Keycloak (its own `make dev-fake`, checked out into `.cache/backend/<sha>`, or
  `BACKEND_DIR`), with the BFF and the frontend in front of it.

## When the page needs something the API doesn't have

1. **Change the backend first.** Add the field or RPC to `proto/ai_grid/v1` in the backend, with
   its implementation, in a backend PR that follows the backend's `docs/API_CONTRACT.md`. Don't
   compute it in the page or the BFF.
2. **Move the pin** to a backend commit that has it: `make backend-pin SHA=<full sha>` writes
   `.backend-api-version`, regenerates `frontend/src/gen` and moves the backend image of the chart,
   `manifests/base` and the kind test to that commit's build. Commit them with the page change.
   The backend's CI publishes `sha-<commit>` only for a commit on its `main`, so while the backend
   PR is open, try its head locally (`echo <sha> > .backend-api-version && make generate-api`, or
   `BACKEND_DIR` for `make dev-fake`); CI fails until the pin is a merged commit.
3. **Build the page** against the generated type; test it with `fakeClients` and try it with
   `make dev-fake`.

## When the pin moves and something breaks

Move the pin with `make backend-pin SHA=<full sha>`, never `.backend-api-version` alone: it also
moves the backend image the chart deploys. A console version ships with the backend it was built
against, because a newer backend can refuse what an older console sends. The first case is
`ModelSource.name`: backend 1141af0 accepts it only empty or as the model's id, so a console that
still sent a served name would fail every model create on that backend (the backend's
`docs/API_CONTRACT.md`, "Recorded deviations from path 1").

- **`tsc` fails:** the backend changed something a page uses. Fix the page in the same change as
  the pin bump; the pin doesn't move until it compiles and the tests pass.
- **A field is marked `@deprecated`:** the backend is retiring it (expand, migrate, contract). Move
  the page to the replacement now; the backend removes the field only after the console's pin no
  longer uses it.
- **The meaning changed but the type didn't:** no compiler can see this. The backend's contract
  rules say a changed meaning is a new field; if one slips through, raise it on the backend PR.

## Not built yet

- A nightly job that proposes moving the pin to the backend's newest `main` and runs typecheck and
  tests (the pattern OSAC uses for its UI).
- Connect GET: no backend method is marked free of side effects yet, so every call is a POST.
