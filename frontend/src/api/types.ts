// Response shapes of the BFF. Keep in sync with docs/bff.md.

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
  /** The backend runs on fake infrastructure (make dev-fake): the UI shows a banner, and no login proxy runs. */
  fakeBackend: boolean;
  /** The Monitoring page's Perses relay at /perses/api. */
  monitoring: MonitoringConfig;
  /** The Deploy model wizard's settings. */
  models: ModelsConfig;
};

export type ModelsConfig = {
  /** The wizard's Hardware choices, the first one selected, or the first without an accelerator on a grid whose serving clusters have no GPUs; never empty (the BFF's MODEL_HARDWARE, or its built-in list). */
  hardware: ModelHardware[];
};

/** One hardware choice (bff/internal/config/hardware.go, ModelHardware). */
export type ModelHardware = {
  /** A DNS label, unique in the list. */
  id: string;
  label: string;
  description?: string;
  /** The extended resource a model requests per accelerator, such as nvidia.com/gpu; none for CPU only. */
  accelerator?: string;
  /** The runtime image a new model gets; none for the cluster's default vLLM image, which is for NVIDIA GPUs. */
  image?: string;
  /** What the wizard shows for `image`, such as "vLLM CPU 0.18.0 (OpenShift AI 3.6)"; only with an image. */
  imageName?: string;
  /** Environment variables for the model's main container. */
  env?: Record<string, string>;
  /** The resources the wizard starts from. */
  defaults?: { accelerators?: number; cpu?: string; memory?: string };
};

export type MonitoringConfig = {
  /** The BFF relays /perses/api to the hub's Perses; off when it has no PERSES_URL. */
  enabled: boolean;
  /** The one Perses project the relay reads, whose `dashboard-*-admin` objects are the Monitoring tabs; set whenever Monitoring is on. */
  persesProject: string;
};

/**
 * The console's word for the backend's cluster state: Unavailable is ManagedClusterState.OFFLINE,
 * which the ACM console calls Offline (clusterView.ts).
 */
export type ClusterStatus = 'Ready' | 'Unavailable' | 'Unknown';

/** The ACM console's word for a cluster that is neither ready, unavailable, nor unknown. */
export type ClusterState = 'Pending import' | 'Importing' | 'Import failed' | 'Detaching' | 'Not accepted';

export type ProvisioningStatus = 'Provisioned' | 'Provisioning' | 'Not provisioned';

/** How a node's GPUs are shared: none, time-slicing, mps, or mig (with migStrategy single or mixed). */
export type GPUSharing = { strategy: string; replicas: number; migCapable: boolean; migStrategy?: string };

/** Nodes that share one GPU configuration (the backend's `ai_grid.v1.GPUConfiguration`). */
export type GPUConfiguration = {
  vendor: string;
  /** GPU Feature Discovery's product, for example NVIDIA-L4; MIG and time-slicing suffixes kept. */
  product: string;
  memoryMib: number;
  gpusPerNode: number;
  nodeCount: number;
  sharing: GPUSharing;
};

/** One node with GPUs, from its GPU Feature Discovery labels. */
export type GPUNode = {
  name: string;
  vendor: string;
  product: string;
  count: number;
  memoryMib: number;
  family?: string;
  computeCapability?: string;
  driverVersion?: string;
  cudaRuntimeVersion?: string;
  sharing: GPUSharing;
  instanceType?: string;
  ready: boolean;
};

/** A cluster's GPU inventory, as the backend reads it from ACM Search. */
export type ClusterGPUs = { total: number; nodeCount: number; configurations: GPUConfiguration[]; nodes: GPUNode[] };

/** One of the hub's `status.conditions` on a ManagedCluster. */
export type ClusterCondition = {
  type: string;
  /** True, False or Unknown. */
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

/** A ManagedCluster as the console shows it; the PoC's GridCluster plus the hub fields. */
export type GridCluster = {
  name: string;
  /** The PoC's availability; every ACM state other than ready and offline (Unavailable) is Unknown. */
  status: ClusterStatus;
  /** The ACM state behind an Unknown status, such as Importing. */
  state?: ClusterState;
  /** The backend's explanation of the state. */
  statusMessage?: string;
  aiGridEnabled: boolean;
  provisioned: boolean;
  provisioningStatus: ProvisioningStatus;
  location?: string;
  site?: string;
  region?: string;
  siteName?: string;
  /** Latitude and longitude are both present or both absent. */
  latitude?: number;
  longitude?: number;
  openshiftVersion?: string;
  /** The cluster's OpenShift web console, from its claims. */
  consoleUrl?: string;
  kubernetesVersion?: string;
  /** The infrastructure, such as AWS or BareMetal, and the product, such as OpenShift or ROSA. */
  platform?: string;
  product?: string;
  /** Absent when the backend doesn't report the cluster's resources. */
  capacity?: Record<string, string>;
  /** The BFF's count of `capacity["nvidia.com/gpu"]`, the GPUs Kubernetes can schedule. */
  gpuCapacity?: number;
  allocatable?: Record<string, string>;
  /** The backend's `status.gpus`: the GPU inventory from ACM Search; absent without one. */
  gpus?: ClusterGPUs;
  /** When the hub created the ManagedCluster. */
  creationTimestamp?: string;
  addons: Record<string, string>;
  conditions: ClusterCondition[];
  resourceVersion?: string;
  labels: Record<string, string>;
};

// The MaaS status (docs/research/models-maas.md 3.4-3.6), as the BFF returns it (P12).
export type ConditionStatus = 'True' | 'False' | 'Unknown';
export type Condition = {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

/** The group every signed-in user is in, which a subscription warns about. */
export const SYSTEM_AUTHENTICATED_GROUP = 'system:authenticated';
