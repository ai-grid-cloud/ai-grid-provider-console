# The backend's API in the console: types, calls and changes

The console is moving from its own draft proto and hand-written JSON to the backend's own API,
`ai_grid.v1` in ai-grid-cloud/ai-grid-provider-backend, called from the browser over Connect
with clients generated from that proto (ADRs 0001, 0002 and 0004). This page is the working guide:
how a call travels, where the types come from, how a page uses them, how to test, and what to do
when the API has to change. The backend's side of the same rules is its
`docs/API_CONTRACT.md`.

The Clusters area (the list, a cluster's page, Add and Remove), the Models area (the list, a
model's page, the Deploy model wizard, its edit and delete), the Subscriptions area and the AI
Grid map are on it; Organizations moves next; each move deletes that area's draft RPCs, fake data,
BFF handlers and hand-written frontend types. When the last one moves, `mock/proto`, `bff/gen`, the
console's fake backend and `frontend/src/api`'s hand-written layer go.

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
  `docs/plan/bff-api.md`, "The Connect relay".
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
import {
  createConnectQueryKey,
  useMutation,
  useQuery,
} from "@connectrpc/connect-query";
import { useQueryClient } from "@tanstack/react-query";
import { Clusters } from "../gen/ai_grid/v1/clusters_service_pb";
import {
  list,
  update,
} from "../gen/ai_grid/v1/clusters_service-Clusters_connectquery";
import { describeError } from "../api/connect/errors";

const queryClient = useQueryClient();
const clusters = useQuery(list, { limit: 50 }, { refetchInterval: 30_000 });
const save = useMutation(update, {
  // Refetch every Clusters query once the write lands.
  onSuccess: () =>
    queryClient.invalidateQueries({
      queryKey: createConnectQueryKey({
        schema: Clusters,
        cardinality: undefined,
      }),
    }),
});

save.mutate({
  object: {
    id: c.id,
    metadata: { labels: next, version: c.metadata?.version },
  },
  updateMask: { paths: ["metadata.labels"] },
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

Query v5 is pinned for the console and Perses plugins in `pnpm-workspace.yaml`. Perses 0.54
still declares v4 support; `e2e/perses.spec.ts` verifies the actual renderer on v5. Keep that
regression passing when updating these dependencies.

### The Clusters area

- **Reads.** `useClusterList` and `useCluster` (`frontend/src/pages/clusters/useClusters.ts`) call
  `Clusters/List` and `Clusters/Get` with Connect Query, polling every 30 s as the other pages do,
  with no retries (the page offers Retry). `toClusterView` (`clusterView.ts`) is the thin selector
  layer ADR-0002 allows: the backend decides what a cluster is, and the page words it:
  `status.ai_grid_member` (membership), `status.state` and `state_message` (Ready, Offline, or
  Unknown with the ACM state behind it), `status.location` (site name, coordinates, where they
  come from, what is wrong with them, the cloud region), `provisioning` `Compliant` as
  Provisioned, the `location`, `ai-grid/site`, `ai-grid/role` and `openshiftVersion` labels, the
  claims `ManagedClusterStatus.cluster_claims` names, and `capacity["nvidia.com/gpu"]` as a number.
  The GPU sections read `status.gpus` as generated. The Models and Subscriptions pages take their
  site names from the same list.
- **Writes.** Add and Remove call `Clusters/Update` (in the relay's allowlist): the labels map as
  read with `ai-grid/enabled`, `ai-grid/role` and `location` set (or `ai-grid/enabled` dropped),
  `update_mask: metadata.labels`, `metadata.version` with `lock: true`. Aborted is the conflict
  the dialog already handles, and the answer's `ai_grid_member` confirms the change. The BFF has
  no `/api/v1/clusters` routes any more.
- **The map** (`pages/grid/AiGridPage.tsx`) shows the members among the same list, placed where
  `status.location` says; `Grid/GetOverview`, which the backend doesn't have, serves only the
  Monitoring fallback now. It links a member to the models whose placement chose it by cluster
  name (`status.placement.selected_clusters` of `Models/List`), not by `locations`, the `location`
  labels that several clusters share.

- **Where a cluster is**, read-only (`pages/clusters/ClusterSite.tsx`, `site.ts`): the list's Site
  column and the cluster page show the site name, else the cloud region marked approximate, and
  a warning with the backend's `problem` when the annotations are wrong; the cluster page adds
  the region and the map position with how a hub admin sets it (the backend's README, "Cluster
  locations"). On the map, clusters at one position share a pin labelled "site name · cluster
  name" for each, and the list counts the members that aren't on the map, by why. "Region" is
  the cloud region only: the `ai-grid/region` label isn't read.

Still worded in the page, and backend asks if another client needs them: a provisioning enum
instead of the Policy's compliance string, and typed `openshift_version`, `console_url`,
`platform` and `product`.

### The Models area

- **Reads.** `useModelList` and `useModel` (`frontend/src/pages/models/useModels.ts`) call
  `Models/List` and `Models/Get`, polling every 30 s as the Clusters pages do, and every 10 s while
  a placed model, or one of its clusters, is Pending, Saved to Git or Unknown (`isUnsettled`); the
  edit page loads its model once, and keeps the first answer, so an edit is checked against the
  version it started from. `toModelView` (`modelView.ts`) words the generated `Model`: the display name and
  description from the `openshift.io/display-name` and `openshift.io/description` annotations
  the backend documents; the phase from `status.phase` (`MODEL_PHASE_PARTIALLY_AVAILABLE` is
  Partially available; `UNSPECIFIED` with reason `SavedToGit` is Saved to Git, any other
  unspecified phase Unknown); `status.message` as the status's tooltip and the page's alert;
  `status.url` as the endpoint; `status.placement.locations` (the `location` labels) in the
  Locations column; and the main container's `requests` as CPU, memory and GPUs. Pages are at
  `/models/:id` and `/models/:id/edit`.
- **Each cluster.** The expanded row and the model's page list `status.clusters`, the backend's
  status of the model on each cluster its placement names, as it reports them: one row per
  entry, named by the cluster's location, each status opening what that cluster reported (its
  reason and message). It is the one clickable status column; a model's own status label is
  outline, its message in a tooltip. While no cluster has reported (`status.clusters` empty,
  reason `SavedToGit`), the rows are `status.placement.selected_clusters` with no Status column.
  At the pin the backend lists only placed clusters there; an ingress cluster's reports count in
  the phase and `status.message` only.
- **Writes.** The wizard calls `Models/Create` with the id and `metadata.name`, the annotations,
  `spec.model` (the URI only: no served name, because the backend serves a model as its id, the
  name tenants send; the wizard starts the id from the URI's last path segment and shows it on
  Review as "Name tenants call"), `replicas`, `base_refs` (the model server's presets), `spec.main` (the image, the
  requests it asks for and `VLLM_ADDITIONAL_ARGS` for runtime arguments) and a `name In [...]`
  placement over the clusters `Models/ListPlacementClusters` offers, and the router
  `{ scheduler: true, managedRoute: true }` (`modelRequests.ts`): the backend defaults the
  scheduler to off, and a model needs it to be routed. It sets no rollout and no limits: the
  backend's defaults apply (gateway `openshift-ingress/openshift-ai-inference`), and it saves a GPU
  request as the limit too (`ModelContainer.requests`). An edit calls `Models/Update` with only
  the paths it changed (`spec.replicas`, `spec.main.image`, `spec.main.env`,
  `metadata.annotations`, `spec.placement`; the env and the annotations whole, as loaded) and
  `metadata.version` with `lock: true`. Delete calls `Models/Delete` with `resource_version`, the
  version the dialog read; Aborted is the conflict the dialog already handles, and
  FailedPrecondition the backend's refusal while a subscription uses the model.
- **References.** The delete dialog lists the subscriptions that use the model with
  `Subscriptions/List` and the filter `this.spec.model_refs.exists(r, r.model_id == "<id>")`: the
  backend joins a model ref to its model (`SubscriptionModelRef.model_id`) and evaluates the
  filter after the join.
- **The map and Monitoring** read the same `Models/List`: a member's models are those whose
  `status.placement.selected_clusters` name it, and Monitoring's target sites the clusters at
  `status.placement.locations`.

### The Subscriptions area

- **Reads.** `useSubscriptionList`, `useSubscription`, `useModelsByIds` and `useTenantList`
  (`frontend/src/pages/subscriptions/useSubscriptions.ts`) call `Subscriptions/List` and `Get`,
  `Models/List` and `Tenants/List`; the lists poll every 30 s, and the subscriptions list every
  10 s while a subscription isn't Active. A subscription's page polls `Get` every 10 s while the
  subscription isn't Active or a model it names is Pending, Saved to Git or Unknown
  (`isUnsettledSubscriptionInfo`), and stops once nothing is. A state that never settles, such as
  a subscription no ingress cluster reports or a model whose placement matches no cluster, keeps
  its page at 10 s while it is open. The edit page loads `Get` once and
  keeps the first answer, so a save is checked against the version it started from. Models are read with a CEL filter on their ids,
  `this.id in ["<id>", ...]`: the list page asks for the models its subscriptions name, the edit
  page for its subscription's, and a subscription's page for none, because the backend joins the
  names it shows. The model picker reads every model when it opens, and the create page for its
  "No models available" warning.
- **Words.** `subscriptionText.ts` reads the subscription: the display name and description
  annotations (as `modelView.ts` reads a model's), `spec.organization.id`, and `status.phase`,
  Active or Pending in git mode and none until a cluster reports, which reads Unknown, with the
  Ready condition's message in the tooltip. A model is the Models pages' `ModelView`, its phase
  worded there. A referenced model's status on a subscription's page is its `model_registrations`
  entry: its phase; Saved to Git for one with no phase and a Ready condition of reason
  `SavedToGit`, the reading `phaseWordOf` gives a model; Not found without an entry, as the
  backend's `gitModelRegistrations` says a client takes it.
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
  backend's fakes and commits a model of its own first (`e2e/backend.ts`).
- The BFF has no `/api/v1/subscriptions` or `/api/v1/models` routes and no `--models-namespace`.

### Perses on Query v5

Every `@perses-dev` package up to 0.55.0 declares `@tanstack/react-query` `^4.39.1` as its peer;
the `overrides` entry in `frontend/pnpm-workspace.yaml` gives it the console's v5 instead, so
there is one Query runtime in the app. Perses's built code uses the object syntax v5 requires,
but three v4 names it still uses mean something else, or nothing, in v5 ([TanStack's migration
guide](https://tanstack.com/query/v5/docs/framework/react/guides/migrating-to-v5)):

- **The query summary table counts no active queries.**
  `node_modules/@perses-dev/dashboards/dist/components/QuerySummaryTable/QuerySummaryTable.js`
  counts queries whose `state.status` is `'loading'`; v5 renamed that status `'pending'`, so the
  count is always 0.
- **A panel plugin that fails to load shows a different error.**
  `node_modules/@perses-dev/dashboards/dist/components/Panel/PanelPluginLoader.js` and
  `PanelContent.js` pass `useErrorBoundary: true` to `usePlugin`, which hands it to `useQuery`;
  v5 renamed the option `throwOnError` and ignores the old name. The plugin's own load error is
  no longer thrown: the plugin is just missing, and the panel's error boundary shows "Missing
  PanelComponent from panel plugin for kind '...'" instead. A query's error is unaffected:
  `PanelContent.js` throws it itself. (`@perses-dev/plugin-system`'s `MultiQueryEditor.js` passes
  the same option, in the panel editor, which the console doesn't open.)
- **A disabled query without data is not loading.** v4's `isLoading` was `status === 'loading'`,
  true for a query that was disabled before it had data; v5's is `isPending && isFetching`, false
  for it (v4's `isInitialLoading`). Perses code that shows a skeleton on `isLoading`, such as
  `PanelContent.js` while `usePlugin` waits for a plugin kind, renders on instead.

Each one only changes what a dashboard shows in those cases. The exit: drop the override when the
`@perses-dev` packages declare Query v5 (Perses has already moved its code to the v5-compatible
syntax, perses/perses#2139). If the integration regresses before then, the fallback is a second
Query runtime for Perses alone.

The console also renders navigations without React transitions (`frontend/src/router.ts`),
because React 18 can drop an update that lands mid-render, which left Perses's time-range menu's
invisible popover blocking the page. That goes with React 19 and Perses 0.56 or later: Perses
supports React 19 from perses/shared#390 and perses/plugins#889 (merged 2026-10-28, first in
0.56.0-beta.0).

## Testing

`fakeClients` (`testing.ts`) gives typed clients over an in-memory backend
(`createRouterTransport`):

```ts
const { clients } = fakeClients({
  clusters: {
    list: () => ({ items: [siteA], size: 1, total: 1 }), // checked against ClustersListResponse
    update: () => {
      throw new ConnectError("stale", Code.Aborted);
    },
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
  (`connectClusters.ts`, through `fakeClients`). A test that needs another backend passes its own
  transport (`fakeClients({}).transport` for one without the RPCs).
- The browser tests of the Clusters pages and the map (`e2e/cluster-membership.spec.ts`,
  `e2e/clusters.spec.ts`, `e2e/grid.spec.ts`) run against the backend's own fakes on its PoC
  fixtures, which `frontend/playwright.config.ts` starts through `hack/backend-fakes.sh`, on ports
  offset from the console's own fake, which the other specs use.
- The fake's answers are type-checked against the generated messages and go through the same
  serialization as the wire, so a fake can't drift from the API the way the hand-written
  `MockConsoleService` could.
- For the whole stack, `make dev-fake-infra` runs the backend at the pinned commit on its own fake
  hub and fake Keycloak (its `make dev-fake`, checked out into `.cache/backend/<sha>`, or
  `BACKEND_DIR`), with the BFF and the frontend in front of it. `make dev-fake` (the console's own
  fake, which serves the draft) stays until the last area moves.

## When the page needs something the API doesn't have

1. **Change the backend first.** Add the field or RPC to `proto/ai_grid/v1` in the backend, with
   its implementation, in a backend PR that follows the backend's `docs/API_CONTRACT.md`. Don't add
   it to `mock/proto`, and don't compute it in the page or the BFF.
2. **Move the pin** to a backend commit that has it: `make backend-pin SHA=<full sha>` writes
   `.backend-api-version`, regenerates `frontend/src/gen` and moves the backend image of the chart,
   `manifests/base` and the kind test to that commit's build. Commit them with the page change.
   The backend's CI publishes `sha-<commit>` only for a commit on its `main`, so while the backend
   PR is open, try its head locally (`echo <sha> > .backend-api-version && make generate-api`, or
   `BACKEND_DIR` for `make dev-fake-infra`); CI fails until the pin is a merged commit.
3. **Build the page** against the generated type; test it with `fakeClients` and try it with
   `make dev-fake-infra`.

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
