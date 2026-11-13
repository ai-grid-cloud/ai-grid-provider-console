# Development setup

Three processes: the backend ([ai-grid-provider-backend](https://github.com/ai-grid-cloud/ai-grid-provider-backend),
Connect and gRPC, talks to the hub, Keycloak and Git), the BFF (relays the browser's calls to the
backend, `docs/bff.md`) and the Vite dev server (serves the frontend, proxies `/api`,
`/ai_grid.v1.*` and `/perses/api` to the BFF). The BFF and the frontend run from this repository;
the backend runs where it lives: deployed on the hub, from its own repository in a second
terminal, or, without a cluster, fetched at `.backend-api-version` and run on its own fakes. The console runs as the user who ran `oc login`: the dev proxy
sends your name and token the way kube-auth-proxy would, and the BFF forwards them to the backend.

## Which command

| You want | Run |
|---|---|
| Fake data, the full console, no cluster | `make dev-fake` |
| The hub's deployed backend | `oc login`, then `make dev-cluster` |
| Your own backend on the hub | `oc login`; the backend repository's `make run-hub`, on any branch you have checked out; then `make dev` here |

With `make run-hub`, Organizations need `make run-hub KEYCLOAK=hub`. The last two act on a real
hub: adding or removing clusters, and organization changes, are real changes to it.

## Prerequisites

- Go 1.26 or newer, `golangci-lint`
- Node 22 and pnpm 11 (`npm install -g pnpm@11.22.0`)
- `oc`, `kustomize`, `jq`
- For the chart and the image: `helm` and `yq` (mikefarah v4) for `make chart-check`; docker or
  podman for `make image`; docker, `kind`, `kubectl` and `openssl` for `make chart-test`
- To run against a real hub or deploy (not for `make dev-fake`): `oc login` to an ACM hub. The
  BFF asks that hub whether you may `post` to `/ai-grid/provider-console` (`isProviderAdmin`),
  using your token; `oc auth can-i post /ai-grid/provider-console` answers the same. A
  cluster-admin may; anyone else needs ClusterRole `ai-grid-provider-admin`
  (`oc adm policy add-cluster-role-to-user ai-grid-provider-admin <you>`; the chart's README,
  "Provider admins").

## Run against a real hub

```sh
oc login https://api.<hub>:6443 ...
make install       # once: frontend dependencies
make dev-cluster   # the hub's backend (forwarded to :9090), its Perses (:9445), BFF on :8080, frontend on :9000
```

Open http://127.0.0.1:9000. `make dev-cluster` needs the console deployed on the hub (`make deploy`, or
[ai-grid-env-setup](https://github.com/ai-grid-cloud/ai-grid-env-setup)): it forwards the backend
container of the console's Deployment with `oc port-forward`. It finds that Deployment in any
namespace by the label the chart and `manifests/base` give it,
`app.kubernetes.io/name=ai-grid-provider-console` (`ai-grid` on a hub set up by
ai-grid-env-setup, elsewhere on others); when there is none, or more than one, it stops and lists
what it found; set `NAMESPACE` (and `DEPLOYMENT`) to choose it yourself. You see what the
deployed console shows, from the same backend build, ServiceAccount, RBAC and Keycloak. Writes are real and go through the deployed backend's ServiceAccount, so they work
exactly where the deployed console's do. On a hub set up by ai-grid-env-setup, which deploys the
chart with `backend.clusterWrites: true` (`patch` on ManagedClusters for that ServiceAccount),
Add to AI grid, Edit and Remove change the hub's clusters. With `make deploy` alone, the chart
grants only `get`, `list` and `watch` (unless `HELM_ARGS="--set backend.clusterWrites=true"`), so
they are refused (403). Organization create, update and delete go to the backend's Tenants RPCs
over Connect and change the hub's Keycloak.
Before it starts
anything, `make dev-cluster` checks your login, `pods/portforward` in the namespace, an available pod
and a free local port. The forward listens on one loopback address only, reconnects when a rollout
replaces the pod, and creates nothing on the cluster. Pages whose RPCs the backend doesn't serve
yet say "not available on this AI grid backend".

For the Monitoring page, set `PERSES_PROJECT` to the Perses project whose `dashboard-*-admin` objects are
the tabs (the relay reads only that project; without it Monitoring stays off). `make dev-cluster` then
also forwards the hub's Perses
(`openshift-cluster-observability-operator/perses`, `PERSES_NAMESPACE`, `PERSES_SERVICE`) to
`127.0.0.1:9445` (`PERSES_ADDRESS`, `hack/forward-perses.sh`) and points the BFF at it, verifying
its certificate with the hub's service CA (`hack/service-ca.sh`). That forward grants nothing:
Perses checks the token the BFF forwards, yours. When the Service is missing, your login may not
port-forward there or the CA can't be read, `make dev-cluster` says why and runs with Monitoring off
(`PERSES_CA_FILE` you set yourself is used instead of the cluster's). A `PERSES_URL` you set
yourself wins, and no forward starts.

Treat `pods/portforward` in the console's namespace as provider-admin access. Until the backend
authorizes the caller, anyone who can port-forward there reaches the backend directly, here or with
a plain `oc port-forward`, and acts with its ServiceAccount's rights: those the chart grants
(`templates/rbac.yaml`), which include `patch` on ManagedClusters when the chart value
`backend.clusterWrites` is on, as ai-grid-env-setup deploys it. The local BFF's `isProviderAdmin`
check is a convenience, not a boundary: whoever runs the forward can call the backend without it.

To run your own backend instead, on any branch you have checked out, start it with `make run-hub`
in the backend repository, then run `make dev` here:

```sh
# in ai-grid-provider-backend, after oc login
make run-hub                # gRPC on 127.0.0.1:9090, REST on 127.0.0.1:9092
make run-hub KEYCLOAK=hub   # the same, with the deployed console's Keycloak, for Organizations
# in this repository, in a second terminal
make dev
```

`make run-hub` uses your kubeconfig's current context and acts with your `oc login`'s rights, not
the deployed ServiceAccount's: adding or removing clusters, and with `KEYCLOAK=hub` organization
changes, are real. It port-forwards ACM Search for cluster GPUs and copies the deployed console's
Git and namespace settings, but not its Git token: Models and Subscriptions show the hub's
catalog, and creating or changing one fails. Without `KEYCLOAK=hub`, Organizations fail. Its
README ("Run the API locally") has the details. `BACKEND_ADDRESS` moves the address the BFF dials
in both targets (`LISTEN_ADDRESS` moves the backend's).

How the pieces connect:

1. The backend, deployed or local, listens on `127.0.0.1:9090` (`BACKEND_ADDRESS`).
2. The BFF listens on `127.0.0.1:8080`, dials `BACKEND_ADDRESS` (plaintext) and forwards the
   caller's token as `authorization` metadata (`bff/internal/backend`). For `/api/v1/user` it posts
   a `SelfSubjectAccessReview` to `HUB_API_URL` with the caller's token (`bff/internal/hub`);
   `make dev-cluster` and `make dev` set it from `oc whoami --show-server`, and `HUB_CA_FILE` from the kubeconfig's
   cluster CA (`hack/hub-ca.sh`). A login made with `--insecure-skip-tls-verify` stores no CA, so
   then the CA comes from the cluster's `kube-root-ca.crt` ConfigMap. Plaintext `http://` is
   accepted for loopback only.
3. The Vite dev server proxies `/api` to the BFF and sets `x-forwarded-access-token` and
   `x-forwarded-user` from `oc whoami` (`frontend/vite.config.ts`). After a 401 they are
   re-read, so a new `oc login` is picked up without restarting. `AUTH_GROUPS` adds a
   groups header, which the BFF only forwards to the backend.

Without the frontend, run two of the pieces (below, "Run the pieces separately"):

```sh
make dev-forward-backend   # or your own backend on :9090
make dev-bff
hack/api.sh /api/v1/user
hack/api.sh -X POST -H 'Connect-Protocol-Version: 1' -d '{}' /ai_grid.v1.Tenants/List
curl -s http://127.0.0.1:8080/readyz
```

`hack/smoke.sh` builds the BFF, starts it on a spare port against the backend on :9090 and
checks the read-only endpoints and lists clusters and organizations through the relay.

## Run without a cluster

```sh
make install     # once: frontend dependencies
make dev-fake    # the backend at .backend-api-version on its fake hub and Keycloak, BFF :8080, frontend :9000
```

No `oc login` is needed. Open http://127.0.0.1:9000. You're signed in as `dev-user`, a provider
admin; set `AUTH_TOKEN=viewer-token AUTH_USER=viewer` to see the console as a user who isn't one,
and `AUTH_TOKEN=expired-token` for a token the hub rejects.

This runs the real `ai-grid-provider-backend`, at the commit in `.backend-api-version`, on the
fake hub and Keycloak of its own repository (its `make dev-fake`: gRPC, Connect and gRPC-Web on
:9090, the fake hub on :9091, REST on :9092, Keycloak on :9093, its draft fake on :9094), the BFF
against it with `FAKE_BACKEND=true` (the console shows a fake-backend banner, and since no login
proxy runs, an ended session stays on the page instead of going to sign in), and the frontend as
`dev-user` with `dev-token`. The backend's fixtures (its `fixtures/default`) seed the clusters and
organizations; Models and Subscriptions are commits to a local Git catalog
(`bin/dev-catalog.git` in the backend's checkout), empty until you deploy a model. Monitoring
needs a Perses (`make dev-cluster`), so it isn't available here. The browser tests run the same
backend on its PoC fixtures, on ports of their own (`frontend/playwright.config.ts` starts it
through `hack/backend-fakes.sh`).
The Vite dev server forwards `/ai_grid.v1.*` to the BFF as it does `/api`, in every mode.

The backend is fetched once into `.cache/backend/<sha>` (gitignored; `hack/backend-checkout.sh`),
the commit only, and built there with Go. To run your own checkout instead, set `BACKEND_DIR`
(`make dev-fake BACKEND_DIR=../ai-grid-provider-backend`); a checkout at another commit is
run with a warning, as the frontend's generated types are those of the pinned one.

## Ports

Every dev target takes the same variables, on the command line or in the environment, when
another process holds a default port:

| Variable | Default | What listens there |
|---|---|---|
| `FRONTEND_PORT` | `9000` | the Vite dev server |
| `BFF_PORT` | `8080` | the BFF; the Vite dev server proxies to it |
| `BACKEND_ADDRESS` | `127.0.0.1:9090` | the backend's gRPC and Connect: forwarded from the hub, yours, or on its fakes |
| `FAKE_HUB_ADDRESS` | `127.0.0.1:9091` | the backend's fake hub, which answers the access review (`make dev-fake`) |
| `PERSES_ADDRESS` | `127.0.0.1:9445` | the hub's Perses, forwarded (`make dev-cluster`) |

`make dev-fake` hands `BACKEND_ADDRESS` and `FAKE_HUB_ADDRESS` to the backend's own `make
dev-fake` as `DEV_GRPC_PORT` and `DEV_HUB_PORT`, and its other ports, `DEV_HTTP_PORT` (9092),
`DEV_KEYCLOAK_PORT` (9093) and `DEV_DRAFT_PORT` (9094), when you set them. For example:

```sh
make dev-fake FRONTEND_PORT=19000 BFF_PORT=18080 BACKEND_ADDRESS=127.0.0.1:19090 \
  FAKE_HUB_ADDRESS=127.0.0.1:19091 DEV_HTTP_PORT=19092 DEV_KEYCLOAK_PORT=19093 DEV_DRAFT_PORT=19094
```

## Run the pieces separately

Each dev target starts its processes in one terminal. To restart one without the others, or to
read one's log alone, run its pieces in terminals of their own, with the same variables. They
are not in `make help`:

| Target | Its pieces, one per terminal |
|---|---|
| `make dev-cluster` | `make dev-forward-backend`, `make dev-bff`, `make dev-frontend`; for Monitoring also `make dev-forward-perses`, and the BFF started with `PERSES_PROJECT`, `PERSES_URL=https://127.0.0.1:9445`, `PERSES_SERVER_NAME=perses.openshift-cluster-observability-operator.svc` and `PERSES_CA_FILE=$(hack/service-ca.sh)` |
| `make dev` | your backend, `make dev-bff`, `make dev-frontend` |
| `make dev-fake` | `make dev-fake-backend`, `make dev-bff-fake`, `make dev-frontend-fake` |

`make dev-frontend` sends your `oc whoami -t`; `make dev-frontend-fake` sends `dev-token` as
`dev-user` (`AUTH_TOKEN`, `AUTH_USER`). `make dev-bff` asks the hub of your `oc login`;
`make dev-bff-fake` asks the backend's fake hub and runs with `FAKE_BACKEND=true`.

## BFF settings

Environment variables the BFF reads: `HUB_API_URL` (required outside a pod; in a pod it
defaults to the in-cluster API server), `HUB_CA_FILE`, `BIND_ADDRESS` (default `127.0.0.1`;
`0.0.0.0` exposes the BFF without a proxy in front), `PORT`, `BACKEND_ADDRESS`,
`BACKEND_CA_FILE`, `BACKEND_SERVER_NAME`, `BACKEND_INSECURE`, `BACKEND_TIMEOUT` (10s, at most 50s),
`BACKEND_WRITE_TIMEOUT` (30s, at most 50s: a write procedure on the Connect relay, `docs/bff.md`),
`PERSES_URL`, `PERSES_CA_FILE`, `PERSES_SERVER_NAME`, `PERSES_INSECURE`, `PERSES_TIMEOUT`,
`PERSES_PROJECT` (the Perses relay, `docs/bff.md`),
`AUTH_TOKEN_HEADER`, `AUTH_USER_HEADER`, `AUTH_EMAIL_HEADER`, `AUTH_GROUPS_HEADER`,
`GRID_CONSUMER_URL`, `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `BILLING_URL`, `LOG_LEVEL`, `AUTH_TOKEN_PREFIX`,
`FAKE_BACKEND` (the backend runs on
fake infrastructure: the UI shows a banner, and no login proxy runs), `CERT_FILE`, `KEY_FILE`, `STATIC_ASSETS_DIR`. Run `go run ./cmd --help`
in `bff/` for the flags.

## Checks

```sh
make lint    # go vet, golangci-lint; ESLint, Prettier check, tsc (fix formatting with: cd frontend && pnpm format); make check-generated-api
make test    # go test -race (in-memory gRPC backend and stub hub), vitest
make build   # BFF binary and frontend bundle
make e2e     # Playwright on the production bundle (vite build, then vite preview with the dev proxy) against the backend at .backend-api-version on its fakes, PoC fixtures, and a BFF of its own (frontend/playwright.config.ts)
```

CI runs the same plus `make check-generated-api` (a fresh generation in a temporary directory
must match `frontend/src/gen`, below), the browser tests, `kustomize build`, `make chart-check`,
`make chart-test` and, after a merge, the container image build. Its last job, `CI passed`,
fails unless every job a pull request runs succeeded; that is the check the `main` ruleset
should require, since GitHub counts a skipped job as passing.

After a change to the BFF's own JSON (`/api/v1/user`, `/api/v1/config` or its errors),
`make -C bff golden` rewrites the golden responses in `mock/examples/`, which the frontend's
tests and `hack/check-chart.sh` read; `go test` fails while they differ. The BFF compiles against
no proto of its own: its one gRPC call, the readiness probe, uses the health client grpc-go
ships.

## The backend's API in the frontend

The frontend calls the backend's own RPCs over Connect with TypeScript
generated from the backend's proto: `proto/` of ai-grid-cloud/ai-grid-provider-backend, package
`ai_grid.v1` (not its draft, `ai_grid/draft`), at the full commit SHA in `.backend-api-version`,
into `frontend/src/gen`, which is committed and never edited by hand. The chart, `manifests/base`
and the kind test deploy the build of that commit (`sha-<sha>`, by digest). To move the console to
a newer backend:

```sh
git ls-remote https://github.com/ai-grid-cloud/ai-grid-provider-backend.git refs/heads/main  # the SHA
make backend-pin SHA=<sha> # .backend-api-version, make generate-api, and the backend image of the chart,
                           # manifests/base and hack/test-chart-kind.sh (fails if CI hasn't published sha-<sha> yet)
make check-generated-api   # what CI runs: a fresh generation in a temporary directory must match src/gen,
                           # and every backend image must be the build of .backend-api-version
```

`frontend/buf.gen.yaml` runs `@bufbuild/protoc-gen-es`, the devDependency pinned in
`package.json` at the version of `@bufbuild/protobuf` (the runtime the generated code imports),
with `target=ts` and the imported files too (`google/api`, `buf/validate`, the OpenAPI options),
and `@connectrpc/protoc-gen-connect-query`, pinned the same way, for the Connect Query descriptors
(`*_connectquery.ts`, one export per RPC).
`make generate-api` also generates `google/rpc/error_details.proto` from googleapis at the commit
the backend's `buf.lock` pins, for the `BadRequest` field violations in the backend's errors.
`frontend/src/api/connect` has the transport, the clients, the error mapping, `BackendProvider`
(which `App` wraps around every page) and a fake for tests; `docs/connect.md` is the how-to.

## Deploy to a cluster

One pod with three containers: kube-auth-proxy (`quay.io/opendatahub/odh-kube-auth-proxy`,
OpenShift OAuth, the proxy RHOAI uses), the console image (BFF plus frontend) and
`ai-grid-backend`. The BFF and the backend (its gRPC port and its REST gateway) bind to
loopback, so nothing on the pod network can reach either of them without going through the
proxy. The kubelet probes the
BFF's `/readyz` through the proxy, which passes that one path without login; it asks the
backend's gRPC health service, so it is the readiness signal for all three containers. The proxy
passes the caller's token and name to the BFF as request headers and puts neither in its responses
(`--set-xauthrequest=false`), so no script in the page can read the token.

CI publishes the console to `ghcr.io/ai-grid-cloud/ai-grid-provider-console`: every merge to
`main` as `sha-<full commit>` and `latest`, each `v*` tag by version, and each open pull request
as `pr-<number>` (deleted when it closes). Deploy a published image with
`IMAGE=ghcr.io/ai-grid-cloud/ai-grid-provider-console TAG=sha-<full commit>`, or build your own.
A new ghcr package starts private: when CI first publishes a new image, an organization owner
sets the package's visibility to Public, or clusters need a pull secret.

`make deploy` needs `TAG`: `:dev` is never published, and the Recreate rollout stops the running
pod before the new one pulls, so a tag the registry lacks takes the console down. `make image`
builds for `PLATFORM`, `linux/amd64` by default, so a build on an arm64 Mac runs on the hub.
Without `BACKEND_IMAGE`, the backend is the chart's: the build of `.backend-api-version`, the
backend this console was generated against. Set it only for a backend you built yourself.

```sh
make image IMAGE=quay.io/<you>/ai-grid-provider-console TAG=dev
make push  IMAGE=quay.io/<you>/ai-grid-provider-console TAG=dev
# build the backend image from its repository: podman build -f Containerfile -t quay.io/<you>/ai-grid-provider-backend:dev . && podman push ...
KEYCLOAK_URL=https://<keycloak-route-host> KEYCLOAK_ADMIN_USERNAME=... KEYCLOAK_ADMIN_PASSWORD=... \
  make deploy IMAGE=quay.io/<you>/ai-grid-provider-console TAG=dev BACKEND_IMAGE=quay.io/<you>/ai-grid-provider-backend:dev
```

`hack/deploy.sh` installs the Helm chart `charts/ai-grid-provider-console` as release
`ai-grid-provider-console` in namespace `ai-grid` (ServiceAccount, a `system:auth-delegator`
binding for token validation, the backend's ManagedCluster ClusterRole, Deployment, Service with
an OpenShift serving certificate, reencrypt Route), waits for the Route host, then creates the
cluster-scoped `OAuthClient` and the secret the proxy reads. `HELM_ARGS` passes more chart values,
for example `HELM_ARGS="--set backend.clusterWrites=true"`, but not the names the script relies on
(the release's objects, the two Secrets, the Route). A console deployed before the chart, from
`manifests/base`, is taken over in place (`hack/chart-takeover.sh`). `KEYCLOAK_URL`, `KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` are
required, with `KEYCLOAK_REALM` (default `ai-grid`) and `KEYCLOAK_ADMIN_REALM` (default
`master`) optional: all five become the secret the backend container mounts, so the
manifests carry no environment's values and the pod does not start without the secret,
which keeps the backend off its built-in default credentials. Use an `https://` URL where
the cluster offers one, since the admin password travels with every call; on the dev hub
that is the Keycloak Route in `grid-sso`, as its Service is plain HTTP. Creating the
`OAuthClient` needs cluster-admin.
`make undeploy` removes everything but the namespace. The chart also creates ClusterRole
`ai-grid-provider-admin`, which decides who may use the console, and binds it to nobody:
cluster-admins may use the console, everyone else needs a binding (the chart's README,
"Provider admins").

To call the deployed API from a script, send your token as a bearer token; the proxy
validates it with a TokenReview and forwards it:

```sh
curl -H "Authorization: Bearer $(oc whoami -t)" https://<route-host>/api/v1/user
```

### The Helm chart

`charts/ai-grid-provider-console` is the console's install: one release per ACM hub, the
standalone deployment the architecture expects for the provider console in 3.6 (there is no
operator for it on the hub). Its values (`values.yaml`) choose the three images (tag, digest or
both), the Route, its host and the CA it trusts for the proxy, the serving certificate
(OpenShift's service CA, or a Secret you provide), the names of the Secrets, the console's `/api/v1/config` settings, resources, and
`backend.clusterWrites`: `patch` on ManagedClusters for Add to AI grid, Edit and Remove, together with a
`ValidatingAdmissionPolicy` (from ai-grid-env-setup) that limits the backend to the `ai-grid/*`
and `location` labels and `ai-grid/*` annotations. Argo CD applies the policy before the grant
(sync wave -1); `helm` applies it last, so turning `clusterWrites` on with `helm` leaves the backend
unrestricted until the policy loads, a few seconds.

`backend.git` sets up the backend's git mode (ai-grid-provider-backend#29): Models and
Subscriptions are commits to a Git repository, which Argo CD delivers to the spokes. `url` is the
repository (`https://`, without credentials; the schema refuses anything else), `branch` defaults to
`main`, and `tokenSecretName` (default `ai-grid-backend-git`) is a Secret whose key `token` holds a
fine-grained token with `contents: write` on that repository only; the chart mounts it as a file.
`gridNamespace` is the spokes' grid namespace each model's NetworkPolicy admits (empty: the
backend's default). `modelsNamespace` is the spokes' namespace each model is deployed to (empty: the
backend's default); the reference environment and our clusters use `ai-grid-internal-models`.
It must match the environment's model namespace. The environment delivers models to that
namespace, creates it enabled for the grid, and reads model status from it, so setting only
`modelsNamespace` commits models that are never delivered, routed or reported. Changing it on a
live install moves each model to the new namespace on its next write, and Argo CD prunes the old
copy. Models nobody edits stay in the old namespace, so the spokes serve from both until each
model is written again. With `url` set, the chart also grants `get` and `list` on Argo CD
Applications in `openshift-gitops` (a Role and RoleBinding there): the backend reads the spokes'
status of models and subscriptions from the health the catalog's Applications
(`acm-models-catalog-{models,ingress,subscriptions}-<cluster>`) record. Without it every model
stays Saved to Git and no subscription has a phase. `list` can't be limited by name, so keep
secrets out of the Application specs in that namespace. Backend images with git mode don't start
without `url`; leave it empty for older ones. `hack/deploy.sh` sets it from `GIT_URL`, `GIT_BRANCH`, `GIT_TOKEN`,
`GIT_GRID_NAMESPACE` (`grid` on the dev hub) and `GIT_MODELS_NAMESPACE`, creating the Secret.

The chart doesn't create the `OAuthClient`, the proxy's Secret, the backend's Keycloak Secret or its Git token Secret:
`hack/deploy.sh` does, or ai-grid-env-setup's `bootstrap/60-console.sh`. Generated secrets would
need Helm's `lookup`, which returns nothing under `helm template` and Argo CD, so every render
would make new ones.

`values.schema.json` lists every value: an unknown or misspelled key (`--set
backend.clusterwrites=true`) fails the install instead of being ignored, so a new value goes in the
schema too. `helm install` and `helm upgrade` print what the chart expects to exist
(`templates/NOTES.txt`).

The chart is the install path: ai-grid-env-setup deploys it (`apps/console`) and `hack/deploy.sh`
installs it. `manifests/base` is not one any more; it is kept for `hack/undeploy.sh`'s fallback,
which removes a console deployed before the chart, and for `make chart-test`'s takeover test.
`make chart-check` (in CI) lints the chart and fails when its defaults render anything but
`manifests/base`, Helm's own labels aside. The chart keeps the Deployment's selector of
`manifests/base`, so a hub moves in place.

`make chart-test` (in CI too) checks the chart on a throwaway kind cluster, without OpenShift: it
installs the Route and ManagedCluster CRDs, a self-signed certificate and placeholder Secrets, then
checks that `manifests/base` moves to the chart in place (applied over it as Argo CD would, and
taken over by a Helm release as `hack/deploy.sh` does), that the pod becomes ready, that the
proxy refuses a caller without a token and accepts a ServiceAccount token, that `isProviderAdmin`
and the cluster list work, that only the proxy listens off loopback, that the admission policy
allows the backend's `ai-grid/*` labels and refuses its other changes, and that uninstalling
leaves no cluster-scoped objects. OpenShift's browser login, the service CA and the router are
not covered. On an arm64 machine the amd64-only backend and proxy images run emulated. kind
switches kubectl's current context; the script puts it back.
