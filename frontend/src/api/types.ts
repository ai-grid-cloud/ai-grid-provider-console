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

export type Tenant = {
  id: string;
  name: string;
  domains: string[];
};
