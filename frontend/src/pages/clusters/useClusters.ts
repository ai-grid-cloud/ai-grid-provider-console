import { useCallback, useMemo, useRef } from 'react';
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
  /**
   * An answer (or a failure) has arrived since the page mounted: `data` is not only what the cache
   * kept from an earlier page, which may predate what the page shows next to it.
   */
  fresh: boolean;
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
 * answer has arrived or failed; `fresh` once that happened after the page mounted; `error` as
 * loadErrorOf says, with data meaning both an answer and something selected from it; `refresh`
 * loads again and says whether that worked.
 */
export const useLoaded = <R, T>(query: UseQueryResult<R, unknown>, select: (answer: R | undefined) => T): Loaded<T> => {
  const { refetch, data: answer } = query;
  const data = useMemo(() => select(answer), [select, answer]);
  const refresh = useCallback(async () => {
    noteUserAction();
    return (await refetch()).isSuccess;
  }, [refetch]);
  return {
    data,
    loaded: query.isFetched,
    fresh: query.isFetchedAfterMount,
    error: loadErrorOf(answer !== undefined && data !== undefined, query.error),
    updatedAt: answer !== undefined ? query.dataUpdatedAt : undefined,
    refresh,
  };
};

/** How often a page polls while something it shows is still changing, such as a Pending model. */
export const UNSETTLED_POLL_MS = 10_000;

/**
 * How long a page polls every UNSETTLED_POLL_MS while what is unsettled stays the same: 5 minutes.
 * Argo CD looks at the catalog every 3 minutes by default (its reconciliation timeout, 180 s), so a
 * model waiting for Argo CD's next look is still polled fast when it comes; the rollout steps
 * after it (Syncing, Synced, Starting) each change a word, which starts the window again. What
 * hasn't changed a word in 5 minutes is stuck until someone acts, and polling it every 10 s
 * forever would only load the backend. At most 30 fast polls per stuck state.
 */
export const UNSETTLED_WINDOW_MS = 5 * 60_000;

/** Counts the user's actions that start every page's fast window again (noteUserAction). */
let userActions = 0;

/**
 * The user acted: a Refresh or Retry (useLoaded's refresh), or a write the console sent that
 * landed (BackgroundWritesProvider). Every page polling something unsettled polls fast again from
 * its next answer, for UNSETTLED_WINDOW_MS. Only compared for a change, so a count is enough.
 */
export const noteUserAction = () => {
  userActions += 1;
};

/**
 * The query options the pages' loads share: poll until the session ends, and no retries (the page
 * offers Retry). With `unsettled`, which words what in the answer is still changing (undefined or
 * empty when nothing is), the load polls every UNSETTLED_POLL_MS while the last answer has
 * something still changing, and every `settledMs` (POLL_MS, or `false` for none) once nothing does.
 * The fast polling lasts UNSETTLED_WINDOW_MS while those words stay the same; then the load polls
 * every `settledMs`, or POLL_MS where that is `false`, so a page still showing something unsettled
 * keeps updating at the other pages' pace. The window starts again when the words change, when the
 * user acts (noteUserAction), and when the page mounts.
 */
export const useLoadOptions = <T>(
  unsettled?: (answer: T) => string | undefined,
  settledMs: number | false = POLL_MS,
) => {
  const { sessionEnded } = useConsoleSession();
  // The fast window of this mount: what was unsettled when it began, when, and the actions counted then.
  const fast = useRef<{ changing: string; since: number; actions: number } | undefined>(undefined);
  const refetchInterval = (query: { state: { data: T | undefined } }) => {
    const answer = query.state.data;
    const changing = answer !== undefined ? unsettled?.(answer) : undefined;
    if (!changing) {
      fast.current = undefined;
      return settledMs;
    }
    const now = Date.now();
    if (fast.current?.changing !== changing || fast.current.actions !== userActions) {
      fast.current = { changing, since: now, actions: userActions };
    }
    return now - fast.current.since < UNSETTLED_WINDOW_MS ? UNSETTLED_POLL_MS : settledMs || POLL_MS;
  };
  return { refetchInterval: sessionEnded ? (false as const) : refetchInterval, retry: false };
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

/** What Add to AI grid, Remove from AI grid and Edit write, and how a page loads one cluster again. */
export type MembershipWrites = {
  enrollCluster: (cluster: ClusterView, membership: GridMembership) => Promise<ClusterView>;
  removeClusterFromGrid: (cluster: ClusterView) => Promise<ClusterView>;
  /** Writes the labels Edit built (gridSettings.ts, labelsUpdate). */
  updateLabels: (cluster: ClusterView, labels: Record<string, string>) => Promise<ClusterView>;
  loadCluster: (name: string) => Promise<ClusterView | undefined>;
};

/**
 * Add writes `ai-grid/enabled: "true"`, the role and the location; Remove drops `ai-grid/enabled`
 * and keeps the rest, so the role and location are there if the cluster is added again; Edit writes
 * the location label, and the role of a cluster without one.
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
      updateLabels: (cluster, labels) => writeLabels(client, cluster, labels),
      loadCluster: (name) => loadCluster(client, name),
    };
  }, [transport]);
};
