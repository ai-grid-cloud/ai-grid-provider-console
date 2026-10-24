---
status: accepted
date: 2026-10-19
---

# The BFF is a thin relay, kept as the OSAC seam

Once the browser speaks Connect to the backend (ADR-0002), the BFF has no data to translate.
It keeps four jobs: relaying Connect calls with the caller's token attached, serving the SPA,
answering `/healthcheck` and `/readyz`, and serving the console's own configuration. Its
~2,550 lines of request mapping go away.

**Relaying means proxying, not re-implementing.** The BFF is an `httputil.ReverseProxy` with a
Director that attaches the caller's identity. It does not compile against the contract at all,
which is the strongest form of "transport only": a new RPC needs no change here.

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

## Boundaries

- The backend owns `/api/grid/v1/*`. The BFF's own endpoints move to `/console/*` so no path is
  served by two things.
- `isProviderAdmin` moves to the backend as `GetCurrentUser`. The backend holds the caller's
  token and acts as them on the hub, so it is better placed to answer "who am I and what may I
  do" than a BFF making its own `SelfSubjectAccessReview`. This lets `bff/internal/hub` be
  deleted — the BFF's last outbound dependency and its only credential-adjacent code.
- The BFF keeps no credential, reads no cluster, and makes no authorization decision.

## Authorization moves to the backend, and does not exist yet

`docs/plan/bff-api.md` has always said "the backend decides what the caller may do". The
backend does not: it constructs its gRPC server with no interceptors
(`cmd/ai-grid-provider-backend/main.go`) and talks to Kubernetes with its own ServiceAccount
(`rest.InClusterConfig()`). The BFF forwards a bearer token nothing reads, and every caller
acts with the ServiceAccount's full authority.

The agreed model is: kube-auth-proxy authenticates, the BFF forwards the token, and the backend
validates it and **impersonates the caller** against the hub. The hub's RBAC then decides, which
is what the fake has simulated all along (`viewer-token` → 403, `expired-token` → 401) and what
the UI already expects.

This deviates from the standard, which specifies JWT validation plus OPA/Rego policy with
tenancy from the `organization` claim. That design fits a service that owns its data; ours
proxies a cluster that already has RBAC, and impersonation means inheriting it rather than
keeping a second policy in sync. The standard's tenant-scoping invariant is unimplemented
because the MVP is single-tenant.

**This is tracked as a backend issue and blocks any non-fake deployment.**
