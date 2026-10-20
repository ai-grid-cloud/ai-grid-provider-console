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

- All 29 draft RPCs are reshaped and gain `option (google.api.http)` annotations, which the
  draft has none of today. Each annotation forces a URL design decision.
- The fake backend (`bff/internal/fakebackend`, ~6,900 lines) is **deleted, not relocated**.
  Superseded on 2026-10-20 by the backend's own `ai-grid-fake-infra`, which fakes the *hub and
  Keycloak* and runs the real backend against them — a reimplementation of the contract can
  drift from the real server, a fake hub cannot. Deletion waits until the backend implements
  Models, Subscriptions and Grid; until then those three areas have no fake but the console's
  own, and it stays.
- `mock/fixtures/` and `mock/fixtures-poc/` no longer stay put unchanged: the backend has
  converted their cluster and tenant objects into its own `fixtures/default/` and
  `fixtures/poc/` via `hack/convert-console-fixtures`. Models, subscriptions and presets were
  not converted, because nothing serves them. **Both copies now exist and will drift**;
  deciding which is canonical is outstanding.
- Deleted from this repository: `mock/proto/`, `bff/gen/`, `bff/internal/protodrift`,
  `mock/proto/upstream/`, and `.github/workflows/drift.yaml`.
- `hack/sync-upstream-proto.sh` survives, repointed at the real backend, because the frontend
  still needs the `.proto` files locally to generate TypeScript (ADR-0002).
- The standard has first-class `metadata.display_name` and `metadata.description`, which would
  remove one of the BFF's derivations — display name and description would stop being
  `openshift.io/*` annotations read by `toModel`. The backend's `Metadata` does **not** carry
  them yet (it has `creation_timestamp`, `deletion_timestamp`, `creator`, `tenant`, `name`,
  `labels`, `annotations`, `version`), so this is a field to add, not a field to adopt.
