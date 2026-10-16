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
  billingUrl: string;
  version: string;
};

/**
 * Lifecycle state the backend derives from the ManagedCluster conditions, in
 * the ACM console's words. Absent when the backend reports no status (the
 * shipped backend today).
 */
export type ClusterStatus =
  | 'ready'
  | 'offline'
  | 'unknown'
  | 'pendingimport'
  | 'importing'
  | 'importfailed'
  | 'detaching'
  | 'notaccepted';

export type ClusterCondition = {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  /** Absent when the hub recorded no transition time; never the epoch. */
  lastTransitionTime?: string;
};

export type GridCluster = {
  name: string;
  aiGridEnabled: boolean;
  provisioned: boolean;
  hubAcceptsClient: boolean;
  location?: string;
  site?: string;
  region?: string;
  openshiftVersion?: string;
  status?: ClusterStatus;
  statusMessage?: string;
  consoleUrl?: string;
  kubernetesVersion?: string;
  platform?: string;
  product?: string;
  gpuCapacity: number;
  siteName?: string;
  latitude?: number;
  longitude?: number;
  /** Add-on name to available | unhealthy | unreachable. */
  addons: Record<string, string>;
  conditions: ClusterCondition[];
  resourceVersion?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
};

/**
 * Body of PATCH /api/v1/clusters/{name}. Absent fields are left alone, an
 * empty string removes a label or annotation, null removes a coordinate.
 */
export type ClusterPatch = {
  aiGridEnabled?: boolean;
  provisioned?: boolean;
  location?: string;
  site?: string;
  region?: string;
  siteName?: string;
  latitude?: number | null;
  longitude?: number | null;
};

/** One organization domain with Keycloak's metadata. */
export type TenantDomain = {
  name: string;
  verified: boolean;
  identityProviderAlias?: string;
  autoRedirect: boolean;
};

/** A Keycloak Organization in the AI Grid realm, as the BFF exposes it. */
export type Tenant = {
  id: string;
  name: string;
  /** URL-safe handle, defaults to the name on create, immutable afterwards. */
  alias: string;
  enabled: boolean;
  description: string;
  /** Names of domainDetails, in the same order. */
  domains: string[];
  domainDetails: TenantDomain[];
  attributes: Record<string, string>;
};

/** Query of GET /api/v1/tenants. */
export type ListTenantsParams = {
  offset?: number;
  limit?: number;
  /** Case-insensitive contains on the name or a domain (Keycloak's `search`). */
  search?: string;
};

/** `meta` of a paged list response. */
export type ListMeta = {
  size: number;
  total: number;
  offset: number;
  limit?: number;
};

export type TenantPage = {
  items: Tenant[];
  meta: ListMeta;
};

/** Body of POST /api/v1/tenants. `enabled` defaults to true, `alias` to the name. */
export type TenantCreate = {
  name: string;
  alias?: string;
  description?: string;
  enabled?: boolean;
  domains?: string[];
  attributes?: Record<string, string>;
};

/**
 * Body of PATCH /api/v1/tenants/{id}. Absent fields are left alone; a present
 * field replaces the stored one as a whole. `alias` may be sent but must
 * equal the stored alias (Keycloak: "Cannot change the alias").
 */
export type TenantPatch = {
  name?: string;
  alias?: string;
  description?: string;
  enabled?: boolean;
  domains?: string[];
  attributes?: Record<string, string>;
};
