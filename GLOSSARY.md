# AI Grid Provider Console

The administrative interface a cloud provider uses to run an AI Grid: enrolling clusters,
onboarding organizations, deploying models across clusters, and watching the result. It is
one of three faces of the product, alongside the organization administrator's and the end user's.

## Language

### The product

**AI Grid**:
A set of OpenShift clusters in different locations, serving models as one logical service
behind a shared gateway. The name stays "AI Grid" (capital G). Running sentences say "the AI Grid";
labels and action names have no article ("Add to AI Grid", "AI Grid cluster").
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

**Region**:
The geographic area a cluster runs in: today the cloud region ACM reports (the
`region.open-cluster-management.io` claim). Used for grouping and for the map's fallback
position; models are not placed by it.
_Avoid_: location, geo, zone

**Site**:
The name a hub administrator gives a cluster's place (annotation `ai-grid/site-name`), shown as Site on
the Clusters pages and the AI Grid map; empty when the annotation isn't set,
never the region. The cluster's `ai-grid/site` label is its Site ID. The console doesn't edit it:
a hub administrator sets it, and the map position, with `oc annotate`.
_Avoid_: data center, location

**Location label**:
The cluster's `location` label, which Add to AI Grid and Edit write. Nothing in delivery or routing
reads it; models are placed on clusters by name. Whether it becomes the grid's region is open.
_Avoid_: location (alone)

### Resources

**Cluster**:
An OpenShift cluster managed by the hub. Not every cluster is part of the grid. Models are
deployed to clusters, chosen by name. Its status is Ready, Unavailable or Unknown: Unavailable when
the cluster's agent reports it unavailable (the backend's `OFFLINE`, which ACM's console calls
Offline; for example, its API server is down), though it may still be serving. A cluster the hub
can't reach (no current report from its agent, the backend's `UNKNOWN`) is Unknown.
_Avoid_: ManagedCluster, GridCluster, managed cluster, node, location; Offline (for the status)

**Grid member**:
A cluster that has been enrolled in the grid and provisioned for it. The distinction matters:
the console lists every cluster the hub manages, but only members can host models. The UI says
"AI Grid cluster", and "member" only in code: in UI text it would read as a person.
_Avoid_: enrolled cluster, participating cluster, active cluster

**Role**:
What a Grid member does in AI Grid, from its `ai-grid/role` label. There are three. MaaS and
KServe are the tools the roles use; they are not the roles' names.
- **Ingress** (`ingress`): the cluster receives requests via Models-as-a-Service and routes those
  requests to inference clusters.
- **Inference** (`inference`): the cluster serves models via KServe and receives requests through
  an ingress cluster.
- **Ingress and inference** (`combined`): the cluster receives requests via Models-as-a-Service and
  serves models via KServe. The label was Combined; the value stays `combined`.

A provider admin sets a cluster's role with Add to AI Grid or Edit, while the cluster has none.
The console doesn't change a role a cluster has: the hub doesn't yet fully remove what the old role
installed. Remove keeps the role, so Add shows it read-only, as Edit does.

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

**Hardware**:
What a model runs on, selected when it is deployed: one entry of the list the provider admin sets
in the console's Helm values (`console.models.hardware`), such as NVIDIA GPU or CPU only. An entry
sets the model's runtime image, environment and starting resources, and the accelerator it
requests per replica. It is not a cluster property: the console doesn't check that a chosen cluster
has the hardware, beyond a hint from its NVIDIA GPU count. A deployed model's pages show what it
requests (its accelerators and image), since the list can change; its edit starts on the entry
whose accelerator the model requests, if any, and selecting another entry applies that one.
_Avoid_: model server, preset, accelerator profile, hardware profile

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
The protobuf definition of the shapes the system exchanges. The backend is its source of truth
([ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md)); the console generates its
TypeScript from it (`frontend/src/gen`) and carries no copy of its own.
_Avoid_: schema, API spec, proto definition, draft proto

**BFF**:
The console's own small server: it relays calls to the backend with the caller's token,
serves the single-page app, and answers for the console's configuration and health
([ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md), `docs/bff.md`); today it also enforces
the provider-admin gate through a hub access review.
_Avoid_: proxy, gateway, middle tier, API layer

**Fake infrastructure**:
Stand-ins for the systems the backend talks to — a fake hub API and a fake Keycloak — so that
the **real** backend can run on a laptop without a cluster (`make dev-fake`, the browser
tests). Because the backend itself is not faked, it cannot drift from what ships.
_Avoid_: fake backend, mock, stub, test server

**Fake backend**:
The legacy reimplementation of the draft contract, serving fixtures. The console's copy is
removed; the backend still carries one (its draft fake) during migration. Superseded by fake
infrastructure: it can drift from the real backend because it is a second implementation. Use
the term only for that legacy thing. The BFF's `--fake-backend` flag, and the console's
fake-backend banner, predate the change and now mean the backend runs on fake infrastructure.
_Avoid_: using this for **fake infrastructure**, which is a different idea

**Hub**:
The cluster running ACM that manages all the others. The backend is its target API client
([ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md)); today the BFF also calls it for the
provider-admin access review.
_Avoid_: management cluster, control plane, local-cluster
