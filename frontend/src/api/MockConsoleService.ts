import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type { ClusterCondition, ClusterPatch, ClusterStatus, ConsoleConfig, GridCluster, Tenant, User } from './types';

/**
 * In-memory service for tests and UI work without a cluster. It follows the
 * same rules as the fake backend (bff/internal/fakebackend): the status is
 * derived from the conditions in the ACM console's order, an unknown name is
 * 404, a bad coordinate is 422, a non-admin write is 403, and a patch
 * replaces labels and annotations.
 */
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
    },
  ) {}

  getUser = async (): Promise<User> => this.user;

  getConfig = async (): Promise<ConsoleConfig> => this.config;

  listClusters = async (): Promise<GridCluster[]> => this.clusters.map((c) => ({ ...c }));

  listTenants = async (): Promise<Tenant[]> => [...this.tenants];

  getCluster = async (name: string): Promise<GridCluster> => {
    const cluster = this.clusters.find((c) => c.name === name);
    if (!cluster) {
      throw new ServiceError(404, `object with identifier '${name}' not found`);
    }
    return { ...cluster };
  };

  updateCluster = async (name: string, patch: ClusterPatch): Promise<GridCluster> => {
    if (patch.latitude != null && (patch.latitude < -90 || patch.latitude > 90)) {
      throw new ServiceError(422, 'latitude must be between -90 and 90');
    }
    if (patch.longitude != null && (patch.longitude < -180 || patch.longitude > 180)) {
      throw new ServiceError(422, 'longitude must be between -180 and 180');
    }
    const index = this.clusters.findIndex((c) => c.name === name);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${name}' not found`);
    }
    if (!this.user.isProviderAdmin) {
      throw new ServiceError(
        403,
        `managedclusters.cluster.open-cluster-management.io "${name}" is forbidden: User "${this.user.username}" cannot patch resource "managedclusters" in API group "cluster.open-cluster-management.io" at the cluster scope`,
      );
    }
    const current = this.clusters[index];
    const labels = { ...current.labels };
    const annotations = { ...current.annotations };
    // Like the BFF: a patch with no field present is answered with the current
    // object and nothing is written, so the resource version does not move.
    let touched = false;
    const setLabel = (key: string, value: string | undefined) => {
      if (value === undefined) {
        return;
      }
      touched = true;
      if (value === '') {
        delete labels[key];
      } else {
        labels[key] = value;
      }
    };
    const setAnnotation = (key: string, value: string | number | null | undefined) => {
      if (value === undefined) {
        return;
      }
      touched = true;
      if (value === '' || value === null) {
        delete annotations[key];
      } else {
        annotations[key] = String(value);
      }
    };
    setLabel('ai-grid/enabled', patch.aiGridEnabled === undefined ? undefined : String(patch.aiGridEnabled));
    setLabel('ai-grid/provisioned', patch.provisioned === undefined ? undefined : String(patch.provisioned));
    setLabel('location', patch.location);
    setLabel('ai-grid/site', patch.site);
    setLabel('ai-grid/region', patch.region);
    setAnnotation('ai-grid/site-name', patch.siteName);
    setAnnotation('ai-grid/latitude', patch.latitude);
    setAnnotation('ai-grid/longitude', patch.longitude);
    if (!touched) {
      return { ...current };
    }
    const updated = fromLabels({ ...current, labels, annotations, resourceVersion: String(Number(current.resourceVersion ?? '0') + 1) });
    this.clusters[index] = updated;
    return { ...updated };
  };
}

/** The ACM console's derivation, as the fake backend implements it. */
export const deriveStatus = (conditions: ClusterCondition[], detaching = false): ClusterStatus | undefined => {
  const find = (type: string) => conditions.find((c) => c.type === type);
  const isTrue = (type: string) => find(type)?.status === 'True';
  if (detaching) {
    return 'detaching';
  }
  if (conditions.length === 0) {
    return undefined;
  }
  if (!isTrue('HubAcceptedManagedCluster')) {
    return 'notaccepted';
  }
  if (!isTrue('ManagedClusterJoined')) {
    const imp = find('ManagedClusterImportSucceeded');
    if (imp?.status === 'False' && imp.reason === 'ManagedClusterImporting') {
      return 'importing';
    }
    if (imp?.status === 'False' && imp.reason === 'ManagedClusterImportFailed') {
      return 'importfailed';
    }
    return 'pendingimport';
  }
  const available = find('ManagedClusterConditionAvailable');
  if (available?.status === 'True') {
    return 'ready';
  }
  if (available?.status === 'False') {
    return 'offline';
  }
  return 'unknown';
};

/** The message of the condition that decided the status, as the fake reports it. */
export const deriveStatusMessage = (conditions: ClusterCondition[], status: ClusterStatus | undefined): string | undefined => {
  const by = (type: string) => conditions.find((c) => c.type === type)?.message;
  switch (status) {
    case 'detaching':
    case 'pendingimport':
    case 'importing':
    case 'importfailed':
      return by('ManagedClusterImportSucceeded');
    case 'notaccepted':
      return by('HubAcceptedManagedCluster');
    case 'ready':
    case 'offline':
    case 'unknown':
      return by('ManagedClusterConditionAvailable');
    default:
      return undefined;
  }
};

export const ADDON_LABEL_PREFIX = 'feature.open-cluster-management.io/addon-';

/** Recomputes the fields the BFF derives from labels and annotations. */
const fromLabels = (c: GridCluster): GridCluster => {
  const num = (s: string | undefined, limit: number) => {
    if (s === undefined) {
      return undefined;
    }
    const v = Number(s);
    return Number.isFinite(v) && Math.abs(v) <= limit ? v : undefined;
  };
  const addons: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.labels)) {
    if (k.startsWith(ADDON_LABEL_PREFIX)) {
      addons[k.slice(ADDON_LABEL_PREFIX.length)] = v;
    }
  }
  return {
    ...c,
    aiGridEnabled: c.labels['ai-grid/enabled'] === 'true',
    provisioned: c.labels['ai-grid/provisioned'] === 'true',
    location: c.labels['location'],
    site: c.labels['ai-grid/site'],
    region: c.labels['ai-grid/region'],
    openshiftVersion: c.labels['openshiftVersion'],
    siteName: c.annotations['ai-grid/site-name'],
    latitude: num(c.annotations['ai-grid/latitude'], 90),
    longitude: num(c.annotations['ai-grid/longitude'], 180),
    addons,
  };
};

const condition = (type: string, status: ClusterCondition['status'], reason: string, message: string, at: string): ClusterCondition => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: at,
});

const accepted = (at: string) => condition('HubAcceptedManagedCluster', 'True', 'HubClusterAdminAccepted', 'Accepted by hub cluster admin', at);
const joined = (at: string) => condition('ManagedClusterJoined', 'True', 'ManagedClusterJoined', 'Managed cluster joined', at);
const imported = (at: string) => condition('ManagedClusterImportSucceeded', 'True', 'ManagedClusterImported', 'Import succeeded', at);
const available = (at: string) => condition('ManagedClusterConditionAvailable', 'True', 'ManagedClusterAvailable', 'Managed cluster is available', at);
const leaseStopped = (at: string) =>
  condition('ManagedClusterConditionAvailable', 'Unknown', 'ManagedClusterLeaseUpdateStopped', 'Registration agent stopped updating its lease.', at);
const clockSynced = (at: string) =>
  condition('ManagedClusterConditionClockSynced', 'True', 'ManagedClusterClockSynced', 'The clock of the managed cluster is synced with the hub.', at);

/** The add-ons a plain ACM import enables; the hub itself has two more. */
const DEFAULT_ADDONS = [
  'application-manager',
  'cert-policy-controller',
  'cluster-proxy',
  'config-policy-controller',
  'governance-policy-framework',
  'managed-serviceaccount',
  'work-manager',
];
const HUB_ADDONS = [...DEFAULT_ADDONS, 'hypershift-addon', 'multicluster-observability-addon'];

/** Labels ACM writes on an imported cluster (mock/research/acm.md section 1). */
const acmLabels = (name: string, cloud: string, clusterID: string, version: string, addons = DEFAULT_ADDONS, addonState = 'available'): Record<string, string> => {
  const labels: Record<string, string> = {
    name,
    cloud,
    vendor: 'OpenShift',
    clusterID,
    openshiftVersion: version,
    'openshiftVersion-major': version.split('.')[0],
    'openshiftVersion-major-minor': version.split('.').slice(0, 2).join('.'),
    'cluster.open-cluster-management.io/clusterset': 'default',
  };
  for (const addon of addons) {
    labels[ADDON_LABEL_PREFIX + addon] = addonState;
  }
  return labels;
};

/** Labels on a cluster ACM created but whose agent has not joined yet. */
const unjoinedLabels = (name: string): Record<string, string> => ({
  name,
  cloud: 'auto-detect',
  vendor: 'auto-detect',
  'cluster.open-cluster-management.io/clusterset': 'default',
});

const ACM_ANNOTATIONS = { 'installer.multicluster.openshift.io/release-version': '2.17.3', 'open-cluster-management/created-via': 'other' };

type Seed = Omit<GridCluster, 'status' | 'statusMessage' | 'aiGridEnabled' | 'provisioned' | 'addons' | 'gpuCapacity'> & {
  gpuCapacity?: number;
  detaching?: boolean;
};

const seed = (s: Seed): GridCluster => {
  const { detaching, ...rest } = s;
  const status = deriveStatus(rest.conditions, detaching);
  return fromLabels({
    ...rest,
    gpuCapacity: rest.gpuCapacity ?? 0,
    aiGridEnabled: false,
    provisioned: false,
    addons: {},
    status,
    statusMessage: deriveStatusMessage(rest.conditions, status),
  });
};

/**
 * Mirrors mock/fixtures/managedclusters.json cluster for cluster (names,
 * states, labels, annotations, GPUs, claims the BFF exposes); a test checks
 * the two files agree.
 */
export const seedClusters = (): GridCluster[] => [
  seed({
    name: 'local-cluster',
    hubAcceptsClient: true,
    labels: {
      ...acmLabels('local-cluster', 'Amazon', '7f0c2a6e-1d2b-4a3c-9e8f-0123456789ab', '4.22.15', HUB_ADDONS),
      'local-cluster': 'true',
      'velero.io/exclude-from-backup': 'true',
    },
    annotations: {
      ...ACM_ANNOTATIONS,
      'open-cluster-management/tolerations': '[{"effect": "NoSchedule", "key": "node-role.kubernetes.io/infra", "operator": "Exists"}]',
    },
    consoleUrl: 'https://console-openshift-console.apps.hub.example.com',
    kubernetesVersion: 'v1.35.6',
    platform: 'AWS',
    product: 'ROSA',
    resourceVersion: '48812031',
    conditions: [imported('2026-09-01T07:30:12Z'), accepted('2026-09-01T07:30:02Z'), joined('2026-09-01T07:30:08Z'), available('2026-09-01T07:30:08Z'), clockSynced('2026-09-01T07:30:08Z')],
  }),
  seed({
    name: 'site-paris-1',
    hubAcceptsClient: true,
    labels: {
      ...acmLabels('site-paris-1', 'BareMetal', '3f1c9c3e-8a4b-4e1d-9f0a-2b7d5e6c1a90', '4.22.15'),
      'ai-grid/enabled': 'true',
      'ai-grid/provisioned': 'true',
      location: 'paris',
      'ai-grid/site': 'paris-dc1',
      'ai-grid/region': 'europe-west',
    },
    annotations: { ...ACM_ANNOTATIONS, 'ai-grid/site-name': 'Paris DC1', 'ai-grid/latitude': '48.8566', 'ai-grid/longitude': '2.3522' },
    consoleUrl: 'https://console-openshift-console.apps.site-paris-1.example.com',
    kubernetesVersion: 'v1.35.6',
    platform: 'BareMetal',
    product: 'OpenShift',
    gpuCapacity: 16,
    resourceVersion: '48811204',
    conditions: [imported('2026-10-01T09:00:12Z'), accepted('2026-10-01T09:00:02Z'), joined('2026-10-01T09:00:08Z'), available('2026-10-01T09:00:08Z'), clockSynced('2026-10-01T09:00:08Z')],
  }),
  seed({
    name: 'site-frankfurt-1',
    hubAcceptsClient: true,
    labels: acmLabels('site-frankfurt-1', 'BareMetal', 'c41e8a77-3b5d-4f60-9c12-345678abcdef', '4.21.9'),
    annotations: ACM_ANNOTATIONS,
    consoleUrl: 'https://console-openshift-console.apps.site-frankfurt-1.example.com',
    kubernetesVersion: 'v1.34.3',
    platform: 'BareMetal',
    product: 'OpenShift',
    gpuCapacity: 8,
    resourceVersion: '48809977',
    conditions: [imported('2026-10-03T14:14:51Z'), accepted('2026-10-03T14:12:02Z'), joined('2026-10-03T14:14:40Z'), available('2026-10-03T14:14:40Z'), clockSynced('2026-10-03T14:14:40Z')],
  }),
  seed({
    name: 'site-madrid-1',
    hubAcceptsClient: true,
    labels: {
      ...acmLabels('site-madrid-1', 'Amazon', '9b2d4f60-1e3a-4c7b-8d9e-0a1b2c3d4e5f', '4.21.9', DEFAULT_ADDONS, 'unreachable'),
      'ai-grid/enabled': 'true',
      'ai-grid/provisioned': 'true',
      location: 'madrid',
      'ai-grid/site': 'madrid-dc1',
      'ai-grid/region': 'europe-south',
    },
    annotations: { ...ACM_ANNOTATIONS, 'ai-grid/site-name': 'Madrid DC1', 'ai-grid/latitude': '40.4168', 'ai-grid/longitude': '-3.7038' },
    consoleUrl: 'https://console-openshift-console.apps.site-madrid-1.example.com',
    kubernetesVersion: 'v1.34.3',
    platform: 'AWS',
    product: 'OpenShift',
    gpuCapacity: 4,
    resourceVersion: '48812499',
    conditions: [imported('2026-09-20T08:00:12Z'), accepted('2026-09-20T08:00:02Z'), joined('2026-09-20T08:00:08Z'), leaseStopped('2026-10-15T11:05:00Z'), clockSynced('2026-09-20T08:00:08Z')],
  }),
  seed({
    name: 'site-ashburn-1',
    hubAcceptsClient: true,
    labels: {
      ...acmLabels('site-ashburn-1', 'Amazon', '9e3f5b21-7d8a-4c93-b0e4-56789abcdef0', '4.22.15', DEFAULT_ADDONS, 'unhealthy'),
      'ai-grid/enabled': 'true',
      'ai-grid/provisioned': 'false',
      location: 'ashburn',
      'ai-grid/site': 'ashburn-dc1',
      'ai-grid/region': 'us-east',
    },
    annotations: { ...ACM_ANNOTATIONS, 'ai-grid/site-name': 'Ashburn DC1', 'ai-grid/latitude': '39.0438', 'ai-grid/longitude': '-77.4874' },
    consoleUrl: 'https://console-openshift-console.apps.site-ashburn-1.example.com',
    kubernetesVersion: 'v1.35.6',
    platform: 'AWS',
    product: 'OpenShift',
    gpuCapacity: 8,
    resourceVersion: '48812610',
    conditions: [
      imported('2026-09-28T16:47:44Z'),
      accepted('2026-09-28T16:45:02Z'),
      joined('2026-09-28T16:47:31Z'),
      condition(
        'ManagedClusterConditionAvailable',
        'False',
        'ManagedClusterKubeAPIServerUnavailable',
        'The kube-apiserver is not ok, status code: 503, the server is currently unable to handle the request',
        '2026-10-15T11:42:17Z',
      ),
      clockSynced('2026-09-28T16:47:31Z'),
    ],
  }),
  seed({
    name: 'site-berlin-1',
    hubAcceptsClient: true,
    labels: unjoinedLabels('site-berlin-1'),
    annotations: { 'open-cluster-management/created-via': 'other' },
    resourceVersion: '48812702',
    conditions: [
      accepted('2026-10-15T10:00:01Z'),
      condition('ManagedClusterImportSucceeded', 'False', 'ManagedClusterImporting', 'Importing resources are applied, wait for resources be available', '2026-10-15T10:00:05Z'),
    ],
  }),
  seed({
    name: 'site-oslo-1',
    hubAcceptsClient: true,
    labels: unjoinedLabels('site-oslo-1'),
    annotations: { 'open-cluster-management/created-via': 'other' },
    resourceVersion: '48812790',
    conditions: [
      accepted('2026-10-15T12:30:01Z'),
      condition('ManagedClusterImportSucceeded', 'False', 'ManagedClusterWaitForImporting', 'Wait for importing', '2026-10-15T12:30:02Z'),
    ],
  }),
  seed({
    name: 'site-dublin-1',
    hubAcceptsClient: true,
    labels: unjoinedLabels('site-dublin-1'),
    annotations: { 'open-cluster-management/created-via': 'other' },
    resourceVersion: '48812401',
    conditions: [
      accepted('2026-10-14T09:15:01Z'),
      condition(
        'ManagedClusterImportSucceeded',
        'False',
        'ManagedClusterImportFailed',
        'Try to import managed cluster, error: Get "https://api.site-dublin-1.example.com:6443/api?timeout=32s": dial tcp 192.0.2.10:6443: i/o timeout',
        '2026-10-14T09:16:12Z',
      ),
    ],
  }),
  seed({
    name: 'site-lisbon-1',
    hubAcceptsClient: false,
    labels: acmLabels('site-lisbon-1', 'Azure', 'd7e8f9a0-b1c2-4d3e-8f4a-5b6c7d8e9f00', '4.21.9', DEFAULT_ADDONS, 'unreachable'),
    annotations: ACM_ANNOTATIONS,
    consoleUrl: 'https://console-openshift-console.apps.site-lisbon-1.example.com',
    kubernetesVersion: 'v1.34.3',
    platform: 'Azure',
    product: 'OpenShift',
    gpuCapacity: 4,
    resourceVersion: '48812688',
    conditions: [
      imported('2026-09-12T10:00:12Z'),
      condition('HubAcceptedManagedCluster', 'False', 'HubClusterAdminDenied', 'Denied by hub cluster admin', '2026-10-14T15:20:00Z'),
      joined('2026-09-12T10:00:08Z'),
      leaseStopped('2026-10-14T15:25:00Z'),
      clockSynced('2026-09-12T10:00:08Z'),
    ],
  }),
  seed({
    name: 'edge-lyon-2',
    hubAcceptsClient: true,
    detaching: true,
    labels: acmLabels('edge-lyon-2', 'BareMetal', '0a1b2c3d-4e5f-4607-8899-aabbccddeeff', '4.22.15'),
    annotations: ACM_ANNOTATIONS,
    consoleUrl: 'https://console-openshift-console.apps.edge-lyon-2.example.com',
    kubernetesVersion: 'v1.35.6',
    platform: 'BareMetal',
    product: 'OpenShift',
    gpuCapacity: 2,
    resourceVersion: '48812755',
    conditions: [
      condition('ManagedClusterImportSucceeded', 'False', 'ManagedClusterDetaching', 'The managed cluster is being detached now', '2026-10-15T12:00:00Z'),
      accepted('2026-10-10T11:20:02Z'),
      joined('2026-10-10T11:22:40Z'),
      available('2026-10-10T11:22:40Z'),
      clockSynced('2026-10-10T11:22:40Z'),
      // The gc controller's message is not verified by the research; it is empty like in the fixture.
      condition('Deleting', 'True', 'ResourceRemaining', '', '2026-10-15T12:00:00Z'),
    ],
  }),
];

export const seedTenants = (): Tenant[] => [
  { id: 'a1', name: 'tenant-a', domains: ['a.example.com'] },
  { id: 'b2', name: 'tenant-b', domains: [] },
];
