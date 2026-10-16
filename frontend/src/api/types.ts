// Response shapes of the BFF. Keep in sync with docs/plan/bff-api.md.

export type User = {
  username: string;
  email?: string;
  groups: string[];
  /** UI hint only; the backend enforces authorization. */
  isProviderAdmin: boolean;
};

export type ConsoleConfig = {
  gridEndpoint: string;
  mapTileUrl: string;
  mapTileAttribution: string;
  billingUrl: string;
  version: string;
  /** The namespace the deploy wizard creates models in. */
  modelsNamespace: string;
  /** The BFF talks to the fake backend; the UI shows a banner. */
  fakeBackend: boolean;
};

export type ClusterStatus = 'Ready' | 'Offline' | 'Unknown';

/** The ACM console's word for a cluster that is neither ready, offline, nor unknown. */
export type ClusterState = 'Pending import' | 'Importing' | 'Import failed' | 'Detaching' | 'Not accepted';

export type ProvisioningStatus = 'Provisioned' | 'Provisioning' | 'Not provisioned';

/**
 * A cluster as the BFF sends it (PR 12's `GridCluster` in bff/internal/api/clusters.go),
 * limited to the fields the console reads. `toGridCluster` in adapters.ts maps it.
 */
export type ApiCluster = {
  name: string;
  aiGridEnabled: boolean;
  provisioned: boolean;
  hubAcceptsClient?: boolean;
  location?: string;
  site?: string;
  region?: string;
  siteName?: string;
  latitude?: number;
  longitude?: number;
  openshiftVersion?: string;
  /**
   * ready, offline, unknown, pendingimport, importing, importfailed, detaching, or
   * notaccepted; absent when the backend reports no state.
   */
  status?: string;
  statusMessage?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
};

/** A ManagedCluster as the console shows it; the PoC's GridCluster plus the hub fields. */
export type GridCluster = {
  name: string;
  /** The PoC's availability; every ACM state other than ready and offline is Unknown. */
  status: ClusterStatus;
  /** The ACM state behind an Unknown status, such as Importing. */
  state?: ClusterState;
  /** The backend's explanation of the state. */
  statusMessage?: string;
  aiGridEnabled: boolean;
  provisioned: boolean;
  provisioningStatus: ProvisioningStatus;
  hubAcceptsClient: boolean;
  location?: string;
  site?: string;
  region?: string;
  siteName?: string;
  /** Latitude and longitude are both present or both absent. */
  latitude?: number;
  longitude?: number;
  openshiftVersion?: string;
  resourceVersion?: string;
  labels: Record<string, string>;
};

// The PoC's grid overview (shared/grid-monitoring.mjs gridOverviewSchema at 62319b8).
export type GridRange = '1h' | '6h' | '24h';

export type MetricStatus = 'ok' | 'unavailable' | 'not-configured' | 'no-data';

/** A sample at a Unix time in seconds. */
export type MetricPoint = { timestamp: number; value: number };

/** One fleet-wide series, such as `requests` in req/s. */
export type GridMetric = {
  key: string;
  label: string;
  unit: string;
  /** Absent when the backend doesn't say. */
  status?: MetricStatus;
  /** Why there are no points, when status is not ok. */
  message?: string;
  points: MetricPoint[];
};

export type GridOverview = {
  /** Absent when the backend doesn't send a time. */
  updatedAt?: string;
  /** Absent when the backend doesn't say. */
  inventorySource?: 'acm' | 'git' | 'demo';
  /** True only for the PoC's browser demo; the BFF always sends false. */
  demo: boolean;
  /** `demo`: simulated, because the backend has no Thanos configured. */
  metricsSource?: 'thanos' | 'demo';
  clusters: GridCluster[];
  metrics: GridMetric[];
};

// The PoC's tenant types (src/app/types/tenants.ts at 62319b8) as organizations,
// with the id the backend assigns and resourceVersion for the PoC's revision.
export type OidcConfig = {
  clientId: string;
  /** Only the name of the Secret holding the client secret; never the secret itself. */
  clientSecretSecret: { name: string };
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  defaultScopes: string;
  userInfoUrl: string;
  jwksUrl: string;
  logoutUrl: string;
  validateSignature: boolean;
};

export type IdentityProvider = { title: string; description: string; enabled: true; config: OidcConfig };

export type OrganizationInput = { name: string; domains: string[]; identityProvider: IdentityProvider };

/**
 * An organization as the pages read it. `identityProvider` is absent for an organization
 * created without one (by another client, or before the backend stored one).
 */
export type Organization = Omit<OrganizationInput, 'identityProvider'> & {
  id: string;
  identityProvider?: IdentityProvider;
  /** "Saved" for an enabled organization, as the PoC shows every saved one; "Disabled" otherwise. */
  status: 'Saved' | 'Disabled';
  /** Opaque; sent back as If-Match on update and delete. Empty when the backend sends none. */
  resourceVersion: string;
  /** When the backend created it; empty when it doesn't know. */
  creationTimestamp: string;
};

/**
 * A tenant of GET /api/v1/tenants (PR 12's JSON plus the identity provider, proposal P1).
 * The pages read it through toOrganization.
 */
export type ApiTenant = {
  id: string;
  name: string;
  alias?: string;
  enabled: boolean;
  description?: string;
  domains: string[];
  domainDetails?: { name: string; verified: boolean; identityProviderAlias?: string; autoRedirect: boolean }[];
  attributes?: Record<string, string>;
  resourceVersion?: string;
  createTime?: string;
  identityProvider?: {
    title?: string;
    description?: string;
    /** Absent means true. */
    enabled?: boolean;
    config?: Partial<OidcConfig>;
  };
};

// The PoC's model types (src/app/types/models.ts and MaaSModelRefSummary in
// src/app/types/subscriptions.ts at 62319b8), with resourceVersion for the PoC's revision.
export type ModelReference = { kind: string; name: string };

/** The body of POST /api/v1/models; the PoC's CreateModelRequest. */
export type CreateModelRequest = {
  name: string;
  displayName: string;
  description?: string;
  modelUri: string;
  modelName: string;
  runtimeImage: string;
  replicas: number;
  cpu: string;
  memory: string;
  gpuCount: number;
  runtimeArgs: string[];
  locations: string[];
};

/**
 * The body of POST /api/v1/models: the keys of PR 12's `ModelCreate` (bff/internal/api/models.go)
 * that the wizard sets, and no others. `toModelCreate` in adapters.ts builds it.
 */
export type ApiModelCreate = {
  name: string;
  namespace: string;
  /** `openshift.io/display-name` and `openshift.io/description`. */
  annotations: Record<string, string>;
  modelUri: string;
  modelName: string;
  runtimeImage: string;
  replicas: number;
  cpu: string;
  memory: string;
  gpuCount: number;
  env?: { name: string; value: string }[];
  placement: {
    matchLabels: Record<string, string>;
    matchExpressions: { key: string; operator: 'In'; values: string[] }[];
  };
  rollout: { strategy: 'All' };
};

/**
 * A model of GET /api/v1/models (PR 12's `Model` in bff/internal/api/models.go), limited to the
 * fields the console reads. `toManagedModel` in adapters.ts maps it.
 */
export type ApiModel = {
  name: string;
  namespace: string;
  displayName?: string;
  description?: string;
  modelUri: string;
  modelName: string;
  runtimeImage?: string;
  replicas?: number;
  /** pending, ready or failed; absent before the backend reports one. */
  phase?: string;
  reason?: string;
  message?: string;
  /** Absent for a model served on the hub only. `locations` is proposal P8. */
  placement?: { locations?: string[] };
  resourceVersion?: string;
  creationTimestamp?: string;
};

/** A model deployment: its saved deployment and placement, and PR 12's phase. */
export type ManagedModel = {
  name: string;
  namespace: string;
  displayName?: string;
  description?: string;
  modelRef: ModelReference;
  /** PR 12's phase: Pending, Ready or Failed. */
  phase?: string;
  endpoint?: string;
  status?: string;
  reason?: string;
  statusMessage?: string;
  creationTimestamp?: string;
  /** Opaque; sent back as If-Match on delete. */
  resourceVersion: string;
  /** The `location` labels of the clusters the placement decided on; empty without one. */
  locations: string[];
  availableForSubscriptions: boolean;
  modelUri?: string;
  modelName?: string;
  runtimeImage?: string;
  replicas?: number;
};

// The PoC's subscription types (src/app/types/subscriptions.ts at 62319b8), adapted from
// odh-dashboard packages/maas/frontend/src/app/types/subscriptions.ts, with resourceVersion
// for the PoC's revision and the console's organization in tokenMetadata.organizationId.
export type GroupReference = { name: string };
export type OwnerSpec = { users?: string[]; groups: GroupReference[] };
export type GuardrailAttachment = { ref: { name: string }; checks?: string[] };
export type TokenRateLimit = { limit: number; window: string };
export type BillingRate = { perToken: string };
export type ModelSubscriptionRef = {
  unlimited?: boolean;
  guardrails?: GuardrailAttachment[];
  name: string;
  /** The model's namespace (P6); absent means the console's models namespace. */
  namespace?: string;
  displayName?: string;
  description?: string;
  tokenRateLimits: TokenRateLimit[];
  billingRate?: BillingRate;
};
export type TokenMetadata = { organizationId?: string; costCenter?: string; labels?: Record<string, string> };

// The MaaS status (mock/research/models-maas.md 3.4-3.6), as the BFF returns it (P12).
export type ConditionStatus = 'True' | 'False' | 'Unknown';
export type Condition = {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};
/** The state of an object a MaaS resource references or generates. */
export type ResourceRefStatus = { name: string; namespace?: string; ready: boolean; reason?: string; message?: string };
/** A generated TokenRateLimitPolicy and the model it limits. */
export type TokenRateLimitStatus = ResourceRefStatus & { model: string };
/** A model's MaaSModelRef status: Pending, Ready, Unhealthy, Failed or Invalid. */
export type ModelRegistration = {
  name: string;
  namespace: string;
  phase: string;
  endpoint?: string;
  conditions: Condition[];
};

export type MaaSSubscription = {
  /** Opaque; sent back as If-Match on update and delete. */
  resourceVersion: string;
  inferencePriority?: number;
  guardrails?: GuardrailAttachment[];
  name: string;
  displayName?: string;
  description?: string;
  /** Active, Degraded, Failed or Invalid; absent until the controller's first reconcile. */
  phase?: string;
  conditions?: Condition[];
  modelRefStatuses?: ResourceRefStatus[];
  tokenRateLimitStatuses?: TokenRateLimitStatus[];
  // The Ready condition, picked by toSubscription for the PoC's pages.
  statusMessage?: string;
  status?: string;
  conditionType?: string;
  lastTransitionTime?: string;
  reason?: string;
  priority?: number;
  owner: OwnerSpec;
  modelRefs: ModelSubscriptionRef[];
  tokenMetadata?: TokenMetadata;
  creationTimestamp?: string;
  deletionTimestamp?: string;
};

/** A MaaS model registration; a ManagedModel is one. */
export type MaaSModelRefSummary = {
  resourceVersion?: string;
  creationTimestamp?: string;
  name: string;
  /** The model's namespace; absent only for a reference to a model that no longer exists. */
  namespace?: string;
  displayName?: string;
  description?: string;
  modelRef: ModelReference;
  phase?: string;
  endpoint?: string;
  status?: string;
  reason?: string;
  statusMessage?: string;
  conditionType?: string;
  lastTransitionTime?: string;
};

/** A model an authorization policy covers; no namespace means the console's models namespace. */
export type ModelRef = { name: string; namespace?: string; displayName?: string; description?: string };

export type MaaSAuthPolicy = {
  displayName?: string;
  description?: string;
  name: string;
  phase?: string;
  statusMessage?: string;
  reason?: string;
  status?: string;
  conditionType?: string;
  lastTransitionTime?: string;
  creationTimestamp?: string;
  modelRefs: ModelRef[];
  subjects: { groups?: GroupReference[] };
  conditions?: Condition[];
  meteringMetadata?: TokenMetadata;
  deletionTimestamp?: string;
};

/** The body of POST /api/v1/subscriptions. */
export type CreateSubscriptionRequest = {
  name: string;
  displayName?: string;
  description?: string;
  owner: OwnerSpec;
  modelRefs: ModelSubscriptionRef[];
  priority: number;
  /** organizationId is required. */
  tokenMetadata: TokenMetadata;
  createAuthPolicy: boolean;
};

/** The body of PUT /api/v1/subscriptions/{name}. */
export type UpdateSubscriptionRequest = {
  inferencePriority?: number;
  guardrails?: GuardrailAttachment[];
  displayName?: string;
  description?: string;
  owner: OwnerSpec;
  modelRefs: ModelSubscriptionRef[];
  tokenMetadata?: TokenMetadata;
  priority: number;
};

export type CreateSubscriptionResponse = { subscription: MaaSSubscription; authPolicy?: MaaSAuthPolicy };

export type SubscriptionInfoResponse = {
  subscription: MaaSSubscription;
  modelRefs: MaaSModelRefSummary[];
  authPolicies: MaaSAuthPolicy[];
  meteringMetadata?: TokenMetadata;
  /** The MaaSModelRef status of each referenced model that exists. */
  modelRegistrations?: ModelRegistration[];
};

export const SYSTEM_AUTHENTICATED_GROUP = 'system:authenticated';
