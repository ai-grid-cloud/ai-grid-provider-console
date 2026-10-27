# Work breakdown

Three repositories, three owners, one contract. The backend's proto file is the contract;
`docs/plan/bff-api.md` records how each RPC appears to the browser.

```
frontend (this repo)  --JSON-->  bff (this repo)  --gRPC-->  ai-grid-provider-backend (ai-grid-cloud/ai-grid-provider-backend)
```

The foundation and the thin-BFF branches delivered: login through kube-auth-proxy, a BFF
that maps the backend's three RPCs to JSON, Clusters and Tenants pages, a single-pod
deployment with the backend container, CI, and local development against a real hub with
the backend running from a local checkout.

## Backend (ai-grid-backend)

Owner: the backend team ([ai-grid-provider-backend](https://github.com/ai-grid-cloud/ai-grid-provider-backend)). Everything that touches the hub, Keycloak or metrics.

1. Done: the backend's CI publishes `ghcr.io/ai-grid-cloud/ai-grid-provider-backend`
   (`sha-<commit>`, `latest` and `pr-<number>`, backend PR 8), and the console's chart runs it
   with its Keycloak settings in Secret `ai-grid-backend-keycloak` (`hack/deploy.sh`,
   ai-grid-env-setup's `bootstrap/60-console.sh`). Still open: a dedicated Keycloak service
   account with only the roles the Tenants RPCs need, in place of the admin login.
2. Act as the caller: build the hub client per request from the bearer token in the
   `authorization` metadata the BFF already sends, so the hub's RBAC decides what each
   user sees. Today the backend calls the hub as its own ServiceAccount, so every
   signed-in user sees everything that ServiceAccount can (review of 2026-10-15). Once
   done, the `ai-grid-provider-console-backend` ClusterRole in `manifests/` goes away, and
   Keycloak stays on a service credential used only after a provider-admin check.
3. Grow `ManagedCluster`: Available condition as `status`, the `consoleurl` claim,
   annotations (`ai-grid/site-name`, `ai-grid/latitude`, `ai-grid/longitude`).
   `UpdateManagedCluster` for enrol and location is done (`Clusters/Update`, backend PR 1,
   with the version precondition in PR 12), shipped before item 2: see item 5, "RBAC".
4. `Grid/GetOverview` with the POC's metric contract (`docs/grid-monitoring.md` in the POC):
   Thanos query_range for request rate, 5xx rate, p95 latency and GPU utilisation scoped by
   `cluster`, explicit `metricsSource: demo` when Thanos is not configured. Verify the real
   metric names Praxis and Kuadrant export before wiring queries.
5. Models over Placement and ManifestWorkReplicaSet (feature plan 3a to 3d), then
   subscriptions and catalog. Needs the `ManifestWorkReplicaSet` feature gate and a
   `ManagedClusterSetBinding` on the hub.

   RBAC: by default the backend's ServiceAccount (the chart's `templates/rbac.yaml`) can
   only `get`, `list` and `watch` ManagedClusters, so every write RPC it ships while it still
   calls the hub as itself fails with 403. Writes should land after item 2 (act as the
   caller): the hub then checks each user's own RBAC, the ServiceAccount gets no write rules
   at all, and its ClusterRole is deleted. A write that ships before item 2 needs, explicitly:
   - for `UpdateManagedCluster` (item 3), which did ship first: `patch` on `managedclusters`
     (`cluster.open-cluster-management.io`), which the chart grants with
     `backend.clusterWrites` (ai-grid-env-setup turns it on) together with an admission
     policy that limits the backend to the `ai-grid/*` and `location` labels and `ai-grid/*`
     annotations; `update` on `managedclusters/accept` only if the backend writes
     `hub_accepts_client`, which the console does not;
   - for the model writes: `get`, `list`, `watch`, `create`, `update`, `patch`, `delete` on
     `llminferenceservices` (`serving.kserve.io`), `placements`
     (`cluster.open-cluster-management.io`) and `manifestworkreplicasets`
     (`work.open-cluster-management.io`); `get`, `list`, `watch` on `placementdecisions`
     and `managedclustersetbindings` (`cluster.open-cluster-management.io`), on
     `manifestworks` (`work.open-cluster-management.io`, the per-site status in the
     cluster namespaces) and on `llminferenceserviceconfigs` (`serving.kserve.io`, the
     presets); and, if the backend creates the `ManagedClusterSetBinding` itself, `create`
     on `managedclustersetbindings` plus `create` on `managedclustersets/bind` for the
     bound set.
6. Done: tenant create, update and delete on Keycloak Organizations (`Tenants`, backend PR 3,
   with the version precondition in PR 16), which the BFF maps for the organizations page
   (console PR 42); ai-grid-env-setup's `bootstrap/35-keycloak.sh` creates the `ai-grid`
   realm on the dev hub's Keycloak (`grid-sso`).

## BFF (this repo, `bff/`)

Owner: console team. A handler per RPC, nothing else.

1. As RPCs land in the backend, sync the vendored proto (`hack/sync-upstream-proto.sh`),
   extend the BFF's copy in `mock/proto/ai_grid/backend/v1` (the drift test checks it), and map
   the rest in `internal/api`: `GetOverview` to
   `GET /grid/overview`, `GetCurrentUser` into `/user`, catalog, subscriptions. Keep the
   error table in `bff-api.md` true.
2. When the backend moves to its own Deployment: `BACKEND_ADDRESS` to its Service,
   `BACKEND_CA_FILE` to its serving CA, a NetworkPolicy, and drop the backend container and
   its ClusterRole from `manifests/`.
3. Done: ai-grid-env-setup deploys the console's Helm chart on the dev hub with Argo CD
   (`apps/console`, the chart and CI-built images pinned to console `main` at the merge of
   PR 41), with login through the Route.
4. If the auth setup changes to a Keycloak realm (open question for Lindani Phiri and
   Andrew Ballantyne), switch the proxy provider in `manifests/` and the header names in
   `config`; nothing else changes.

## Frontend (this repo, `frontend/`)

Owner: console team.

1. Port the POC pages onto PatternFly 6 against the mock service: Clusters with enrol and
   location editing, Models with the deploy wizard and per-site status, Subscriptions,
   Tenants, the AI Grid map (Leaflet, site and coordinate conventions from the POC) and
   Monitoring (Cluster, Models and Usage tabs with demo banners). Pages never call `fetch`;
   `ConsoleService` grows one method per endpoint.
2. Switch each page from the mock to the HTTP service as the BFF endpoint lands.
3. Tests with Vitest and Testing Library on the mock service; `playwright-cli` screenshots
   against the dev proxy before a PR.

## Open questions (owners outside this repo)

| Question | Who | Why it matters |
|---|---|---|
| Does the backend authorize per caller, or does everyone with console access get the pod ServiceAccount's rights? | the backend team, Lindani Phiri | Decides whether `isProviderAdmin` can mean anything and whether the BFF must restrict who reaches the backend |
| Auth setup for AI Grid: OpenShift OAuth as deployed here, or a Keycloak realm shared with tenants? | Lindani Phiri, Andrew Ballantyne | Decides the kube-auth-proxy provider; the dev hub already has Keycloak in `grid-sso` |
| Are Keycloak Organizations the tenant model, or will the tenant layer defined with Swati's team look different? | Swati's team, the backend team | The backend's `ListTenants` already assumes Organizations |
| Which Thanos (ACM observability or user-workload monitoring) and which metric names? | Kevin Howell, Praxis team | Unblocks `GetOverview` with real data; the POC's names are assumptions |
| Does the backend repository move to `osac-project`? (Its image is published to `ghcr.io/ai-grid-cloud/ai-grid-provider-backend` by its CI, backend PR 8.) | the backend team | Decides the import path the console switches to when it drops the draft proto in `mock/proto`, and where the chart's backend image comes from |
| Is there a cost or spend view for AI Grid at all? | Myriam Fentanes, Jenny Yi, Daniele Zonca | Decides whether `billingUrl` ever points anywhere |

## Shared rules

- Run `make lint test` at the root before opening a pull request; CI runs the same.
- Commits are small and describe the change; no AI attribution trailers.
- A new endpoint is a proto change first. Do not add a Kubernetes client to the BFF to
  work around a missing RPC.
