// What the Clusters pages and the AI Grid map show of a ManagedCluster from the backend's Clusters
// API (ai_grid.v1, read over Connect): a thin selector layer over the generated message (ADR-0002).
// Each field reads one documented field or key and words it; the backend decides what a cluster
// is: its membership (`ai_grid_member`), its lifecycle state and where it is (`location`).
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  ManagedClusterLocationSource,
  ManagedClusterState,
  type ClusterGPUs,
  type ManagedCluster,
} from '../../gen/ai_grid/v1/managed_cluster_type_pb';
import type { ClusterState, ClusterStatus, ProvisioningStatus } from '../../api/types';

/** Where a cluster's map position comes from: the hub admin's annotations, its cloud region, or none. */
export type LocationSource = 'annotations' | 'cloud region' | 'none';

/** A ManagedCluster as the Clusters pages and the map show it. */
export type ClusterView = {
  name: string;
  /** Ready, Unavailable or Unknown; Unknown for every other lifecycle state, which `state` names. */
  status: ClusterStatus;
  state?: ClusterState;
  /** The message of the condition that decided the state. */
  statusMessage?: string;
  aiGridEnabled: boolean;
  provisioningStatus: ProvisioningStatus;
  /** The `location` label, which Add writes. */
  location?: string;
  site?: string;
  siteName?: string;
  /** Both present or both absent. */
  latitude?: number;
  longitude?: number;
  locationSource: LocationSource;
  /** What is wrong with the coordinate annotations, for a hub admin to fix. */
  locationProblem?: string;
  /** The cloud region the cluster runs in, from its region claim. */
  region?: string;
  openshiftVersion?: string;
  consoleUrl?: string;
  kubernetesVersion?: string;
  platform?: string;
  product?: string;
  /** Absent until the hub reports the cluster's resources. */
  capacity?: Record<string, string>;
  allocatable?: Record<string, string>;
  /** `capacity["nvidia.com/gpu"]` as a number: 0 without one, undefined without a capacity or for a negative count. */
  gpuCapacity?: number;
  gpus?: ClusterGPUs;
  creationTimestamp?: string;
  /** The labels as read, sent back whole by Add and Remove. */
  labels: Record<string, string>;
  /** `metadata.version`, sent back with `lock` by Add and Remove. */
  version: number;
};

// The keys read here. The labels are AI Grid's own (the backend lets the console write the
// ai-grid/* keys and the location label, ClustersUpdateRequest); the claims are the ones
// ManagedClusterStatus.cluster_claims documents; openshiftVersion is the label ACM sets.
export const LABEL_ENABLED = 'ai-grid/enabled';
export const LABEL_ROLE = 'ai-grid/role';
export const LABEL_LOCATION = 'location';
const LABEL_SITE = 'ai-grid/site';
const LABEL_OPENSHIFT_VERSION = 'openshiftVersion';
const CLAIM_CONSOLE_URL = 'consoleurl.cluster.open-cluster-management.io';
const CLAIM_PLATFORM = 'platform.open-cluster-management.io';
const CLAIM_PRODUCT = 'product.open-cluster-management.io';
const CAPACITY_GPU = 'nvidia.com/gpu';

/**
 * The backend's lifecycle state as the pages word it: the ACM console's words, except Unavailable
 * for the state ACM calls Offline, which the cluster's agent reports (for example, its API server is
 * down): the cluster may still be serving. A cluster the hub can't reach is UNKNOWN, so Unknown.
 */
const states: Record<ManagedClusterState, { status: ClusterStatus; state?: ClusterState }> = {
  [ManagedClusterState.UNSPECIFIED]: { status: 'Unknown' },
  [ManagedClusterState.READY]: { status: 'Ready' },
  [ManagedClusterState.OFFLINE]: { status: 'Unavailable' },
  [ManagedClusterState.UNKNOWN]: { status: 'Unknown' },
  [ManagedClusterState.PENDING_IMPORT]: { status: 'Unknown', state: 'Pending import' },
  [ManagedClusterState.IMPORTING]: { status: 'Unknown', state: 'Importing' },
  [ManagedClusterState.IMPORT_FAILED]: { status: 'Unknown', state: 'Import failed' },
  [ManagedClusterState.NOT_ACCEPTED]: { status: 'Unknown', state: 'Not accepted' },
  [ManagedClusterState.DETACHING]: { status: 'Unknown', state: 'Detaching' },
};

const sources: Record<ManagedClusterLocationSource, LocationSource> = {
  [ManagedClusterLocationSource.UNSPECIFIED]: 'none',
  [ManagedClusterLocationSource.NONE]: 'none',
  [ManagedClusterLocationSource.ANNOTATIONS]: 'annotations',
  [ManagedClusterLocationSource.CLOUD_REGION]: 'cloud region',
};

/**
 * A device plugin's GPU count, a plain integer: another Kubernetes quantity spelling ("8k") reads
 * as 0, and so does none.
 */
const gpuQuantity = (value: string | undefined): number => (value && /^[+-]?\d+$/.test(value) ? Number(value) : 0);

const nonEmpty = (m: { [key: string]: string } | undefined) => (m && Object.keys(m).length ? m : undefined);

/** The cluster as the pages show it. */
export const toClusterView = (mc: ManagedCluster): ClusterView => {
  const labels = mc.metadata?.labels ?? {};
  const status = mc.status;
  const claim = (name: string) => status?.clusterClaims.find((c) => c.name === name)?.value || undefined;
  const capacity = nonEmpty(status?.capacity);
  const gpus = gpuQuantity(capacity?.[CAPACITY_GPU]);
  const where = status?.location;
  const aiGridEnabled = status?.aiGridMember ?? false;
  const created = mc.metadata?.creationTimestamp;
  // A state added after this console was built reads as Unknown.
  const { status: availability, state } = states[status?.state ?? ManagedClusterState.UNSPECIFIED] ?? {
    status: 'Unknown',
  };
  return {
    name: mc.id,
    status: availability,
    state,
    statusMessage: status?.stateMessage || undefined,
    aiGridEnabled,
    // Membership first: right after Remove the hub's ready Policy can still report the cluster
    // compliant until it lets go of it.
    provisioningStatus: !aiGridEnabled
      ? 'Not provisioned'
      : status?.provisioning === 'Compliant'
        ? 'Provisioned'
        : 'Provisioning',
    location: labels[LABEL_LOCATION] || undefined,
    site: labels[LABEL_SITE] || undefined,
    siteName: where?.siteName || undefined,
    ...(where?.latitude !== undefined && where.longitude !== undefined
      ? { latitude: where.latitude, longitude: where.longitude }
      : {}),
    locationSource: sources[where?.source ?? ManagedClusterLocationSource.UNSPECIFIED] ?? 'none',
    locationProblem: where?.problem || undefined,
    region: where?.region || undefined,
    openshiftVersion: labels[LABEL_OPENSHIFT_VERSION] || undefined,
    consoleUrl: claim(CLAIM_CONSOLE_URL),
    kubernetesVersion: status?.kubernetesVersion || undefined,
    platform: claim(CLAIM_PLATFORM),
    product: claim(CLAIM_PRODUCT),
    capacity,
    allocatable: nonEmpty(status?.allocatable),
    gpuCapacity: capacity && gpus >= 0 ? gpus : undefined,
    gpus: status?.gpus,
    creationTimestamp: created && timestampDate(created).toISOString(),
    labels,
    version: mc.metadata?.version ?? 0,
  };
};
