// A cluster's site, as the backend's status.location gives it (site.ts).
import { Tooltip } from '@patternfly/react-core';
import { SubtleText } from '../../components/SubtleText';
import { EMPTY_VALUE } from '../../utilities/format';
import type { ClusterView } from './clusterView';
import { MissingLabel } from './MissingLabel';
import { isFromCloudRegion, siteOf } from './site';

type Located = Pick<ClusterView, 'name' | 'siteName' | 'region' | 'locationSource' | 'locationProblem'>;

/** Why a cluster's site is its cloud region, in the tooltip on "(cloud region)". */
export const CLOUD_REGION_REASON = 'No site is set for this cluster. The map shows it at its cloud region.';

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
 * The site's name or the cloud region (SiteText), and a warning with what to fix when the
 * coordinate annotations are wrong.
 */
export const ClusterSite: React.FC<{ cluster: Located; testId: string }> = ({ cluster, testId }) => {
  const text = siteOf(cluster);
  if (cluster.locationProblem) {
    return (
      <MissingLabel testId={testId} reason={cluster.locationProblem}>
        {text ?? 'Invalid position'}
      </MissingLabel>
    );
  }
  if (!text) return <>{EMPTY_VALUE}</>;
  return <SiteText text={text} fromCloudRegion={isFromCloudRegion(cluster)} testId={testId} />;
};
