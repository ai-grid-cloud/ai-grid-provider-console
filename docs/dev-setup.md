# Development setup

Three processes: `ai-grid-backend` (gRPC, talks to the cluster), the BFF (JSON, talks to
the backend) and the Vite dev server (serves the frontend, proxies `/api` to the BFF). The
console runs as the user who ran `oc login`: the dev proxy sends your name and token the
way kube-auth-proxy would, and the BFF forwards them to the backend.

## Prerequisites

- Go 1.26 or newer, `golangci-lint`
- Node 22 and pnpm 11 (`npm install -g pnpm@11.22.0`)
- `oc`, `kustomize`, `jq`
- `oc login` to an ACM hub. The backend lists `ManagedClusters` with your kubeconfig
  locally; in a cluster it uses its ServiceAccount. The BFF asks the same hub whether you
  may patch `ManagedClusters` (`isProviderAdmin`), using your token.

## Run without a cluster

```sh
make install        # once: frontend dependencies
make dev-fake       # fake backend on :9090, fake hub on :9091, BFF on :8080, frontend on :9000
```

No `oc login` is needed. The fake backend (`bff/cmd/fake-backend`) serves the backend's
gRPC services from `mock/fixtures` and answers the BFF's access review like a hub would;
`mock/README.md` explains what it simulates and how faithful it is. `AUTH_TOKEN=viewer-token
make dev-fake` shows the console as a user who is not a provider admin (no enrol or remove
actions, and the fake backend answers `PermissionDenied` to a write), and
`AUTH_TOKEN=expired-token` the signed-out path. Edit the fixtures and restart to change the
fleet. The fake also moves clusters over time (`mock/fixtures/scenarios.json`: a cluster
imports, one detaches, one recovers its lease); set `speed` in `mock/fixtures/settings.json`
to play those faster. The gRPC services need `authorization` metadata like the real backend,
which the BFF forwards from the proxy headers.

## Run against a real cluster

```sh
oc login https://api.<hub>:443 --token=...
make install        # once: frontend dependencies
make dev            # backend on :9090, BFF on :8080, frontend on :9000
```

Open http://127.0.0.1:9000. The masthead shows the `oc` user; Clusters lists the hub's
`ManagedClusters` as the backend reports them. Tenants shows an error until the backend
can reach a Keycloak with an `ai-grid` realm (the dev hub has Keycloak in `grid-sso` but
no realm yet).

How the pieces connect:

1. `hack/dev-backend.sh` clones `ai-grid-backend` into `.cache/` at the commit recorded in
   `mock/proto/upstream/COMMIT` and runs it with `--kubeconfig` on `127.0.0.1:9090`. Set `BACKEND_DIR` to
   use your own checkout.
2. The BFF listens on `127.0.0.1:8080`, dials `BACKEND_ADDRESS` (default `127.0.0.1:9090`,
   plaintext) and forwards the caller's token as `authorization` metadata
   (`bff/internal/backend`). For `/api/v1/user` it posts a `SelfSubjectAccessReview` to
   `HUB_API_URL` with the caller's token (`bff/internal/hub`); `make dev-bff` sets it from
   `oc whoami --show-server`, and `HUB_CA_FILE` from the kubeconfig's cluster CA when it has
   one (`hack/hub-ca.sh`). Plaintext `http://` is accepted for loopback only.
3. The Vite dev server proxies `/api` to the BFF and sets `x-forwarded-access-token` and
   `x-forwarded-user` from `oc whoami` (`frontend/vite.config.ts`). After a 401 they are
   re-read, so a new `oc login` is picked up without restarting. `AUTH_GROUPS` adds a
   groups header, which the BFF only forwards to the backend.

Without the frontend:

```sh
make dev-backend
make dev-bff
hack/api.sh /api/v1/user
hack/api.sh /api/v1/clusters
hack/api.sh /api/v1/tenants
curl -s http://127.0.0.1:8080/readyz
```

`hack/smoke.sh` builds the BFF, starts it on a spare port against the backend on :9090 and
checks the read-only endpoints.

Environment variables the BFF reads: `HUB_API_URL` (required outside a pod; in a pod it
defaults to the in-cluster API server), `HUB_CA_FILE`, `BIND_ADDRESS` (default `127.0.0.1`;
`0.0.0.0` exposes the BFF without a proxy in front), `PORT`, `BACKEND_ADDRESS`,
`BACKEND_CA_FILE`, `BACKEND_SERVER_NAME`, `BACKEND_INSECURE`, `BACKEND_TIMEOUT`,
`AUTH_TOKEN_HEADER`, `AUTH_USER_HEADER`, `AUTH_EMAIL_HEADER`, `AUTH_GROUPS_HEADER`,
`GRID_CONSUMER_URL`, `MAP_TILE_URL`, `BILLING_URL`, `LOG_LEVEL`. Run `go run ./cmd --help`
in `bff/` for the flags.

## Checks

```sh
make lint    # go vet, golangci-lint, buf lint on mock/proto, tsc
make test    # go test -race (in-memory gRPC backend, proto drift test), vitest
make build   # BFF binary and frontend bundle
```

CI runs the same plus `make -C bff check-generated` (a fresh generation in a temporary
directory must match `bff/gen`, file for file), `kustomize build` and a container image
build. A separate nightly workflow (`.github/workflows/drift.yaml`, also runnable by hand)
refreshes the vendored backend proto from the backend's `main` in the runner's checkout and
runs the drift test, so a backend proto change is reported the day after it merges.

## The proto the BFF compiles against

The BFF imports `bff/gen/ai_grid/v1`, generated from the console's draft proto in
`mock/proto/ai_grid/v1` (the backend's three RPCs plus the shapes the console proposes; see
`mock/README.md`, "The draft proto"). After editing a `.proto` file:

```sh
make -C bff generate      # buf generate; buf and the protoc plugins run through `go run`, nothing to install
make -C bff lint-proto    # buf lint
make -C bff check-generated
```

`hack/sync-upstream-proto.sh <ref>` refreshes the vendored copy of the backend's real proto
(it fetches into a temporary directory and only then replaces `mock/proto/upstream`, so a
failed fetch leaves the previous copy intact); `go test ./internal/protodrift/` then says
whether the draft still covers it.

## Deploy to a cluster

One pod with three containers: kube-auth-proxy (`quay.io/opendatahub/odh-kube-auth-proxy`,
OpenShift OAuth, the proxy RHOAI uses), the console image (BFF plus frontend) and
`ai-grid-backend`. The BFF and the backend both bind to loopback, so nothing on the pod
network can reach either of them without going through the proxy. The kubelet probes the
BFF's `/readyz` through the proxy, which passes that one path without login; it pings the
backend, so it is the readiness signal for all three containers.

```sh
make image IMAGE=quay.io/<you>/ai-grid-provider-console TAG=dev
make push  IMAGE=quay.io/<you>/ai-grid-provider-console TAG=dev
# build the backend image from its repository: podman build -f Containerfile -t quay.io/<you>/ai-grid-backend:dev . && podman push ...
KEYCLOAK_URL=https://<keycloak-route-host> KEYCLOAK_ADMIN_USERNAME=... KEYCLOAK_ADMIN_PASSWORD=... \
  make deploy IMAGE=quay.io/<you>/ai-grid-provider-console TAG=dev BACKEND_IMAGE=quay.io/<you>/ai-grid-backend:dev
```

`hack/deploy.sh` applies `manifests/base` (namespace `ai-grid`, ServiceAccount, a
`system:auth-delegator` binding for token validation, the backend's ManagedCluster
ClusterRole, Deployment, Service with an OpenShift serving certificate, reencrypt Route),
waits for the Route host, then creates the cluster-scoped `OAuthClient` and the secret the
proxy reads. `KEYCLOAK_URL`, `KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` are
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
