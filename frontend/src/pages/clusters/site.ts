// Where a cluster is, as the backend's status.location says (its
// internal/servers/managed_cluster_location.go): what the Clusters pages and the map share.
import type { ClusterView } from './clusterView';

/** How a hub admin sets a cluster's position and site name: the backend's README. */
export const LOCATION_DOCS_URL =
  'https://github.com/ai-grid-cloud/ai-grid-provider-backend/blob/main/README.md#cluster-locations';

/** A position from the cluster's cloud region (no site is set): the area its provider names, not the data center. */
export const isFromCloudRegion = (c: Pick<ClusterView, 'locationSource'>) => c.locationSource === 'cloud region';
