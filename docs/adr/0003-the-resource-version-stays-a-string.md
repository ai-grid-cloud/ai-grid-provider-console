---
status: accepted
date: 2026-10-19
---

# The resource version stays a string

`mpaulgreen/osac-service-standards` specifies `metadata.version` as an `int32`,
"auto-incremented on every change". Our resources are Kubernetes objects read through ACM, and
a Kubernetes `resourceVersion` is an **opaque string**: the API server makes no guarantee that
it is numeric, ordered, or bounded, and clients are explicitly told to treat it as opaque and
only ever compare it for equality. We keep it as a string and deviate from the standard here.

The standard's shape is correct for the service it was written against, where Postgres owns the
row and therefore owns the counter. Our backend owns no counter; it forwards one. Conforming
would mean the backend inventing a second version number, stored alongside the object, that can
disagree with the hub's — and a stale-write check that passes while the object has in fact
changed. A silently wrong optimistic lock is worse than a documented deviation.

## This is not yet true of the backend

The backend has **already shipped `Metadata.version` as `int32`** (field 8), following the
standard. Nothing populates it yet, and `ClustersUpdateRequest.lock` is documented there as
"Not enforced yet", so the conflict is latent rather than live — but it is real, and it is in a
message shared by every resource.

Changing it is a breaking change to a shared type in a repository with other work in flight, so
it is not done as part of adding new services. New services use `Metadata` as it stands. The
change is tracked separately and must land before optimistic locking is implemented against
anything Kubernetes-backed, because the first implementation is what freezes the semantics.

Mark it in the proto with a `// buf:lint:ignore` comment and a pointer to this ADR, the same
escape hatch the standard provides for its object-shape rule.

## Consequences

- Reviewers coming from the standard will flag this; the comment in the proto is what stops it
  being "fixed".
- Comparison is equality only. No ordering, no arithmetic, no "is this newer than that".
- Tenants are the exception that proves the rule: Keycloak Organizations have no server-side
  version, so the backend maintains one itself in an organization attribute. That one *is* a
  counter the backend owns, and it is still exposed as a string for consistency.
