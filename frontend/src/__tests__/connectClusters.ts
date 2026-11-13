// The backend's Clusters API for page tests, over the clusters of a MockConsoleService: they answer
// Clusters/List, Get and Update over Connect (fakeClients: the generated messages, serialized as
// JSON), so a test that changes `service.clusters`, or replaces `listClusters`, `getCluster`,
// `enrollCluster`, `removeClusterFromGrid` or `updateCluster`, changes what the pages read. Update
// writes the labels as the backend does (clusters_server.go, updatePaths and managedKeysPatch), and
// refuses the annotations, which no page writes.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import type { TransportWith } from '../api/connect/BackendProvider';
import { ServiceError } from '../api/ConsoleService';
import type { GridMembership } from '../api/clusters';
import { fakeClients, type FakeBackend } from '../api/connect/testing';
import type { GridCluster } from '../api/types';
import { fleetOf, subscriptionsBackend, type SubscriptionsSource } from './connectSubscriptions';
import { tenantsOf } from './connectTenants';
import {
  ManagedClusterLocationSource,
  ManagedClusterSchema,
  ManagedClusterState,
  type ManagedCluster,
} from '../gen/ai_grid/v1/managed_cluster_type_pb';

/**
 * The mock's clusters, as the tests' Clusters backend reads them; `clusters`, when the service
 * keeps them, is what Update checks the version against and merges the sent labels into.
 */
export type ClusterSource = {
  listClusters: () => Promise<GridCluster[]>;
  getCluster: (name: string) => Promise<GridCluster>;
  clusters?: GridCluster[];
};

/** The writes a MockConsoleService makes; a service without them refuses Update. */
type Writes = {
  enrollCluster?: (cluster: GridCluster, membership: GridMembership) => Promise<GridCluster>;
  removeClusterFromGrid?: (cluster: GridCluster) => Promise<GridCluster>;
  updateCluster?: (cluster: GridCluster, labels: Record<string, string>) => Promise<GridCluster>;
};

const codes: Record<number, Code> = {
  401: Code.Unauthenticated,
  403: Code.PermissionDenied,
  404: Code.NotFound,
  409: Code.Aborted,
  412: Code.FailedPrecondition,
  422: Code.InvalidArgument,
  500: Code.Internal,
  501: Code.Unimplemented,
  503: Code.Unavailable,
};

/** A ServiceError as the backend's Connect error with the same meaning. */
const asConnectError = (err: unknown) =>
  err instanceof ServiceError
    ? new ConnectError(err.message, codes[err.status] ?? Code.Unknown)
    : ConnectError.from(err);

export const call = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    throw asConnectError(err);
  }
};

const availableCondition = { Ready: 'True', Unavailable: 'False', Unknown: '' } as const;

/** The backend's lifecycle state for the mock's status and the ACM state behind its Unknown. */
const stateOf = (c: GridCluster): ManagedClusterState => {
  switch (c.state) {
    case 'Pending import':
      return ManagedClusterState.PENDING_IMPORT;
    case 'Importing':
      return ManagedClusterState.IMPORTING;
    case 'Import failed':
      return ManagedClusterState.IMPORT_FAILED;
    case 'Not accepted':
      return ManagedClusterState.NOT_ACCEPTED;
    case 'Detaching':
      return ManagedClusterState.DETACHING;
  }
  return {
    Ready: ManagedClusterState.READY,
    Unavailable: ManagedClusterState.OFFLINE,
    Unknown: ManagedClusterState.UNKNOWN,
  }[c.status];
};

/**
 * A GridCluster as the backend's ManagedCluster: the fields clusterView.ts reads back. The mock's
 * coordinates are the hub admin's annotations, and its region the cluster's cloud region.
 */
export const toManagedCluster = (c: GridCluster): ManagedCluster => {
  const labels: Record<string, string> = { ...c.labels };
  if (c.location) labels.location = c.location;
  if (c.site) labels['ai-grid/site'] = c.site;
  if (c.openshiftVersion) labels.openshiftVersion = c.openshiftVersion;
  const mapped = c.latitude !== undefined && c.longitude !== undefined;
  // The annotations the backend derives the site name and position from, as a hub admin sets them.
  const annotations: Record<string, string> = {};
  if (c.siteName) annotations['ai-grid/site-name'] = c.siteName;
  if (mapped) {
    annotations['ai-grid/latitude'] = String(c.latitude);
    annotations['ai-grid/longitude'] = String(c.longitude);
  }
  const claims = [
    ['consoleurl.cluster.open-cluster-management.io', c.consoleUrl],
    ['platform.open-cluster-management.io', c.platform],
    ['product.open-cluster-management.io', c.product],
  ].flatMap(([name, value]) => (value ? [{ name, value }] : []));
  // The mock's capacity is undefined without one; its gpuCapacity is the device plugin's count.
  const capacity =
    c.capacity && c.gpuCapacity !== undefined ? { ...c.capacity, 'nvidia.com/gpu': String(c.gpuCapacity) } : c.capacity;
  return create(ManagedClusterSchema, {
    id: c.name,
    metadata: {
      name: c.name,
      labels,
      annotations,
      version: Number(c.resourceVersion ?? 0),
      ...(c.creationTimestamp ? { creationTimestamp: timestampFromDate(new Date(c.creationTimestamp)) } : {}),
    },
    spec: { hubAcceptsClient: c.state !== 'Not accepted' },
    status: {
      availableCondition: availableCondition[c.status],
      // The ready Policy lists the members only (its placement selects ai-grid/enabled), as the
      // backend's readProvisioning reports it.
      provisioning: !c.aiGridEnabled ? '' : c.provisioned ? 'Compliant' : 'NonCompliant',
      kubernetesVersion: c.kubernetesVersion ?? '',
      capacity: capacity ?? {},
      allocatable: c.allocatable ?? {},
      clusterClaims: claims,
      aiGridMember: c.aiGridEnabled,
      state: stateOf(c),
      stateMessage: c.statusMessage ?? '',
      location: {
        siteName: c.siteName ?? '',
        ...(mapped ? { latitude: c.latitude, longitude: c.longitude } : {}),
        source: mapped ? ManagedClusterLocationSource.ANNOTATIONS : ManagedClusterLocationSource.NONE,
        region: c.region ?? '',
      },
      ...(c.gpus
        ? {
            gpus: {
              ...c.gpus,
              configurations: c.gpus.configurations.map((g) => ({ ...g, memoryMib: BigInt(g.memoryMib) })),
              nodes: c.gpus.nodes.map((n) => ({ ...n, memoryMib: BigInt(n.memoryMib) })),
            },
          }
        : {}),
    },
  });
};

/**
 * Whether an Update writes the labels or the annotations, as the backend's updatePaths reads its
 * mask: `metadata` both, `metadata.labels` or `metadata.annotations` (or a path under one) that one;
 * without a mask, the maps the request sets.
 */
const maskedMaps = (paths: string[], sent: { labels: object; annotations: object }) => {
  if (paths.length === 0) {
    return { labels: Object.keys(sent.labels).length > 0, annotations: Object.keys(sent.annotations).length > 0 };
  }
  const names = (map: string) =>
    paths.some((path) => {
      const p = path.replace(/^object\./, '');
      return p === 'metadata' || p === `metadata.${map}` || p.startsWith(`metadata.${map}.`);
    });
  return { labels: names('labels'), annotations: names('annotations') };
};

/** The backend's label keys for the console: the ai-grid/* keys, and the location label. */
const isConsoleKey = (key: string) => key.startsWith('ai-grid/') || key === 'location';

/**
 * Sent labels as the backend stores them (checkConsoleKeys and managedKeysPatch): another key may
 * only come back as stored (InvalidArgument otherwise) and is kept as stored; the console's keys are
 * the whole set sent, so one left out is removed.
 */
const applyLabels = (current: Record<string, string>, sent: Record<string, string>, checkKeys: boolean) => {
  for (const [key, value] of Object.entries(sent)) {
    if (checkKeys && !isConsoleKey(key) && current[key] !== value) {
      throw new ConnectError(
        `label "${key}" cannot be changed through the console; only ai-grid/* labels and annotations and the location label can`,
        Code.InvalidArgument,
      );
    }
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(current)) if (!isConsoleKey(key)) next[key] = value;
  for (const [key, value] of Object.entries(sent)) if (isConsoleKey(key)) next[key] = value;
  return next;
};

/** Clusters/List, Get and Update over the service's clusters. */
export const clustersBackend = (service: ClusterSource & Writes) =>
  ({
    list: async () => {
      const items = (await call(() => service.listClusters())).map(toManagedCluster);
      return { items, size: items.length, total: items.length };
    },
    get: async ({ id }) => ({ object: toManagedCluster(await call(() => service.getCluster(id))) }),
    update: async ({ object, updateMask }) => {
      const id = object?.id ?? '';
      const sentLabels = object?.metadata?.labels ?? {};
      const version = object?.metadata?.version ?? 0;
      const sends = maskedMaps(updateMask?.paths ?? [], {
        labels: sentLabels,
        annotations: object?.metadata?.annotations ?? {},
      });
      // No page writes the annotations (a hub admin sets the site name and position with oc
      // annotate), so the fake refuses them rather than answer an update it didn't store.
      if (sends.annotations) {
        throw new ConnectError("the tests' Clusters fake doesn't write annotations", Code.Unimplemented);
      }
      // The cluster as stored, read without going through listClusters or getCluster, which tests
      // replace to stall or fail the page's reads. Without stored clusters, the request's labels are
      // taken as what is stored. The mock's writes check the version (409, so Aborted).
      const stored = service.clusters?.find((c) => c.name === id);
      const current = stored ? toManagedCluster(stored).metadata : undefined;
      // The backend checks the version before the keys: a stale request is Aborted whatever it sends.
      const stale = !!stored && !!version && String(version) !== (stored.resourceVersion ?? '');
      const labels = sends.labels ? applyLabels(current?.labels ?? sentLabels, sentLabels, !stale) : undefined;
      // What the mock's writes read of the cluster they are given: its name, labels and version.
      const cluster: GridCluster = {
        name: id,
        status: 'Unknown',
        aiGridEnabled: false,
        provisioned: false,
        provisioningStatus: 'Not provisioned',
        addons: {},
        conditions: [],
        labels: labels ?? current?.labels ?? {},
        resourceVersion: version ? String(version) : undefined,
      };
      const wasMember = stored?.aiGridEnabled ?? false;
      const updated = await call(async () => {
        // Added to AI grid: a labels update that sets ai-grid/enabled on a cluster outside it.
        if (labels?.['ai-grid/enabled'] === 'true' && !wasMember && service.enrollCluster) {
          return service.enrollCluster(cluster, {
            location: labels.location ?? '',
            role: labels['ai-grid/role'] as GridMembership['role'],
          });
        }
        // Removed from AI grid: a labels update without ai-grid/enabled.
        if (labels && labels['ai-grid/enabled'] !== 'true' && service.removeClusterFromGrid) {
          return service.removeClusterFromGrid(cluster);
        }
        // Anything else is an edit: the labels as the backend stores them.
        if (service.updateCluster) return service.updateCluster(cluster, cluster.labels);
        throw new ServiceError(501, 'The AI grid backend does not support this operation.');
      });
      return { object: toManagedCluster(updated) };
    },
  }) satisfies FakeBackend['clusters'];

/**
 * A Connect transport whose Clusters service is the service's clusters, whose Models service is its
 * FakeModels (connectSubscriptions.ts, fleetOf), whose Subscriptions are connectSubscriptions.ts's
 * over the service and whose Tenants are its FakeTenants (connectTenants.ts, tenantsOf), built
 * with the console's interceptors, so an
 * Unauthenticated answer checks the session as the browser's transport does.
 */
export const transportFor =
  (service: ClusterSource & Writes & SubscriptionsSource): TransportWith =>
  (interceptors) =>
    fakeClients(
      {
        clusters: clustersBackend(service),
        models: fleetOf(service).backend(),
        ...subscriptionsBackend(service),
        tenants: tenantsOf(service).backend(),
      },
      { interceptors },
    ).transport;
