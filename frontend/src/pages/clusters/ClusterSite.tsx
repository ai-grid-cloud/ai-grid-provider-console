// A cluster's site, as the backend's status.location gives it (site_name).
import { EMPTY_VALUE } from '../../utilities/format';
import type { ClusterView } from './clusterView';
import { MissingLabel } from '../../components/MissingLabel';

type Located = Pick<ClusterView, 'siteName' | 'locationProblem'>;

/**
 * The cluster's site: the name a hub admin set (annotation ai-grid/site-name). The list warns, and
 * says what to fix, when the coordinate annotations are wrong. The cluster page leaves that out
 * (`showProblem` false): the map position carries it. No fallback to the cloud region, which has a
 * column of its own.
 */
export const ClusterSite: React.FC<{ cluster: Located; testId: string; showProblem?: boolean }> = ({
  cluster,
  testId,
  showProblem = true,
}) => {
  if (showProblem && cluster.locationProblem) {
    return (
      <MissingLabel testId={testId} reason={cluster.locationProblem}>
        {cluster.siteName ?? 'Invalid position'}
      </MissingLabel>
    );
  }
  if (!cluster.siteName) return <>{EMPTY_VALUE}</>;
  return <span data-testid={testId}>{cluster.siteName}</span>;
};
