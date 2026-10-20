# Working in this repository

Rules for every coding agent (and person) changing this repository. There is no root
`CLAUDE.md`; this file applies to all agents. To build console pages against the fake backend,
read [mock/AGENTS.md](mock/AGENTS.md).

## This architecture is being replaced

On 2026-10-19 we decided to consolidate the contract into the backend and move the console to
Connect end to end. **Nothing below has changed yet** — the rules in this file are still the
rules, and work landing today should follow them. But do not invest in the parts that are
going away, and read the decisions before designing anything new:

- [ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md): the contract lives in
  `ai-grid-cloud/ai-grid-provider-backend`, reconciled to the OSAC service standards. The
  console's draft proto, the vendored upstream copy and the drift machinery are deleted.
- [ADR-0002](docs/adr/0002-connect-end-to-end-with-vanguard-for-rest.md): the browser speaks
  Connect; the backend serves Connect, gRPC, gRPC-Web and REST from one handler via vanguard.
  The JSON envelope, the `ETag`/`If-Match` protocol and the hand-written TypeScript go away.
- [ADR-0003](docs/adr/0003-the-resource-version-stays-a-string.md): a deliberate deviation from
  the standard, because a Kubernetes `resourceVersion` is opaque.
- [ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md): the BFF keeps only relaying, static
  assets, health and console config — and is kept as the seam OSAC's proxy layer replaces.

Two things are worth knowing before you touch anything in `bff/internal/api` or
`frontend/src/api`: every shape in this repository is currently declared four times (contract,
BFF structs, `frontend/src/api/types.ts`, UI types), with `toGridCluster` existing in both Go
and TypeScript; and the backend performs **no authentication or authorization at all** today,
so the token the BFF forwards is read by nothing (ADR-0004).

Use the vocabulary in [GLOSSARY.md](GLOSSARY.md). Three concepts have two or three names in
the code right now; the glossary says which one wins.

## The BFF does transport only

The console is a React frontend, a thin Go BFF (`bff/`) and `ai-grid-provider-backend`, a gRPC
service in its own repository, `ai-grid-cloud/ai-grid-provider-backend`
(`docs/plan/bff-api.md`). The backend is meant to be a provider API that
stands on its own: a CLI, GitOps tooling and other UIs will call it without the BFF. So anything
that decides what data means, or what a request may do, belongs in the backend; if it lived in
the BFF, every other client would have to copy it. The draft proto also follows OSAC's
conventions (`mock/research/backend-conventions.md`): a List request carries only `offset`,
`limit`, `filter` (CEL) and `order`, and an Update replaces a map field as a whole (FieldMask
semantics, no `labels.<key>` paths). The client writes the CEL filter and edits the map it
loaded; the BFF forwards both unchanged; the backend evaluates the filter and applies the update
under optimistic locking.

What the BFF does:

- decodes request bodies strictly: exactly one JSON object, no unknown fields, at most 1 MiB;
- answers 415 for a POST, PATCH or PUT that is not `application/json`;
- requires `If-Match` on PATCH and DELETE (428 without it) and maps it to the request's version
  field (`resource_version`, with `lock: true` where the RPC has one);
- maps query parameters to the List request (`offset`, `limit`, `filter` as sent);
- maps gRPC codes to HTTP statuses, keeping the backend's message, and its own body errors to 422;
- forwards the caller's identity (the token as `authorization`, plus user, email and groups);
- serves the SPA, `/healthcheck`, `/readyz`, `/api/v1/config`, and asks the hub for
  `isProviderAdmin` (a `SelfSubjectAccessReview` with the caller's token).

What belongs in the backend, and so in the fake (`bff/internal/fakebackend`) until the backend
ships it: validation of values, normalization and defaults, resource versions and the
precondition check, list filtering, ordering and counting, deciding whether an update changes
anything, which keys a caller may change, and every field derived from other fields. Every object
the backend returns carries a non-empty `resource_version`: with `If-Match` required, an object
without one could never be updated or deleted.

## Adding a feature

> Superseded in direction by [ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md):
> once the contract moves, step 1 happens in the backend repository and there is no draft to
> reconcile. Until then, the steps below are still how a feature lands — but a new RPC drafted
> now will have to be reshaped to OSAC conventions, so agree the shape with the backend first
> and draft it there if you can.

Follow `mock/proto/README.md`, "Working with the backend team":

1. Draft the RPC or field in `mock/proto/ai_grid/v1`, then run `make -C bff generate`.
2. Implement it in the fake, with the source of each behaviour cited next to the code, and test it
   there.
3. Map it in the BFF (`bff/internal/api`): transport only, as above. Add it to
   `docs/plan/bff-api.md`.
4. Build the page against it (`frontend/`).

Afterwards run `make -C bff golden` when the BFF's JSON or a fixture changed, and update the
docs (`docs/plan/bff-api.md`, `mock/AGENTS.md`, `mock/areas/*.md`) in the same change.

## Known exceptions, to move behind the RPCs later

The BFF still derives or decides these itself. Do not add more; move these into the backend
when the RPCs allow it.

> Under [ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md) these do not move into
> the frontend — each one becomes a field in the contract or stays a backend derivation. A
> couple are resolved by the OSAC standard outright: it has first-class
> `metadata.display_name` and `metadata.description`, so `toModel` reading
> `openshift.io/display-name` goes away. `requireTotal` goes away with the shipped backend it
> exists to tolerate.

- `toGridCluster` (`bff/internal/api/clusters.go`): `aiGridEnabled` and `provisioned` (the
  `ai-grid/enabled` and `ai-grid/provisioned` labels equal to `"true"`), `location`, `site`,
  `region` and `openshiftVersion` from labels; `siteName`, `latitude` and `longitude` from the
  `ai-grid/site-name`, `ai-grid/latitude` and `ai-grid/longitude` annotations, with coordinates
  that do not parse or are out of range left out; `consoleUrl`, `platform` and `product` from
  cluster claims; `gpuCapacity` from `status.capacity["nvidia.com/gpu"]`; `addons` from the
  `feature.open-cluster-management.io/addon-*` labels; the list sorted by name.
- `fetchCluster`: against a backend without `GetManagedCluster` (the shipped one), the BFF
  filters `ListManagedClusters` by name and writes its own NotFound message.
- `toTenant` (`bff/internal/api/tenants.go`), fallbacks for the shipped backend: `alias`
  defaults to the name, `enabled` defaults to true, `domainDetails` is built from `domains`.
- `toModel` (`bff/internal/api/models.go`): `displayName` and `description` from the
  `openshift.io/display-name` and `openshift.io/description` annotations; `modelName` defaults to
  the model name; `placement.selectedClusters` from the decisions; `placement.satisfied`,
  `reason` and `message` from `PlacementSatisfied`; `rollout.rolledOut`, `applied` and `reason`
  from `PlacementRolledOut` and `ManifestworkApplied`; each work's `applied`, `available`,
  `progressing` and `degraded` from its conditions and `feedback` from the manifest feedback
  values; `rollout.strategy` shown as `All` when unset.
- `fromRolloutSpec`: parses the rollout strategy name into the enum and answers 422 for an
  unknown one.
- The model create (`createModel`): `cpu`, `memory` and `gpuCount` become the main container's
  requests (the GPU also its limit, a negative `gpuCount` is 422); `scaling` becomes a KEDA
  block; the gateway defaults to `openshift-ingress/openshift-ai-inference`; the managed route
  and the scheduler are always on.
- `requireTotal` (`bff/internal/api/respond.go`): a list answer without `total` comes from a
  backend that ignored `filter`, `offset` and `limit` (the shipped one), so the BFF answers 501
  when the caller sent any of them; without them `listMeta` falls back to a total it can prove.
  This is compatibility with the shipped backend, not filtering.

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
