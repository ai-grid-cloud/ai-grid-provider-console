# ai-grid-provider-console

AI Grid cloud provider admin console: a React and PatternFly frontend with a thin Go BFF,
running on an ACM hub next to `ai-grid-backend`. Provider admins use it to see and enrol
clusters, deploy models across sites, manage subscriptions and tenants, and watch the fleet.

```
browser --Connect--> kube-auth-proxy + bff (relay) --> ai-grid-backend --> hub API, Keycloak, Git
```

The BFF serves the static frontend, checks who calls and relays the browser's calls (`docs/bff.md`). Every call to the cluster
goes through [ai-grid-provider-backend](https://github.com/ai-grid-cloud/ai-grid-provider-backend), which runs in
the same pod. The BFF forwards who is calling, and asks the hub one question itself with
the caller's own token: may this user `post` to `/ai-grid/provider-console`? That answer is
`isProviderAdmin`, and only a provider admin gets past `/api/v1/user` and `/api/v1/config`. The chart
ships the ClusterRole that grants it, `ai-grid-provider-admin`, bound to nobody: cluster-admins
hold it already, and everyone else needs a binding
([Provider admins](charts/ai-grid-provider-console/README.md#provider-admins)).

## Layout

| Path | What |
|---|---|
| `bff/` | Go backend-for-frontend: the relays to the backend and to the hub's Perses, `/api/v1/user` and `/api/v1/config`, health, and the built frontend |
| `bff/internal/relay` | The relay of the browser's Connect calls (`/ai_grid.v1.*`) to the backend's own RPCs, with the caller's identity |
| `frontend/` | Vite, React 19, PatternFly 6 |
| `frontend/src/gen`, `.backend-api-version` | TypeScript generated from the backend's proto (`ai_grid.v1`) at the commit in `.backend-api-version` (`make generate-api`; never edited by hand); `frontend/src/api/connect` has its transport and clients |
| `charts/ai-grid-provider-console/` | Helm chart: kube-auth-proxy, bff and ai-grid-backend in one pod, one per ACM hub |
| `manifests/` | The same pod as kustomize. Not an install path: the chart is (ai-grid-env-setup deploys it, and so does `make deploy`). `manifests/base` is kept for `hack/undeploy.sh`'s fallback, which removes a console deployed before the chart, and for the takeover test in `make chart-test`; `make chart-check` keeps it equal to the chart's defaults |
| `hack/` | `forward-backend.sh` (the hub's backend for `make dev-cluster`), `forward-perses.sh` (the hub's Perses for `make dev-cluster`), `backend-checkout.sh` (the backend at `.backend-api-version` for `make dev-fake`), `backend-fakes.sh` (the same on its fakes for the browser tests), `backend-pin.sh` (`make backend-pin`: the pin and the backend image everywhere), `hub-ca.sh`, `service-ca.sh` (the hub's service CA, for Perses), `deploy.sh`, `undeploy.sh`, `chart-takeover.sh`, `check-chart.sh`, `test-chart-kind.sh`, `api.sh` (curl as you), `smoke.sh`, `test-image-workflows.sh` (tests the PR-image workflows' delete logic) |
| `docs/dev-setup.md` | Running with or without a cluster, checks, deploying |
| `docs/connect.md` | How pages call the backend's API over Connect |
| `docs/bff.md` | What the BFF does: decisions, endpoints, the relays, errors |
| `docs/adr/`, `docs/research/` | Architecture decisions; research notes on ACM, Keycloak, MaaS, observability and the backend's conventions |
| `mock/` | Data files tests read: the BFF's own JSON as golden files, the form validation cases (`mock/README.md`) |
| `NOTICE` | Attributions for the code and screens ported from the cloud provider PoC |

## Quick start

```sh
oc login ...
make install
make dev-cluster  # the hub's deployed backend on :9090, BFF :8080, frontend :9000
```

Then open http://127.0.0.1:9000. To run your own backend instead, start it with `make run-hub` in
its repository, then run `make dev` here; without a cluster, `make dev-fake` (the real backend at
`.backend-api-version` on the fake hub and Keycloak of its repository, fetched into
`.cache/backend/`, or your checkout with `BACKEND_DIR`). See `docs/dev-setup.md` for details.

## Pages

The console has pages for clusters (`/clusters`), organizations (`/organizations`), models
(`/models`), subscriptions (`/subscriptions`), and the AI Grid map and Monitoring
(`/ai-grid`, `/monitoring`). They are ported from the cloud provider PoC; `NOTICE` lists
the attributions. On the Clusters pages, Edit changes an AI Grid cluster's location label, and
its role only while it has none; a role a cluster has, the site name and the map position aren't
edited in the console (a hub admin sets the latter two with `oc annotate`, as the backend's README
describes). Run them all without a cluster with `make dev-fake`, as `docs/dev-setup.md`
describes.

## Status

The BFF serves login, user, config and the Connect and Perses relays, with readiness tied to the
backend's gRPC health service. The Clusters, Organizations, Models and Subscriptions pages and
the AI Grid map call the backend's own API over Connect (`docs/connect.md`), and Monitoring shows
the hub's Perses dashboards; the shipped `ai-grid-backend` serves clusters (list, get, and the
update behind Add to AI Grid, Edit and Remove), tenants, the console's organizations (list, get,
create, update, delete), models and subscriptions. `/user` and `/config` work on any backend
(neither calls it). See `docs/bff.md`.
