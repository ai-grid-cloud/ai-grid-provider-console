// A cluster's data center, as the backend's status.location gives it (site_name).
import { EMPTY_VALUE } from '../../utilities/format';
import type { ClusterView } from './clusterView';
import { MissingLabel } from './MissingLabel';

type Located = Pick<ClusterView, 'siteName' | 'locationProblem'>;

/**
 * The cluster's data center: the name a hub admin set (annotation ai-grid/site-name), with a
 * warning and what to fix when the coordinate annotations are wrong. No fallback to the cloud
 * region, which has a column of its own.
 */
export const ClusterDataCenter: React.FC<{ cluster: Located; testId: string }> = ({ cluster, testId }) => {
  if (cluster.locationProblem) {
    return (
      <MissingLabel testId={testId} reason={cluster.locationProblem}>
        {cluster.siteName ?? 'Position not readable'}
      </MissingLabel>
    );
  }
  if (!cluster.siteName) return <>{EMPTY_VALUE}</>;
  return <span data-testid={testId}>{cluster.siteName}</span>;
};
