// Where a cluster is, as the backend's status.location says (its
// internal/servers/managed_cluster_location.go): what the Clusters pages and the map share.
import type { ClusterView } from './clusterView';

/** A position from the cluster's cloud region (no site is set): the area its provider names, not the site. */
export const isFromCloudRegion = (c: Pick<ClusterView, 'locationSource'>) => c.locationSource === 'cloud region';
