# Working in this repository

Rules for every coding agent (and person) changing this repository. There is no root
`CLAUDE.md`; this file applies to all agents. To run the console, with or without a cluster
(`make dev-fake` runs the real backend on its own fakes), read
[docs/dev-setup.md](docs/dev-setup.md); to build a page on the backend's API,
[docs/connect.md](docs/connect.md); for how every page looks and behaves (its loading, error,
empty and not-found states, lists, status labels and forms), read
[frontend/AGENTS.md](frontend/AGENTS.md).

## The architecture

On 2026-10-19 we decided to consolidate the contract into the backend and move the console to
Connect end to end. The backend serves Connect, with vanguard for REST, and every page calls it
over Connect; the BFF's own JSON API is down to `/api/v1/user` and `/api/v1/config`. Read the
decisions before designing anything new:

- [ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md): the contract lives in
  `ai-grid-cloud/ai-grid-provider-backend`, reconciled to the OSAC service standards. The
  console's draft proto, its fake backend, the vendored upstream copy and the drift guard are
  gone; the frontend is generated from the backend's proto (`make generate-api`), and the BFF
  compiles against no contract.
- [ADR-0002](docs/adr/0002-connect-end-to-end-with-vanguard-for-rest.md): the browser speaks
  Connect; the backend serves Connect, gRPC and gRPC-Web from one connect-go server, and vanguard
  only adds its REST routes, which the console and the BFF never use. The JSON envelope, the
  `ETag`/`If-Match` protocol and the hand-written TypeScript go away.
- [ADR-0003](docs/adr/0003-the-resource-version-stays-a-string.md): a proposed string version
  instead of the backend's shipped `int32`, because a Kubernetes `resourceVersion` is opaque.
- [ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md): the BFF relays backend calls, serves
  static assets, health and console config, and keeps the optional Perses relay. It is the
  seam OSAC's proxy layer later replaces.

Two things are worth knowing before you touch anything in `bff/internal/api` or
`frontend/src/api`: the legacy JSON shapes declared there and in the BFF are down to
`/api/v1/user` and `/api/v1/config`, while the pages read the types generated from the backend's
proto; and the backend performs **no authentication or authorization at all** today, so the
token the BFF forwards is read by nothing (ADR-0004).

Use the vocabulary in [GLOSSARY.md](GLOSSARY.md). Three concepts have two or three names in
the code right now; the glossary says which one wins.

## The BFF does transport only

There is one provider console per ACM hub ("hub" always means the ACM hub), deployed by this
repository's Helm chart, for provider admins only: organization users never reach it, and their
UI is the MaaS consumer portal on each MaaS (ingress) cluster. The console is a React frontend, a thin
Go BFF (`bff/`) and `ai-grid-provider-backend`, the provider API in its own repository,
`ai-grid-cloud/ai-grid-provider-backend` (`docs/bff.md`). The backend is meant to stand
on its own: a CLI, GitOps tooling and other UIs will call it without the BFF. So anything
that decides what data means, or what a request may do, belongs in the backend; if it lived in
the BFF, every other client would have to copy it. The backend's API follows OSAC's
conventions (`docs/research/backend-conventions.md`): a List request carries only `offset`,
`limit`, `filter` (CEL) and `order`, and an Update replaces a map field as a whole (FieldMask
semantics, no `labels.<key>` paths). The client writes the CEL filter and edits the map it
loaded; the relay forwards both unchanged; the backend evaluates the filter and applies the
update under optimistic locking.

What the BFF does:

- serves a JSON API that only reads (`/api/v1/user` and `/api/v1/config`) and calls no backend:
  every call to the backend goes over Connect, through the relay below, which passes the
  backend's answers and errors through unchanged;
- serves the SPA, `/healthcheck`, `/readyz` (the backend's standard gRPC health service),
  `/api/v1/config`, and asks the hub for `isProviderAdmin` (a `SelfSubjectAccessReview` with
  the caller's token);
- relays `/perses/api` to the hub's Perses with the caller's token, for the Monitoring page:
  only the read and query paths the Perses components call, nothing else of the caller's
  (`bff/internal/perses`). Perses authorizes and runs the queries;
- relays the browser's Connect calls to the backend's own RPCs (`/ai_grid.v1.<Service>/<Method>`,
  `bff/internal/relay`) behind the same caller checks as `/api/v1`: a reverse proxy that drops
  whatever the browser sent about who it is (`Authorization`, cookies, `Forwarded`, every
  `X-Forwarded-*`) and sets the caller the BFF read from the proxy's headers (the token as
  `Authorization`, plus user, email and groups, percent-encoded), passes only
  the Connect protocol (POST with a Connect content type, GET), refuses compressed requests,
  limits bodies to 1 MiB, bounds a unary call and every call's wait for headers by
  `BACKEND_TIMEOUT` (`BACKEND_WRITE_TIMEOUT` for the procedures its allowlist marks as writes),
  passes back only the response headers a Connect client needs, and never
  reads a body or compiles against the contract. A
  new RPC needs no transport implementation in the BFF. Until backend authorization lands,
  review it for the procedure allowlist (`docs/bff.md`, "The Connect relay").

What belongs in the backend: validation of values, normalization and defaults, resource
versions and the precondition check, list filtering, ordering and counting, deciding whether an
update changes anything, which keys a caller may change, and every field derived from other
fields. Don't add a Kubernetes client, or a JSON route, to the BFF to work around a missing RPC:
a new endpoint is a backend proto change first.

## Adding a feature

New API work goes to the backend's `ai_grid.v1`, following
[ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md). Clusters, Organizations,
Models and Subscriptions already have real services. Models and Subscriptions use Git writes
and Argo CD delivery; their draft implementations have been removed from the backend.
[`docs/connect.md`](docs/connect.md) is the console integration guide:

1. Implement the contract in the backend with its infrastructure fakes and tests, following
   that repository's `docs/API_CONTRACT.md`.
2. Run `make backend-pin SHA=<full sha>` with a backend commit on `main` that has it: it writes
   `.backend-api-version`, regenerates `frontend/src/gen`, and moves the backend image of the
   chart, `manifests/base` and the kind test to that commit's build. Commit them all with the
   change. Never edit generated files or repeat their types.
3. Build the page with `useQuery` and `useMutation` from `@connectrpc/connect-query` on the
   generated descriptors (`frontend/src/gen/ai_grid/v1/*_connectquery.ts`); `App` already
   provides the transport and the query cache (`BackendProvider`). Show errors with
   `describeError`, test with `fakeClients`' transport, and try `make dev-fake`
   (`docs/connect.md`, "Using it in a page"). While backend authorization is pending, review any
   new procedure against the relay allowlist.

Afterwards run `make -C bff golden` when the BFF's own JSON (`/api/v1/user`, `/api/v1/config`,
its errors) changed, and update the docs (`docs/bff.md`, `docs/connect.md`) in the same change.

Run `make lint test` at the root before opening a pull request (CI runs the same, and the
browser tests, `make e2e`). Keep commits small, each describing its change, with no AI
attribution trailers.

Don't name files, identifiers or tests after pull requests or issues; a comment describes the
behaviour and points at its source (a file, a function or an upstream commit), not a PR number.

## The backend's own API over Connect

The console calls the backend's RPCs from the browser over Connect (ADRs 0002 and 0004),
through one provider at the app root. The Clusters, Models, Subscriptions and Organizations
pages and the AI grid map read and write through it (`docs/connect.md`, "The Clusters area",
"The Models area", "The Subscriptions area" and "The Organizations area"), and Monitoring reads
the hub's Perses through the BFF's Perses relay:

- `.backend-api-version` holds the backend commit (one full SHA) whose `proto/` (package
  `ai_grid.v1`, not `ai_grid/draft`) the frontend is generated from. `make generate-api` writes
  `frontend/src/gen` (committed; never edit it, `make check-generated-api` fails CI when it
  differs). The chart, `manifests/base` and the kind test deploy that commit's image,
  `ghcr.io/ai-grid-cloud/ai-grid-provider-backend:sha-<sha>` by digest: a newer backend can
  refuse what an older console sends. To move to a newer backend, run
  `make backend-pin SHA=<full sha>`, which does all of it; `make check-generated-api` fails when
  any of them names another build.
- `frontend/src/api/connect`: `createConsoleTransport` (Connect JSON to the console's origin; on
  Unauthenticated it calls the console's `checkSession`), `createConsoleClients` (typed clients
  per service), `BackendProvider` (the transport and a Query v5 cache for Connect Query, which
  `App` wraps around every page), `describeError` and
  `toServiceError` (a ConnectError as the UI states the pages already show), and `fakeClients`
  in `testing.ts` (typed in-memory fakes for tests).
- `make dev-fake` runs the backend at that commit on its own fake hub and Keycloak (its own
  `make dev-fake`, fetched into `.cache/backend/<sha>`, or `BACKEND_DIR`), the BFF against it
  and the frontend, so pages and the relay can be tried on the real backend without a cluster.
  The browser tests (`make e2e`) run the same backend on its PoC fixtures. The console has no
  fake backend of its own any more.

## The backend has no authentication yet

Authentication and authorization of API calls are out of the backend's MVP scope (decided
2026-10-20; ai-grid-cloud/ai-grid-provider-backend#3): it answers anyone who reaches it, as its
own ServiceAccount, which may label every ManagedCluster and, on the hub, read ACM Search's index
of every managed cluster. So in the console's pod:

- kube-auth-proxy is the only listener on the pod network (`:8443`), and the only port the
  Service and Route expose. The BFF and the backend bind to loopback (the backend's
  `--listen-address=127.0.0.1:9090` and `--http-listen-address=127.0.0.1:8081`), and every call
  reaches the backend through the BFF's caller checks (signed in, provider admin), on `/api/v1`
  and on the Connect relay alike.
- The BFF never validates a token: kube-auth-proxy signs provider admins in, and the BFF asks the
  hub whether the caller is one (`SelfSubjectAccessReview` with the caller's token), until the
  backend answers that itself (`GetCurrentUser`, planned). Organization users' tokens are
  validated at the gateway only (ODH MS-0007), and never reach the console.
- Don't add a Service port, Route, NetworkPolicy exception or `0.0.0.0` bind for the backend, and
  don't weaken the BFF's gates, until the backend authenticates callers itself (ADR-0004). The
  chart's kind test (`hack/test-chart-kind.sh`: only `:8443` listens off loopback) and
  ai-grid-env-setup's `verify/07-console.sh` (the backend's ports on loopback, the Service's one
  port) check this.
- Every container in the pod mounts the ServiceAccount token today. Limiting it to
  kube-auth-proxy and the backend was left out of the MVP; the planned end state is the backend
  calling the hub with the caller's own token, then in a pod of its own.

## Known exceptions, to move behind the RPCs later

The BFF still derives or decides these itself. Do not add more; move these into the backend
when the RPCs allow it.

> Under [ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md) these do not move into
> the frontend — each one becomes a field in the contract or stays a backend derivation. A
> couple are resolved by the OSAC standard outright: it has first-class
> `metadata.display_name` and `metadata.description`, so `toModel` reading
> `openshift.io/display-name` goes away.

- The Connect relay allowlist (`allowedProcedures`, `bff/internal/relay/relay.go`): the relay
  passes only the reviewed procedures the console's API already offers, so every other procedure
  of the backend is 404 (`unimplemented`), a method the backend adds later included. The backend
  authorizes nothing itself, so without this list every one of its methods would be open to a
  provider admin. Left out on purpose: Clusters `Create` and `Delete`, which the console doesn't
  offer, and `Tenants/ListMembers`, because the console never lists an organization's members:
  one organization is one tenant, and the provider must not see a company's internals (decided
  2026-10-23). A new procedure needs a review and a line in the list, which also says whether it
  reads or writes (a write gets `BACKEND_WRITE_TIMEOUT`). Remove the list once the
  backend authorizes every RPC itself.
- `requireProviderAdmin` (`bff/internal/api/middleware.go`), the BFF's one authorization
  decision: every `/api/v1` call except `GET` (or `HEAD`) `/user` and `/config`, every Connect
  relay call and every Perses relay call needs the caller's `isProviderAdmin` review to pass (403
  otherwise), until the backend authorizes the caller. The review asks for `post` on the
  non-resource URL `/ai-grid/provider-console` (`hub.ProviderAdminCheck`). The chart's
  `ai-grid-provider-admin` ClusterRole grants it, and so does any role with a `*` nonResourceURLs
  rule for `post` (or every verb), such as cluster-admin; check a user with
  `oc auth can-i post /ai-grid/provider-console --as=<user> [--as-group=<group>]`
  (`oc adm policy who-can` can't evaluate non-resource URLs). Don't borrow another component's
  right for it, and don't make it `get`: ACM grants `patch` on ManagedClusters to every
  authenticated user, and OpenShift's `cluster-reader` may `get` every non-resource URL.

## Agent skills

Configuration for coding-agent workflows, in `docs/agents/` — not general documentation. Each
file answers a question a skill asks, in the form that skill expects, so changing one changes
agent behaviour. See [docs/agents/README.md](docs/agents/README.md).

`GLOSSARY.md` and `docs/adr/` are the exception: ordinary engineering documents, for people
first. Agents read them, and `docs/agents/domain.md` says how, but they are not written for
agents.

### Issue tracker

Issues live as GitHub issues in `ai-grid-cloud/ai-grid-provider-console`, driven through the
`gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and one `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
