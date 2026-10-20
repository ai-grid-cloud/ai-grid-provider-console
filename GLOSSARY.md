# AI Grid Provider Console

The administrative interface a cloud provider uses to run an AI Grid: enrolling clusters,
onboarding tenants, deploying models across locations, and watching the result. It is one of
three faces of the product, alongside the tenant administrator's and the end user's.

## Language

### The product

**AI Grid**:
A set of OpenShift clusters in different locations, serving models as one logical service
behind a shared gateway.
_Avoid_: the grid, fleet, mesh

**Provider admin**:
A person who administers the grid itself, as opposed to a tenant's use of it. The console
shows or hides actions based on whether the caller is one; the backend enforces it.
_Avoid_: cluster admin, superuser, operator

**Location**:
Where a cluster physically is, as a single label shared by everything in that place. Models
are placed on locations, not on clusters.
_Avoid_: datacenter, zone, geo

### Resources

**Cluster**:
An OpenShift cluster managed by the hub. Not every cluster is part of the grid.
_Avoid_: ManagedCluster, GridCluster, node, site

**Grid member**:
A cluster that has been enrolled in the grid and provisioned for it. The distinction matters:
the console lists every cluster the hub manages, but only members can host models.
_Avoid_: enrolled cluster, participating cluster, active cluster

**Tenant**:
An organization that consumes models through the grid. Keycloak stores one as an Organization
and the console has called it that in places; the contract calls it a tenant and so do we.
_Avoid_: Organization, org, customer, account

**Model**:
A deployed inference service, either on the hub alone or placed across grid members.
_Avoid_: ManagedModel, deployment, inference service

**Subscription**:
A tenant's agreed access to a set of models, carrying its priority, rate limits and
authorization policy.
_Avoid_: plan, entitlement, tier

**Placement**:
The rule that selects which grid members a model should run on. It selects; it does not
deploy.
_Avoid_: scheduling, targeting, affinity

**Rollout**:
How a placed model reaches its selected members — all at once, or progressively with limits on
concurrency and failure.
_Avoid_: deployment strategy, release, rollout strategy

### Components

**Backend**:
`ai-grid-provider-backend`. The provider API: it owns every decision about what data means and
what a request may do, and it is designed to stand on its own, with the console as one client
among several.
_Avoid_: API server, service, gRPC service, provider service

**Contract**:
The protobuf definition in the backend, which is the single declaration of every shape the
system exchanges. There is no second copy.
_Avoid_: schema, API spec, proto definition, draft proto

**BFF**:
The console's own small server: it relays calls to the backend with the caller's token,
serves the single-page app, and answers for the console's configuration and health. It
translates nothing and decides nothing.
_Avoid_: proxy, gateway, middle tier, API layer

**Fake infrastructure**:
Stand-ins for the systems the backend talks to — a fake hub API and a fake Keycloak — so that
the **real** backend can run on a laptop without a cluster. Because the backend itself is not
faked, it cannot drift from what ships.
_Avoid_: fake backend, mock, stub, test server

**Fake backend**:
The console's own reimplementation of the contract, serving fixtures. Superseded by fake
infrastructure and being retired: it can drift from the real backend precisely because it is a
second implementation. Use the term only for the thing being removed.
_Avoid_: using this for [[fake infrastructure]], which is a different idea

**Hub**:
The cluster running ACM that manages all the others. Only the backend talks to it.
_Avoid_: management cluster, control plane, local-cluster
