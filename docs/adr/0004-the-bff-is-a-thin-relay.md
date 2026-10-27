---
status: accepted
date: 2026-10-19
---

# The BFF is a thin relay, kept as the OSAC seam

Once the browser speaks Connect to the backend (ADR-0002), the BFF has no data to translate.
It keeps four core jobs: relaying Connect calls with the caller's token attached, serving the SPA,
answering `/healthcheck` and `/readyz`, and serving the console's own configuration. Its
legacy request mapping goes away. The optional Perses integration has a separate relay,
which remains an explicit BFF responsibility until an alternative is agreed.

**Relaying means proxying, not re-implementing.** The BFF is an `httputil.ReverseProxy` with a
Director that attaches the caller's identity. In the target architecture it does not compile
against the contract: a new RPC needs no change here.

A first attempt got this wrong. It was built and discarded before merging, and is recorded
only because the failure mode is easy to repeat. Before the backend served Connect, the BFF
terminated Connect itself and forwarded over gRPC using generated connect-go handlers. That
works, and it unblocked the frontend without waiting for another repository — but it needs
**one hand-written passthrough method per RPC**: seven at the time, around twenty-five once
Models, Subscriptions and Grid land. That is the same duplication this whole migration exists
to remove, just relocated. A proxy has no per-RPC cost at all.

It was cheap to reverse for one reason worth remembering: the browser's Connect calls are
byte-identical either way, so nothing in the frontend had to change.

It is not deleted, for a reason that is not about this console: **OSAC's UI has a proxy layer
of its own, and this BFF is the seam that layer later replaces.** Deleting it now would mean
rebuilding it to integrate with OSAC.

## Target boundaries

- The backend owns the REST routes under `/api/v1/*`. The BFF's own endpoints move to
  `/console/*` so no path is served by two things.
- `isProviderAdmin` moves to the backend, proposed as `GetCurrentUser`, once the backend can
  authenticate and authorize the caller. The identity mechanism remains to be agreed below.
  Once that replaces the BFF's `SelfSubjectAccessReview`, `bff/internal/hub` can be deleted.
- The BFF keeps no credential, reads no cluster, and makes no authorization decision.

## Current boundary (verified 2026-10-27)

The BFF still maps legacy JSON requests and responses. Its `requireProviderAdmin` middleware
asks the hub for a `SelfSubjectAccessReview` with the caller's token and requires permission
to patch ManagedClusters. Every `/api/v1` call except `GET` or `HEAD` on `/user` and `/config` passes this gate.
The `/perses/api/` relay also uses it. The BFF keeps its hub client
and this authorization decision until backend enforcement can replace them. Perses also
remains an outbound dependency, so removing the hub access review alone would not leave the
BFF with only a backend connection.

## Backend authorization: ownership accepted, impersonation proposed

`docs/plan/bff-api.md` has always said "the backend decides what the caller may do". The
backend does not: since [backend PR #9](https://github.com/ai-grid-cloud/ai-grid-provider-backend/pull/9)
it constructs `connect.NewServer()` with no authentication or authorization interceptor
(`cmd/ai-grid-provider-backend/main.go`) and talks to Kubernetes with its own ServiceAccount
(`rest.InClusterConfig()`). The BFF forwards a bearer token nothing in the backend reads.
Every caller that reaches the backend acts with the ServiceAccount's full authority. The
BFF gate protects the console path; it does not authorize direct backend clients.

One **proposed** model for provider admins is: kube-auth-proxy authenticates, the BFF forwards
the token, and the backend validates it and impersonates the caller against the hub. Hub RBAC
would then decide. The fake's `viewer-token` → 403 and `expired-token` → 401 cases exercise
expected outcomes, not agreement on this mechanism.

That proposal deviates from the standard, which specifies JWT validation plus OPA/Rego policy
with tenancy from the `organization` claim. Hub impersonation could reuse existing RBAC for
provider admins rather than maintaining a second policy. The standard's tenant-scoping
invariant is unimplemented because the MVP is single-tenant.

The [draft ODH shared OIDC identity contract and gateway layout](https://github.com/opendatahub-io/architecture-decision-records/pull/175)
put token validation at the gateway, identify users by `iss` plus `sub`, and create no
Kubernetes identity for organization users. Those users cannot simply be assumed to have a
hub identity to impersonate. Provider-admin access and organization-user access need an
explicitly agreed boundary.

RJ and the backend team, together with Lindani and Andrew for the OIDC integration, need to
agree where tokens are validated, how provider-admin authority is established, and whether
hub impersonation applies. The accepted thin-relay decision does not settle these questions.

**Backend authentication and authorization remain unimplemented.** Direct backend access
needs an authorization boundary before it can safely serve untrusted callers.

The merged Git write path (backend PR #29) removed the public backend Routes and their
cluster-mode write permissions. It does not add authentication: the backend still needs to
remain behind the console's authenticated, authorized path. The proposed `GetCurrentUser`
and impersonation work have not shipped.
