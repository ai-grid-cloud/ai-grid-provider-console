# AI Grid Provider Console

The administrative interface a cloud provider uses to run an AI Grid: enrolling clusters,
onboarding organizations, deploying models across locations, and watching the result. It is
one of three faces of the product, alongside the organization administrator's and the end user's.

## Language

### The product

**AI Grid**:
A set of OpenShift clusters in different locations, serving models as one logical service
behind a shared gateway.
_Avoid_: the grid, fleet, mesh

**Provider admin**:
A person who administers the grid itself, as opposed to an organization's use of it. The console
shows or hides actions based on whether the caller is one. Backend enforcement is the target
([ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md)); today the BFF enforces this gate.
_Avoid_: cluster admin, superuser, operator

**Hub administrator**:
Whoever administers the hub cluster itself and grants access to it, including provider admin
access. Not the same as a provider admin: a provider admin runs AI Grid through the console, and
asks the hub administrator for that access. The console says "your hub administrator".
_Avoid_: administrator (alone), cluster admin

**Location**:
Where a cluster physically is, as a single label shared by everything in that place. Models
are deployed to locations in the console; underneath, a Placement selects grid clusters,
including by cluster set, labels, claims or a cluster count.
_Avoid_: datacenter, zone, geo

**Site**:
The name of the place a cluster is in, as the map and the Clusters pages show it: the hub
administrator's `ai-grid/site-name` annotation, or else the cluster's cloud region. A location
groups clusters for deploying models; a site names where they are.
_Avoid_: datacenter, zone

### Resources

**Cluster**:
An OpenShift cluster managed by the hub. Not every cluster is part of the grid.
_Avoid_: ManagedCluster, GridCluster, managed cluster, node

**Grid member**:
A cluster that has been enrolled in the grid and provisioned for it. The distinction matters:
the console lists every cluster the hub manages, but only members can host models. The UI says
"AI Grid cluster", and "member" only in code: in UI text it would read as a person.
_Avoid_: enrolled cluster, participating cluster, active cluster

**Role**:
What a Grid member does in AI Grid, from its `ai-grid/role` label. There are three. MaaS and
KServe are the tools the roles use; they are not the roles' names.
- **Ingress** (`ingress`): receives requests from organizations' users through MaaS and routes
  them to inference clusters.
- **Inference** (`inference`): serves models with KServe. Requests reach it through an ingress
  cluster.
- **Combined** (`combined`): does both: receives requests through MaaS and serves models.

_Avoid_: MaaS cluster, MaaS (ingress), gateway cluster, serving cluster

**Organization**:
A customer that consumes models through the grid. This name was agreed at the 2026-10-15
workstream standup and is used by the console and environment. The backend's `Tenants`
service is the legacy contract name for these Keycloak Organizations until it is renamed;
preserve existing API identifiers when referring to that contract.
_Avoid_: tenant (for this customer resource)

**Tenant scope**:
The owner of a resource, represented by the OSAC `metadata.tenant` field. This is distinct
from the Organization resource the console manages. It is unpopulated in the MVP, where only
provider admins reach the backend.

**Model**:
A deployed inference service, either on the hub alone or placed across grid members.
_Avoid_: ManagedModel, deployment, inference service

**Subscription**:
An organization's agreed access to a set of models, carrying its priority, rate limits and
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
among several. Authorization is still pending; see
[ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md) for the current boundary.
_Avoid_: API server, service, gRPC service, provider service

**Contract**:
The protobuf definition of the shapes the system exchanges. The backend is the target source
of truth ([ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md)); today the console
still carries its draft and generated copies during the migration.
_Avoid_: schema, API spec, proto definition, draft proto

**BFF**:
The console's own small server: it relays calls to the backend with the caller's token,
serves the single-page app, and answers for the console's configuration and health. That is the
target ([ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md)); today it also maps legacy API
shapes and enforces the provider-admin gate through a hub access review.
_Avoid_: proxy, gateway, middle tier, API layer

**Fake infrastructure**:
Stand-ins for the systems the backend talks to — a fake hub API and a fake Keycloak — so that
the **real** backend can run on a laptop without a cluster. Because the backend itself is not
faked, it cannot drift from what ships.
_Avoid_: fake backend, mock, stub, test server

**Fake backend**:
The legacy reimplementation of the draft contract, serving fixtures. It originated in the
console and now also exists in the backend during migration. Superseded by fake infrastructure
and being retired: it can drift from the real backend because it is a second implementation.
Use the term only for the thing being removed.
_Avoid_: using this for **fake infrastructure**, which is a different idea

**Hub**:
The cluster running ACM that manages all the others. The backend is its target API client
([ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md)); today the BFF also calls it for the
provider-admin access review.
_Avoid_: management cluster, control plane, local-cluster
