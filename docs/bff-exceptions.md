# What the BFF still derives itself

Reference for anyone touching `bff/internal/api`. Pointed at from `AGENTS.md`; not loaded
unless you are changing one of these.

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
