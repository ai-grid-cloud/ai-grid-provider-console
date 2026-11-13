import { useQuery as useConnectQuery } from '@connectrpc/connect-query';
import type { ClustersListResponse } from '../../gen/ai_grid/v1/clusters_service_pb';
import { list } from '../../gen/ai_grid/v1/clusters_service-Clusters_connectquery';
import { useLoaded, useLoadOptions } from '../clusters/useClusters';
import { claimsByCluster, type ClusterLookup } from './clusterDetails';

const claimsOf = (answer: ClustersListResponse | undefined) => answer && claimsByCluster(answer.items);

/**
 * Clusters/List, the same query the Clusters pages and the map read, while `enabled`: for a
 * dashboard that has cluster details to fill in. Called outside Perses's own query client, so the
 * answer is the console's cached one.
 */
export const useClusterLookup = (enabled: boolean): ClusterLookup => {
  const { data, loaded, error, refresh } = useLoaded(
    useConnectQuery(list, {}, { ...useLoadOptions(), enabled }),
    claimsOf,
  );
  return { clusters: data, loaded, error, refresh };
};
