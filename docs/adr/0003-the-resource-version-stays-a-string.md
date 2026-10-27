---
status: proposed
date: 2026-10-19
---

# Proposal: expose resource versions as strings

`mpaulgreen/osac-service-standards` specifies `metadata.version` as an `int32`,
auto-incremented on every change. Kubernetes-backed resources carry a `resourceVersion` that
clients must treat as an **opaque string**, comparing it only for equality. This ADR proposes
exposing that string unchanged, as a deviation from the standard. The backend team still needs
to agree the shared contract change; the backend currently ships `int32` versions.

The standard's counter fits a service that owns its stored rows. For clusters, our backend
forwards the hub's version. A separate counter would need to stay synchronized with changes
made outside the backend; converting the hub's version to `int32` already loses values that
do not fit. Passing the opaque value through would preserve the hub's concurrency semantics.

## What has shipped (verified 2026-10-27)

The backend exposes `Metadata.version` as `int32` (field 8). In
`internal/servers/managed_cluster_mapper.go`, `resourceVersionToVersion` parses the hub's
resource version as `int32`; overflow, negative or nonnumeric values map to zero.

`Clusters.Update` in `internal/servers/clusters_server.go` enforces optimistic locking:
`lock: true` without a nonzero version is `InvalidArgument`, and a nonzero version that
differs from the current hub resource version is `Aborted`. The version also goes into the
Kubernetes merge patch so a concurrent hub change can fail the write. The console BFF already
maps `If-Match` through its draft `resource_version` to this integer field. A version mapped
to zero cannot be used for a locked update; without a version, an unlocked update skips the
version precondition.

[Backend PR #16](https://github.com/ai-grid-cloud/ai-grid-provider-backend/pull/16) merged on
2026-10-23 and added organization versions. Keycloak supplies no version, so the backend stores
its own counter in the `ai-grid/resource-version` organization attribute and exposes it through
the same `int32` metadata field. Organizations without a valid stored counter read as version
1. Update and Delete require a version and reject stale versions. Backend writes are serialized
within one process; edits made directly in Keycloak do not advance this counter.

Models and Subscriptions now use backend-owned counters as well: in Git mode, the backend
stores `ai-grid/version` on each resource's YAML and returns it as `metadata.version`.
A supplied nonzero version is checked on Update and Delete; `lock: true` on Update requires
one. These counters are distinct from both Kubernetes resource versions and Git commit SHAs.

## Proposed change and consequences

- Agree a migration for the shared `Metadata.version` field and version-bearing requests with
  the backend team. Changing the protobuf field type is breaking and affects clients and
  existing locks, so new services continue to use the shipped contract until that migration.
- For Kubernetes resources, return the opaque version and compare it only for equality.
  No ordering or arithmetic is needed.
- Organization, Model and Subscription versions remain backend-owned counters, proposed as strings
  for consistency with the shared metadata type.
- If agreed, document the standard deviation in the proto with the applicable lint exception
  and a pointer to this ADR.
