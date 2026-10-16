import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type { ConsoleConfig, GridCluster, Organization, OrganizationInput, User } from './types';
import { fieldErrorsOf, organizationInputSchema } from '../validation';

/** In-memory service for tests and UI work without a cluster. */
export class MockConsoleService implements ConsoleService {
  constructor(
    public user: User = { username: 'dev-user', groups: ['cluster-admins'], isProviderAdmin: true },
    public clusters: GridCluster[] = seedClusters(),
    public organizations: Organization[] = seedOrganizations(),
    public config: ConsoleConfig = {
      gridEndpoint: 'https://ai.grid.example.com',
      mapTileUrl: '',
      billingUrl: '',
      version: 'mock',
      fakeBackend: false,
    },
  ) {}

  getUser = async (): Promise<User> => this.user;

  getConfig = async (): Promise<ConsoleConfig> => this.config;

  listClusters = async (): Promise<GridCluster[]> => [...this.clusters];

  /** Sets only the `ai-grid/enabled` label, as the BFF does. */
  enrollCluster = async ({ name }: GridCluster): Promise<GridCluster> => {
    const index = this.clusters.findIndex((c) => c.name === name);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${name}' not found`);
    }
    const current = this.clusters[index];
    const updated: GridCluster = {
      ...current,
      aiGridEnabled: true,
      provisioningStatus: current.provisioned ? 'Provisioned' : 'Provisioning',
      labels: { ...current.labels, 'ai-grid/enabled': 'true' },
      resourceVersion: String(Number(current.resourceVersion ?? '0') + 1),
    };
    this.clusters[index] = updated;
    return updated;
  };

  // The fake backend's organization rules and messages (bff/internal/fakebackend/tenants.go),
  // with the BFF's status codes.

  listOrganizations = async (): Promise<Organization[]> =>
    [...this.organizations].sort((a, b) => a.name.localeCompare(b.name));

  getOrganization = async (id: string): Promise<Organization> => this.organizations[this.organizationIndex(id)];

  createOrganization = async (input: OrganizationInput): Promise<Organization> => {
    this.checkOrganization(input, undefined);
    const now = new Date().toISOString();
    const created: Organization = {
      ...structuredClone(input),
      id: crypto.randomUUID(),
      status: 'Saved',
      resourceVersion: '1',
      creationTimestamp: now,
    };
    this.organizations.push(created);
    return structuredClone(created);
  };

  updateOrganization = async (id: string, input: OrganizationInput, resourceVersion: string): Promise<Organization> => {
    const index = this.organizationIndex(id);
    const current = this.organizations[index];
    if (resourceVersion !== current.resourceVersion) {
      throw new ServiceError(409, organizationChanged(id, current.resourceVersion, resourceVersion));
    }
    if (input.name !== current.name) {
      throw new ServiceError(422, organizationRenamed, { name: organizationRenamed });
    }
    this.checkOrganization(input, id);
    const updated: Organization = {
      ...current,
      domains: [...input.domains],
      identityProvider: structuredClone(input.identityProvider),
      resourceVersion: String(Number(current.resourceVersion) + 1),
    };
    this.organizations[index] = updated;
    return structuredClone(updated);
  };

  deleteOrganization = async (id: string, resourceVersion: string): Promise<void> => {
    const index = this.organizationIndex(id);
    const current = this.organizations[index];
    if (resourceVersion !== current.resourceVersion) {
      throw new ServiceError(409, organizationChanged(id, current.resourceVersion, resourceVersion));
    }
    this.organizations.splice(index, 1);
  };

  private organizationIndex(id: string): number {
    const index = this.organizations.findIndex((o) => o.id === id);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${id}' not found`);
    }
    return index;
  }

  private checkOrganization(input: OrganizationInput, self: string | undefined) {
    const fieldErrors = fieldErrorsOf(organizationInputSchema, input);
    if (Object.keys(fieldErrors).length > 0) {
      throw new ServiceError(422, 'The organization is invalid.', fieldErrors);
    }
    const others = this.organizations.filter((o) => o.id !== self);
    if (others.some((o) => o.name === input.name)) {
      throw new ServiceError(409, 'An organization with this name already exists.');
    }
    if (others.some((o) => o.domains.some((d) => input.domains.includes(d)))) {
      throw new ServiceError(409, 'One or more domains are already assigned to another organization.');
    }
  }
}

// The fake backend's Aborted message (checkTenantVersion), which the BFF passes through as a 409.
const organizationChanged = (id: string, stored: string, carried: string) =>
  `object with identifier '${id}' has resource version ${stored}, the request carries "${carried}"; fetch it again and retry`;
const organizationRenamed = 'The organization name cannot be changed.';

// The PoC's Git-backend seed (shared/grid-clusters.mjs seedClusters at 62319b8),
// the same clusters as mock/fixtures/managedclusters.json.
const seedSites: [name: string, site: string, siteName: string, region: string, latitude: number, longitude: number][] =
  [
    ['site1', 'san-francisco', 'San Francisco', 'us-west', 37.7749, -122.4194],
    ['site2', 'new-york', 'New York', 'us-east', 40.7128, -74.006],
    ['site3', 'brussels', 'Brussels', 'europe-west', 50.8503, 4.3517],
    ['site4', 'sydney', 'Sydney', 'asia-pacific', -33.8688, 151.2093],
  ];

export const seedClusters = (): GridCluster[] =>
  seedSites.map(([name, site, siteName, region, latitude, longitude], index) => {
    const member = index < 3;
    return {
      name,
      status: 'Ready',
      aiGridEnabled: member,
      provisioned: member,
      provisioningStatus: member ? 'Provisioned' : 'Not provisioned',
      hubAcceptsClient: true,
      location: name,
      site,
      region,
      siteName,
      latitude,
      longitude,
      openshiftVersion: '4.22.15',
      resourceVersion: '1',
      labels: {
        name,
        openshiftVersion: '4.22.15',
        'cluster.open-cluster-management.io/clusterset': 'ai-grid',
        location: name,
        'ai-grid/provisioned': String(member),
        'ai-grid/site': site,
        'ai-grid/region': region,
        ...(member ? { 'ai-grid/enabled': 'true' } : {}),
      },
    };
  });

// The organizations in mock/fixtures/tenants.json.
const seedOrgs: [id: string, name: string, domains: string[], title: string, created: string][] = [
  [
    '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c',
    'acme-robotics',
    ['acme-robotics.example.com', 'acme.example.org'],
    'Acme Robotics SSO',
    '2026-09-01T09:00:00Z',
  ],
  [
    '8d2e7b31-0c4f-4a9d-b5e6-7f8a9b0c1d2e',
    'globex-research',
    ['globex.example.com'],
    'Globex SSO',
    '2026-09-02T09:00:00Z',
  ],
  ['c5a4d3e2-f1b0-4987-a6c5-d4e3f2a1b0c9', 'initech-labs', [], '', '2026-09-03T09:00:00Z'],
];

export const seedOrganizations = (): Organization[] =>
  seedOrgs.map(([id, name, domains, title, created]) => {
    const realm = `https://sso.example.com/realms/${name}`;
    const oidc = `${realm}/protocol/openid-connect`;
    const full = name === 'acme-robotics';
    return {
      id,
      name,
      domains,
      identityProvider: {
        title,
        description: full ? 'Employees of Acme Robotics sign in here.' : '',
        enabled: true,
        config: {
          clientId: 'ai-grid',
          clientSecretSecret: { name: `${name}-oidc-client` },
          issuer: realm,
          authorizationUrl: `${oidc}/auth`,
          tokenUrl: `${oidc}/token`,
          defaultScopes: 'openid profile email',
          userInfoUrl: full ? `${oidc}/userinfo` : '',
          jwksUrl: full ? `${oidc}/certs` : '',
          logoutUrl: full ? `${oidc}/logout` : '',
          validateSignature: true,
        },
      },
      status: 'Saved',
      resourceVersion: '1',
      creationTimestamp: created,
    };
  });
