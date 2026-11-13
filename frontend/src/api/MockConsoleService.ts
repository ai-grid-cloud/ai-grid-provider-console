import type { DashboardResource } from '@perses-dev/client';
import type { GridMembership } from './clusters';
import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type { ConsoleConfig, ClusterGPUs, GPUNode, GPUSharing, GridCluster, ModelHardware, User } from './types';

/** In-memory service for tests and UI work without a cluster. */
export class MockConsoleService implements ConsoleService {
  constructor(
    public user: User = { username: 'dev-user', groups: ['cluster-admins'], isProviderAdmin: true },
    public clusters: GridCluster[] = seedClusters(),
    public config: ConsoleConfig = {
      gridEndpoint: 'https://ai.grid.example.com',
      mapTileUrl: '',
      mapTileAttribution: '',
      billingUrl: '',
      version: 'mock',
      fakeBackend: false,
      monitoring: { enabled: false, persesProject: '' },
      models: { hardware: builtInModelHardware() },
    },
  ) {}

  /** The hub's Perses dashboards, for the Monitoring page; none until a test sets them. */
  monitoringDashboards: DashboardResource[] = [];

  listMonitoringDashboards = async (project: string): Promise<DashboardResource[]> =>
    this.monitoringDashboards.filter((d) => d.metadata.project === project);

  getUser = async (): Promise<User> => this.user;

  getConfig = async (): Promise<ConsoleConfig> => this.config;

  listClusters = async (): Promise<GridCluster[]> => [...this.clusters];

  getCluster = async (name: string): Promise<GridCluster> => {
    const cluster = this.clusters.find((c) => c.name === name);
    if (!cluster) {
      throw new ServiceError(404, `object with identifier '${name}' not found`);
    }
    return cluster;
  };

  /**
   * Sets `ai-grid/enabled`, `ai-grid/role` and `location` on the labels the caller read, as
   * HttpConsoleService sends them: the BFF's PATCH replaces the labels map as a whole, at the
   * version the caller read.
   */
  enrollCluster = async (cluster: GridCluster, membership: GridMembership): Promise<GridCluster> =>
    this.setMembership(cluster, membership);

  removeClusterFromGrid = async (cluster: GridCluster): Promise<GridCluster> => this.setMembership(cluster);

  /**
   * Edit's write, as the backend's Clusters/Update stores it: the labels given (already the whole
   * map), at the version the caller read.
   */
  updateCluster = async (cluster: GridCluster, labels: Record<string, string>): Promise<GridCluster> => {
    const index = this.clusters.findIndex((c) => c.name === cluster.name);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${cluster.name}' not found`);
    }
    const current = this.clusters[index];
    if ((cluster.resourceVersion ?? '') !== (current.resourceVersion ?? '')) {
      throw new ServiceError(
        409,
        `object with identifier '${cluster.name}' has resource version ${current.resourceVersion}, the request carries "${cluster.resourceVersion ?? ''}"; fetch it again and retry`,
      );
    }
    const member = labels['ai-grid/enabled'] === 'true';
    const updated: GridCluster = {
      ...current,
      resourceVersion: String(Number(current.resourceVersion ?? '0') + 1),
      labels: { ...labels },
      location: labels.location || undefined,
      aiGridEnabled: member,
      provisioningStatus: !member ? 'Not provisioned' : current.provisioned ? 'Provisioned' : 'Provisioning',
    };
    this.clusters[index] = updated;
    return updated;
  };

  /** Writes a membership's labels, or drops `ai-grid/enabled` without one; provisioning reads the membership first, as clusterView.ts does. */
  private setMembership(cluster: GridCluster, membership?: GridMembership): GridCluster {
    const { name } = cluster;
    const index = this.clusters.findIndex((c) => c.name === name);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${name}' not found`);
    }
    const current = this.clusters[index];
    // A stale resource version is the backend's failed precondition, which the UI shows as a conflict.
    if ((cluster.resourceVersion ?? '') !== (current.resourceVersion ?? '')) {
      throw new ServiceError(
        409,
        `object with identifier '${name}' has resource version ${current.resourceVersion}, the request carries "${cluster.resourceVersion ?? ''}"; fetch it again and retry`,
      );
    }
    const labels = { ...cluster.labels };
    const member = !!membership;
    if (membership) {
      Object.assign(labels, {
        'ai-grid/enabled': 'true',
        'ai-grid/role': membership.role,
        location: membership.location,
      });
    } else {
      delete labels['ai-grid/enabled'];
    }
    const updated: GridCluster = {
      ...current,
      aiGridEnabled: member,
      provisioningStatus: !member ? 'Not provisioned' : current.provisioned ? 'Provisioned' : 'Provisioning',
      ...(labels.location ? { location: labels.location } : {}),
      labels,
      resourceVersion: String(Number(current.resourceVersion ?? '0') + 1),
    };
    this.clusters[index] = updated;
    return updated;
  }
}

/**
 * The BFF's built-in hardware list (bff/internal/config/hardware.go, DefaultModelHardware), which
 * GET /api/v1/config serves without MODEL_HARDWARE; models.test.tsx checks it against
 * mock/examples/get-config.json.
 */
export const builtInModelHardware = (): ModelHardware[] => [
  {
    id: 'nvidia-gpu',
    label: 'NVIDIA GPU',
    description: 'For clusters with NVIDIA GPUs.',
    accelerator: 'nvidia.com/gpu',
    defaults: { accelerators: 1, cpu: '2', memory: '16Gi' },
  },
  {
    id: 'cpu',
    label: 'CPU only',
    description: 'For x86_64 clusters without GPUs.',
    image:
      'registry.redhat.io/rhaii/vllm-cpu-rhel9@sha256:0ec0f5ff9a5ff263f58db0cfb19e3d7eef24b94c2d8629fe5145f5a8747e28c9',
    imageName: 'vLLM CPU 0.18.0 (OpenShift AI 3.6)',
    env: { OMP_NUM_THREADS: '4', VLLM_CPU_KVCACHE_SPACE: '4' },
    defaults: { cpu: '4', memory: '8Gi' },
  },
];

// The PoC's Git-backend seed (shared/grid-clusters.mjs seedClusters at 62319b8),
// the same clusters as the backend's fixtures/poc/managedclusters.json.
const seedSites: [name: string, site: string, siteName: string, region: string, latitude: number, longitude: number][] =
  [
    ['site1', 'san-francisco', 'San Francisco', 'us-west', 37.7749, -122.4194],
    ['site2', 'new-york', 'New York', 'us-east', 40.7128, -74.006],
    ['site3', 'brussels', 'Brussels', 'europe-west', 50.8503, 4.3517],
    ['site4', 'sydney', 'Sydney', 'asia-pacific', -33.8688, 151.2093],
  ];

/** One GPU node as the backend reports it from GPU Feature Discovery's labels. */
const gpuNode = (
  name: string,
  product: string,
  count: number,
  memoryMib: number,
  family: string,
  computeCapability: string,
  instanceType: string,
  sharing: GPUSharing = { strategy: 'none', replicas: 1, migCapable: false },
): GPUNode => ({
  name,
  vendor: 'NVIDIA',
  product,
  count,
  memoryMib,
  family,
  computeCapability,
  driverVersion: '580.105.08',
  cudaRuntimeVersion: '13.0',
  sharing,
  instanceType,
  ready: true,
});

/** A cluster's inventory from nodes that share one configuration, as the backend derives it. */
const gpuInventory = (nodes: GPUNode[]): ClusterGPUs => ({
  total: nodes.reduce((sum, n) => sum + n.count, 0),
  nodeCount: nodes.length,
  configurations: [
    {
      vendor: nodes[0].vendor,
      product: nodes[0].product,
      memoryMib: nodes[0].memoryMib,
      gpusPerNode: nodes[0].count,
      nodeCount: nodes.length,
      sharing: nodes[0].sharing,
    },
  ],
  nodes,
});

/**
 * The members' GPUs, 16 schedulable on each as their capacity says: site1 H200, 2 nodes x 8;
 * site2 L4 time-sliced x4 on 4 nodes; site3 MIG (A100 3g.20gb), 2 nodes x 8 devices.
 */
const seedGPUs: Record<string, ClusterGPUs> = {
  site1: gpuInventory(
    [0, 1].map((i) => gpuNode(`gpu-h200-${i}`, 'NVIDIA-H200', 8, 143771, 'hopper', '9.0', 'p5en.48xlarge')),
  ),
  site2: gpuInventory(
    [0, 1, 2, 3].map((i) =>
      gpuNode(`gpu-l4-${i}`, 'NVIDIA-L4-SHARED', 1, 23034, 'ada-lovelace', '8.9', 'g6.xlarge', {
        strategy: 'time-slicing',
        replicas: 4,
        migCapable: false,
      }),
    ),
  ),
  site3: gpuInventory(
    [0, 1].map((i) =>
      gpuNode(`gpu-a100-${i}`, 'NVIDIA-A100-SXM4-40GB-MIG-3g.20gb', 8, 19968, 'ampere', '8.0', 'p4d.24xlarge', {
        strategy: 'mig',
        replicas: 1,
        migCapable: true,
        migStrategy: 'single',
      }),
    ),
  ),
};

export const seedClusters = (): GridCluster[] =>
  seedSites.map(([name, site, siteName, region, latitude, longitude], index) => {
    const member = index < 3;
    return {
      name,
      status: 'Ready',
      aiGridEnabled: member,
      provisioned: member,
      provisioningStatus: member ? 'Provisioned' : 'Not provisioned',
      location: name,
      site,
      region,
      siteName,
      latitude,
      longitude,
      openshiftVersion: '4.22.15',
      consoleUrl: `https://console-openshift-console.apps.${name}.example.com`,
      kubernetesVersion: 'v1.35.6',
      platform: 'BareMetal',
      product: 'OpenShift',
      capacity: { cpu: '192', memory: '1572864Mi', 'nvidia.com/gpu': member ? '16' : '0' },
      gpuCapacity: member ? 16 : 0,
      allocatable: { cpu: '186', memory: '1540000Mi', 'nvidia.com/gpu': member ? '16' : '0' },
      // A copy each time, so a test that changes one cluster's GPUs doesn't change the next seed's.
      ...(seedGPUs[name] ? { gpus: structuredClone(seedGPUs[name]) } : {}),
      creationTimestamp: '2026-10-01T09:00:00Z',
      addons: { 'work-manager': 'available', 'cluster-proxy': 'available' },
      conditions: [
        {
          type: 'ManagedClusterConditionAvailable',
          status: 'True',
          reason: 'ManagedClusterAvailable',
          message: 'Managed cluster is available',
          lastTransitionTime: '2026-10-01T09:00:08Z',
        },
      ],
      resourceVersion: '1',
      labels: {
        name,
        openshiftVersion: '4.22.15',
        'cluster.open-cluster-management.io/clusterset': 'ai-grid',
        location: name,
        'ai-grid/provisioned': String(member),
        'ai-grid/site': site,
        'ai-grid/region': region,
        ...(member ? { 'ai-grid/enabled': 'true', 'ai-grid/role': 'combined' } : {}),
      },
    };
  });
