import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type { ConsoleConfig, GridCluster, Tenant, User } from './types';

/** In-memory service for tests and UI work without a cluster. */
export class MockConsoleService implements ConsoleService {
  constructor(
    public user: User = { username: 'dev-user', groups: ['cluster-admins'], isProviderAdmin: true },
    public clusters: GridCluster[] = seedClusters(),
    public tenants: Tenant[] = seedTenants(),
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

  listTenants = async (): Promise<Tenant[]> => [...this.tenants];
}

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

export const seedTenants = (): Tenant[] => [
  { id: 'a1', name: 'tenant-a', domains: ['a.example.com'] },
  { id: 'b2', name: 'tenant-b', domains: [] },
];
