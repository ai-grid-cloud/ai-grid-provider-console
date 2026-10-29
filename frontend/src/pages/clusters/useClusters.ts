import { useCallback, useMemo } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { createClient, type Client } from '@connectrpc/connect';
import { useQuery as useConnectQuery, useTransport } from '@connectrpc/connect-query';
import type { GridMembership } from '../../api/clusters';
import { toServiceError } from '../../api/connect/errors';
import { useConsoleSession } from '../../context/useConsoleSession';
import {
  Clusters,
  type ClustersGetResponse,
  type ClustersListResponse,
} from '../../gen/ai_grid/v1/clusters_service_pb';
import { get, list } from '../../gen/ai_grid/v1/clusters_service-Clusters_connectquery';
import { LABEL_ENABLED, LABEL_LOCATION, LABEL_ROLE, toClusterView, type ClusterView } from './clusterView';

/** The pages poll as useServiceData does. */
const POLL_MS = 30_000;

export type Loaded<T> = {
  data: T;
  /** The answer has arrived (or failed) at least once. */
  loaded: boolean;
  error?: Error;
  /** When the answer last arrived (ms since the epoch). */
  updatedAt?: number;
  /** Loads again; a newer call replaces one still running. True when the load succeeded. */
  refresh: () => Promise<boolean>;
};

/**
 * A failure as a ServiceError, as LoadError and the pages read it. As useServiceData does, an
 * ended session (401) after a successful load shows nothing: the console shows the session-ended
 * page once.
 */
export const loadErrorOf = (hasData: boolean, raw: unknown): Error | undefined => {
  if (!raw) return undefined;
  const err = toServiceError(raw);
  return hasData && err.isUnauthenticated ? undefined : err;
};

/**
 * A Connect query as the pages read it: `select` turns the answer into what the page shows (a
 * module-level function, so its result stays the same object between renders); `loaded` once the
 * answer has arrived or failed; `error` as loadErrorOf says, with data meaning both an answer and
 * something selected from it; `refresh` loads again and says whether that worked.
 */
export const useLoaded = <R, T>(query: UseQueryResult<R, unknown>, select: (answer: R | undefined) => T): Loaded<T> => {
  const { refetch, data: answer } = query;
  const data = useMemo(() => select(answer), [select, answer]);
  const refresh = useCallback(async () => (await refetch()).isSuccess, [refetch]);
  return {
    data,
    loaded: query.isFetched,
    error: loadErrorOf(answer !== undefined && data !== undefined, query.error),
    updatedAt: answer !== undefined ? query.dataUpdatedAt : undefined,
    refresh,
  };
};

/** The query options both loads share: poll until the session ends, and no retries (the page offers Retry). */
export const useLoadOptions = () => {
  const { sessionEnded } = useConsoleSession();
  return { refetchInterval: sessionEnded ? (false as const) : POLL_MS, retry: false };
};

const clusterViews = (answer: ClustersListResponse | undefined) => answer?.items.map(toClusterView) ?? [];
const clusterView = (answer: ClustersGetResponse | undefined) => answer?.object && toClusterView(answer.object);

/** Every ManagedCluster from Clusters/List. */
export const useClusterList = (): Loaded<ClusterView[]> =>
  useLoaded(useConnectQuery(list, {}, useLoadOptions()), clusterViews);

/** One cluster from Clusters/Get. */
export const useCluster = (name: string): Loaded<ClusterView | undefined> =>
  useLoaded(useConnectQuery(get, { id: name }, useLoadOptions()), clusterView);

/** The cluster as the backend has it now, for the dialog after a conflict. */
const loadCluster = async (client: Client<typeof Clusters>, name: string): Promise<ClusterView | undefined> => {
  const { object } = await client.get({ id: name });
  return object && toClusterView(object);
};

/**
 * Writes the labels with Clusters/Update: the whole map as read with the change in it, at the
 * version it was read at (`lock`, so a stale one is Aborted, shown as a conflict). The backend
 * answers with the cluster as the hub has it now, its `ai_grid_member` included, which
 * changeMembership checks.
 */
const writeLabels = async (
  client: Client<typeof Clusters>,
  cluster: ClusterView,
  labels: Record<string, string>,
): Promise<ClusterView> => {
  let object;
  try {
    ({ object } = await client.update({
      object: { id: cluster.name, metadata: { labels, version: cluster.version } },
      updateMask: { paths: ['metadata.labels'] },
      lock: true,
    }));
  } catch (err) {
    throw toServiceError(err);
  }
  if (!object) {
    throw new Error('The hub did not confirm the change. Refresh the page and try again.');
  }
  return toClusterView(object);
};

/** What Add to AI Grid and Remove from AI Grid write, and how a page loads one cluster again. */
export type MembershipWrites = {
  enrollCluster: (cluster: ClusterView, membership: GridMembership) => Promise<ClusterView>;
  removeClusterFromGrid: (cluster: ClusterView) => Promise<ClusterView>;
  loadCluster: (name: string) => Promise<ClusterView | undefined>;
};

/**
 * Add writes `ai-grid/enabled: "true"`, the role and the location; Remove drops `ai-grid/enabled`
 * and keeps the rest, so the role and location are there if the cluster is added again.
 */
export const useMembershipWrites = (): MembershipWrites => {
  const transport = useTransport();
  return useMemo(() => {
    const client = createClient(Clusters, transport);
    return {
      enrollCluster: (cluster, { location, role }) =>
        writeLabels(client, cluster, {
          ...cluster.labels,
          [LABEL_ENABLED]: 'true',
          [LABEL_ROLE]: role,
          [LABEL_LOCATION]: location,
        }),
      removeClusterFromGrid: (cluster) => {
        const labels = { ...cluster.labels };
        delete labels[LABEL_ENABLED];
        return writeLabels(client, cluster, labels);
      },
      loadCluster: (name) => loadCluster(client, name),
    };
  }, [transport]);
};
