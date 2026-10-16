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
