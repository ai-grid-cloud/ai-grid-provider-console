// A cluster's data center, as the backend's status.location gives it (site_name), and SiteText for the map's lists.
import { Tooltip } from '@patternfly/react-core';
import { SubtleText } from '../../components/SubtleText';
import { EMPTY_VALUE } from '../../utilities/format';
import type { ClusterView } from './clusterView';
import { MissingLabel } from './MissingLabel';

type Located = Pick<ClusterView, 'siteName' | 'locationProblem'>;

/** Why a cluster's site is its cloud region, in the tooltip on "(cloud region)". */
export const CLOUD_REGION_REASON = 'No site is set on this cluster; the map places it by its cloud region.';

/**
 * A site's text: the site's name, or the cloud region followed by "(cloud region)" when no site is
 * set, with why in a tooltip (it takes focus, so the keyboard reaches it too).
 */
export const SiteText: React.FC<{ text: string; fromCloudRegion: boolean; testId?: string }> = ({
  text,
  fromCloudRegion,
  testId,
}) =>
  fromCloudRegion ? (
    <Tooltip content={CLOUD_REGION_REASON}>
      <span tabIndex={0} data-testid={testId}>
        {text} <SubtleText>(cloud region)</SubtleText>
      </span>
    </Tooltip>
  ) : (
    <span data-testid={testId}>{text}</span>
  );

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
