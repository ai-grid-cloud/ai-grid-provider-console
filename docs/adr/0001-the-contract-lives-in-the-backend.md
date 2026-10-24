---
status: accepted
date: 2026-10-19
---

# The contract lives in ai-grid-provider-backend

The console carried its own draft of `ai_grid.v1` (`mock/proto/ai_grid/v1`, 29 RPCs), proposed
shapes to "the backend team" as numbered proposals, vendored their proto and ran a nightly
drift test to detect when they changed it. That apparatus assumed a boundary we do not have:
`ai-grid-cloud/ai-grid-provider-backend` is a sibling repository in our own organisation. It
also already declares an incompatible `ai_grid.v1` — `Clusters/List` against our
`ManagedClusters/ListManagedClusters`, both serving `/api/v1/clusters` — so the two were not
converging, they were diverging. The backend's proto becomes the single source of truth,
reconciled to the OSAC service standards, and the console deletes its draft.

## Considered options

- **Keep both protos, compare them periodically.** Rejected: they already answer the same URLs
  with different shapes, and a comparison is not a decision. The console was additionally
  vendoring and drift-testing against `yuvalturg/ai-grid-backend` — a third repository that is
  not the backend — so the drift job was green while real divergence accumulated.
- **The console's draft wins.** Rejected: it is richer (Models, Subscriptions, Grid) but has no
  constituency outside this repository, and the backend's own `AGENTS.md` mandates OSAC
  conventions, which the draft does not follow.
- **Consolidate onto the backend's proto.** Chosen. It is the contract other clients will use,
  it already follows the standard, and it is the only version where "replace the fake with real
  data" is a configuration change rather than a console rewrite.

## What reconciling means

Per `mpaulgreen/osac-service-standards`: plural service names with no suffix (`Clusters`),
methods `List`/`Get`/`Create`/`Update`/`Delete`, messages `{Service}{Method}Request`, the
object shape `id + metadata + spec + status` (lint-enforced by the custom `OSAC_OBJECT_SHAPE`
rule), `offset`/`limit`/`filter` (CEL)/`order` on list requests, `size`/`total`/`items` on list
responses, `buf.validate` for field rules with cross-resource checks in server logic, and
enums as `UPPER_SNAKE_CASE` with a type prefix starting at `_UNSPECIFIED = 0`. URLs are flat
under `/api/grid/v1/`.

Two deliberate deviations: the resource version stays a string (ADR-0003), and the standard's
tenant-scoping invariant is unimplemented because the MVP is single-tenant. Both are recorded
rather than silently skipped.

## Consequences

- All 29 draft RPCs eventually gain `option (google.api.http)` annotations, which the draft has
  none of today. Each annotation forces a URL design decision.
- The draft moves to the backend and the console stops carrying it: `mock/proto/`, `bff/gen/`
  and `bff/internal/fakebackend` go, and the console imports the contract from the backend at a
  pinned commit.
- The standard has first-class `metadata.display_name` and `metadata.description`, which would
  remove one of the BFF's derivations — display name and description would stop being
  `openshift.io/*` annotations read by `toModel`. The backend's `Metadata` does **not** carry
  them yet (it has `creation_timestamp`, `deletion_timestamp`, `creator`, `tenant`, `name`,
  `labels`, `annotations`, `version`), so this is a field to add, not a field to adopt.

## How it is actually being delivered (2026-10-22)

The decision stands; the route to it is not the one sketched above, and the differences are
worth recording because each is a better answer than the original.

- **The draft is not reshaped up front.** Backend PR #10 lands it as a separate
  `ai_grid.draft.v1` package served on its own port, and deletes it **area by area** as the
  real backend implements each. Reconciling all 29 RPCs to OSAC conventions before anything
  works would have blocked every page on one large change; this keeps the other pages running
  meanwhile.
- **The fake is relocated, not deleted.** It moves to `internal/fakeinfra/draft/` and the
  fixtures to `fixtures/draft/{default,poc}`. An earlier move (backend PR #7) already converted
  the cluster and tenant fixtures for `ai-grid-fake-infra`, which fakes the *hub and Keycloak*
  and runs the real backend against them. The two coexist deliberately: the fake infrastructure
  serves the areas the backend implements, the draft fake serves the ones it does not.
- **The drift guard was repaired, not removed.** It had been pointed at
  `yuvalturg/ai-grid-backend` and was green against a repository nobody ships. Rather than
  delete it, the console repointed it at `ai-grid-cloud/ai-grid-provider-backend`,
  `path=proto/ai_grid/v1`. A guard aimed at the right target earns its place; deleting it would
  have removed the signal along with the false assurance.
- `hack/dev-backend.sh` is gone, replaced by `hack/forward-backend.sh`, which forwards to the
  backend deployed on the hub instead of cloning and running it locally.
