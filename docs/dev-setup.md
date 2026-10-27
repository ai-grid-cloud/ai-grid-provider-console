# Development setup

Three processes: the backend ([ai-grid-provider-backend](https://github.com/ai-grid-cloud/ai-grid-provider-backend),
gRPC, talks to the hub and Keycloak), the BFF (JSON, talks to the backend) and the Vite dev
server (serves the frontend, proxies `/api` to the BFF). The BFF and the frontend run from this
repository; the backend never does. It runs where it lives: deployed on the hub, or from its own
repository in a second terminal. The console runs as the user who ran `oc login`: the dev proxy
sends your name and token the way kube-auth-proxy would, and the BFF forwards them to the backend.

## Prerequisites

- Go 1.26 or newer, `golangci-lint`
- Node 22 and pnpm 11 (`npm install -g pnpm@11.22.0`)
- `oc`, `kustomize`, `jq`
- For the chart and the image: `helm` and `yq` (mikefarah v4) for `make chart-check`; docker or
  podman for `make image`; docker, `kind`, `kubectl` and `openssl` for `make chart-test`
- To run against a real hub or deploy (not for `make dev-fake`): `oc login` to an ACM hub. The
  BFF asks that hub whether you may patch `ManagedClusters` (`isProviderAdmin`), using your token.

## Run against a real hub

| You want | Terminal 1 | Terminal 2 (this repository) |
|---|---|---|
| The console as the hub serves it | (none) | `make start` (same as `make dev-cluster`) |
| To change the backend too | the backend repository: run it on `127.0.0.1:9090` against your `oc login` | `make dev` |

```sh
oc login https://api.<hub>:6443 ...
make install     # once: frontend dependencies
make start       # the hub's backend (forwarded to :9090), its Perses (:9445), BFF on :8080, frontend on :9000
```

Open http://127.0.0.1:9000. `make start` needs the console deployed on the hub (`make deploy`, or
[ai-grid-env-setup](https://github.com/ai-grid-cloud/ai-grid-env-setup)): it forwards the backend
container of `ai-grid/ai-grid-provider-console` (`NAMESPACE`, `DEPLOYMENT`) with `oc port-forward`,
so you see what the deployed console shows, from the same backend build, ServiceAccount, RBAC and
Keycloak. Writes are real and go through the deployed backend's ServiceAccount, so they work
exactly where the deployed console's do. On a hub set up by ai-grid-env-setup, which deploys the
chart with `backend.clusterWrites: true` (`patch` on ManagedClusters for that ServiceAccount),
Add to AI Grid and Remove change the hub's clusters. With `make deploy` alone, the chart grants
only `get`, `list` and `watch` (unless `HELM_ARGS="--set backend.clusterWrites=true"`), so they
are refused (403). Organization create, update and delete go to the backend's Tenants RPCs and
change the hub's Keycloak; one that sets a field the backend's tenant doesn't have answers 501.
Before it starts
anything, `make start` checks your login, `pods/portforward` in the namespace, an available pod
and a free local port. The forward listens on one loopback address only, reconnects when a rollout
replaces the pod, and creates nothing on the cluster. Pages whose RPCs the backend doesn't serve
yet say "not available on this backend yet".

For the Monitoring page, set `PERSES_PROJECT` to the Perses project whose `dashboard-*` objects are
the tabs (the relay reads only that project; without it Monitoring stays off). `make start` then
also forwards the hub's Perses
(`openshift-cluster-observability-operator/perses`, `PERSES_NAMESPACE`, `PERSES_SERVICE`) to
`127.0.0.1:9445` (`PERSES_ADDRESS`, `hack/forward-perses.sh`) and points the BFF at it, verifying
its certificate with the hub's service CA (`hack/service-ca.sh`). That forward grants nothing:
Perses checks the token the BFF forwards, yours. When the Service is missing, your login may not
port-forward there or the CA can't be read, `make start` says why and runs with Monitoring off
(`PERSES_CA_FILE` you set yourself is used instead of the cluster's). A `PERSES_URL` you set
yourself wins, and no forward starts.

Treat `pods/portforward` in the console's namespace as provider-admin access. Until the backend
authorizes the caller, anyone who can port-forward there reaches the backend directly, here or with
a plain `oc port-forward`, and acts with its ServiceAccount's rights: those the chart grants
(`templates/rbac.yaml`), which include `patch` on ManagedClusters when the chart value
`backend.clusterWrites` is on, as ai-grid-env-setup deploys it. The local BFF's `isProviderAdmin`
check is a convenience, not a boundary: whoever runs the forward can call the backend without it.

To run your own backend instead, start it in a checkout of the backend repository, then run
`make dev` here. It uses your kubeconfig (`KUBECONFIG_PATH`) and needs the Keycloak settings
(`KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ADMIN_USERNAME`, `KEYCLOAK_ADMIN_PASSWORD`):

```sh
# in ai-grid-provider-backend
KEYCLOAK_ADMIN_USERNAME=... KEYCLOAK_ADMIN_PASSWORD=... \
  make run LISTEN_ADDRESS=127.0.0.1:9090 HTTP_LISTEN_ADDRESS=127.0.0.1:9092 KEYCLOAK_URL=https://<keycloak>
```

Run that way, the backend acts with your `oc login`'s rights, not the deployed ServiceAccount's.
`BACKEND_ADDRESS` moves the address the BFF dials in both targets.

How the pieces connect:

1. The backend, deployed or local, listens on `127.0.0.1:9090` (`BACKEND_ADDRESS`).
2. The BFF listens on `127.0.0.1:8080`, dials `BACKEND_ADDRESS` (plaintext) and forwards the
   caller's token as `authorization` metadata (`bff/internal/backend`). For `/api/v1/user` it posts
   a `SelfSubjectAccessReview` to `HUB_API_URL` with the caller's token (`bff/internal/hub`);
   `make dev-bff` sets it from `oc whoami --show-server`, and `HUB_CA_FILE` from the kubeconfig's
   cluster CA (`hack/hub-ca.sh`). A login made with `--insecure-skip-tls-verify` stores no CA, so
   then the CA comes from the cluster's `kube-root-ca.crt` ConfigMap. Plaintext `http://` is
   accepted for loopback only.
3. The Vite dev server proxies `/api` to the BFF and sets `x-forwarded-access-token` and
   `x-forwarded-user` from `oc whoami` (`frontend/vite.config.ts`). After a 401 they are
   re-read, so a new `oc login` is picked up without restarting. `AUTH_GROUPS` adds a
   groups header, which the BFF only forwards to the backend.

Without the frontend:

```sh
make dev-forward-backend   # or your own backend on :9090
make dev-bff
hack/api.sh /api/v1/user
hack/api.sh /api/v1/clusters
hack/api.sh /api/v1/tenants
hack/api.sh /api/v1/models          # 501 until the backend ships the Models service
curl -s http://127.0.0.1:8080/readyz
```

`hack/smoke.sh` builds the BFF, starts it on a spare port against the backend on :9090 and
checks the read-only endpoints.

## Run without a cluster

```sh
make install     # once: frontend dependencies
make dev-fake    # fake backend :9090 and hub :9091, BFF :8080, frontend :9000
```

No `oc login` is needed. Open http://127.0.0.1:9000. You're signed in as `dev-user`, a provider
admin; set `AUTH_TOKEN=viewer-token AUTH_USER=viewer` to see the console as a user who isn't one.
The fake backend serves the backend's gRPC services from `mock/fixtures/` and answers the BFF's
access review like a hub would. For the endpoints, the tokens, the seeded states, the timed
scenarios and the errors you can provoke, see [mock/AGENTS.md](../mock/AGENTS.md); for every
fixture file and field, [mock/fixtures/README.md](../mock/fixtures/README.md);
[mock/README.md](../mock/README.md) explains why the console runs against a fake. Edit the
fixtures and restart to change the fleet.

## BFF settings

Environment variables the BFF reads: `HUB_API_URL` (required outside a pod; in a pod it
defaults to the in-cluster API server), `HUB_CA_FILE`, `BIND_ADDRESS` (default `127.0.0.1`;
`0.0.0.0` exposes the BFF without a proxy in front), `PORT`, `BACKEND_ADDRESS`,
`BACKEND_CA_FILE`, `BACKEND_SERVER_NAME`, `BACKEND_INSECURE`, `BACKEND_TIMEOUT`,
`PERSES_URL`, `PERSES_CA_FILE`, `PERSES_SERVER_NAME`, `PERSES_INSECURE`, `PERSES_TIMEOUT`,
`PERSES_PROJECT` (the Perses relay, `docs/plan/bff-api.md`),
`AUTH_TOKEN_HEADER`, `AUTH_USER_HEADER`, `AUTH_EMAIL_HEADER`, `AUTH_GROUPS_HEADER`,
`GRID_CONSUMER_URL`, `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `BILLING_URL`, `LOG_LEVEL`, `AUTH_TOKEN_PREFIX`,
`MODELS_NAMESPACE` (the namespace the console creates models in, default `models-as-a-service`; `make dev-fake` sets `ai-grid-models`), `FAKE_BACKEND` (the backend is
the fake; the UI shows a banner), `CERT_FILE`, `KEY_FILE`, `STATIC_ASSETS_DIR`. Run `go run ./cmd --help`
in `bff/` for the flags.

## Checks

```sh
make lint    # go vet, golangci-lint, buf lint on mock/proto; ESLint, Prettier check, tsc (fix formatting with: cd frontend && pnpm format)
make test    # go test -race (in-memory gRPC backend, proto drift test), vitest
make build   # BFF binary and frontend bundle
```

CI runs the same plus `make -C bff check-generated` (a fresh generation in a temporary
directory must match `bff/gen`, file for file), the browser tests, `kustomize build`,
`make chart-check`, `make chart-test` and, after a merge, the container image build. Its last
job, `CI passed`, fails unless every job a pull request runs succeeded; that is the check the
`main` ruleset should require, since GitHub counts a skipped job as passing. A separate
nightly workflow (`.github/workflows/drift.yaml`, also runnable by hand)
refreshes the vendored backend proto from the backend's `main` in the runner's checkout and
runs the drift test, so a backend change to a message or RPC the BFF uses is reported the day
after it merges.

## The proto the BFF compiles against

The BFF imports `bff/gen/ai_grid/v1`, generated from the console's draft proto in
`mock/proto/ai_grid/v1` (the console's proposal, which the fake backend serves; see
`mock/proto/README.md`), and `bff/gen/ai_grid/backend/v1`, generated from its copy of the real
backend's Clusters, Tenants, Subscriptions and Models messages in `mock/proto/ai_grid/backend/v1`. After editing a
`.proto` file:

```sh
make -C bff generate      # buf generate; buf and the protoc plugins run through `go run`, nothing to install
make -C bff lint-proto    # buf lint
make -C bff check-generated
```

`generate` and `check-generated` run with `GOTOOLCHAIN` set to the version in `bff/go.mod`,
which is what CI installs, because the generated comments depend on the Go release that builds
`protoc-gen-go`; the first run downloads that toolchain if it is not cached. After a change to
the BFF's JSON or the fixtures, `make -C bff golden` rewrites the golden responses in
`mock/examples/` (see `mock/AGENTS.md`).

`hack/sync-upstream-proto.sh <ref>` refreshes the vendored copy of the backend's real proto,
`proto/ai_grid/v1` of ai-grid-cloud/ai-grid-provider-backend: the files as they are, and an
image `buf build` compiles from them with their imports (it fetches and builds in a temporary
directory and only then replaces `mock/proto/upstream`, so a failed fetch leaves the previous
copy intact). `go test ./internal/protodrift/` then says whether the BFF's copy in
`mock/proto/ai_grid/backend/v1` still matches it, and whether the RPCs the BFF calls still
exist. The vendored commit is the backend's `main` (`mock/proto/upstream/COMMIT`), and the nightly
`.github/workflows/drift.yaml` checks the copy against the newest one.

## Deploy to a cluster

One pod with three containers: kube-auth-proxy (`quay.io/opendatahub/odh-kube-auth-proxy`,
OpenShift OAuth, the proxy RHOAI uses), the console image (BFF plus frontend) and
`ai-grid-backend`. The BFF and the backend (its gRPC port and its REST gateway) bind to
loopback, so nothing on the pod network can reach either of them without going through the
proxy. The kubelet probes the
BFF's `/readyz` through the proxy, which passes that one path without login; it pings the
backend, so it is the readiness signal for all three containers.

CI publishes the console to `ghcr.io/ai-grid-cloud/ai-grid-provider-console`: every merge to
`main` as `sha-<full commit>` and `latest`, each `v*` tag by version, and each open pull request
as `pr-<number>` (deleted when it closes). Deploy a published image with
`IMAGE=ghcr.io/ai-grid-cloud/ai-grid-provider-console TAG=sha-<full commit>`, or build your own.
A new ghcr package starts private: when CI first publishes a new image, an organization owner
sets the package's visibility to Public, or clusters need a pull secret.

`make deploy` needs `TAG`: `:dev` is never published, and the Recreate rollout stops the running
pod before the new one pulls, so a tag the registry lacks takes the console down. `make image`
builds for `PLATFORM`, `linux/amd64` by default, so a build on an arm64 Mac runs on the hub.

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
`make undeploy` removes everything but the namespace.

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
`backend.clusterWrites`: `patch` on ManagedClusters for Add to AI Grid and Remove, together with a
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
backend's default). With `url` set, the chart also grants `get` on the two inform-only Policies the
backend reads the spokes' status from (`ai-grid-models-status`, `ai-grid-catalog-status`, and each
cluster's copy). Backend images with git mode don't start without `url`; leave it empty for older
ones. `hack/deploy.sh` sets it from `GIT_URL`, `GIT_BRANCH`, `GIT_TOKEN` and
`GIT_GRID_NAMESPACE` (`grid` on the dev hub), creating the Secret.

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
