import {
  Alert,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Stack,
  Title,
} from '@patternfly/react-core';
import { HelpPopover } from '../../components/HelpPopover';
import { EMPTY_VALUE } from '../../utilities/format';
import type { ClusterView } from './clusterView';
import { isFromCloudRegion } from './site';

/** The annotation keys a hub admin sets, in parentheses as the sentence reads. */
const KEYS = (
  <>
    (<code>ai-grid/latitude</code> and <code>ai-grid/longitude</code>)
  </>
);

/**
 * What a map position is and how a hub admin sets one, the same wherever the console explains it
 * (UXD's wording). The keys and the cloud-region fallback are the backend's
 * (internal/servers/managed_cluster_location.go). `withoutEither` adds what happens when neither
 * applies, which the cluster details page says and the AI grid page's "not shown" note implies.
 */
export const MapPositionAbout: React.FC<{ withoutEither?: boolean }> = ({ withoutEither }) => (
  <Stack hasGutter>
    <p>
      The map position is a set of coordinates expressed in decimal degrees that determines where the cluster appears on
      the AI grid map.
    </p>
    <p>
      Map position can be either set using annotations {KEYS} or inherited from the region.
      {withoutEither && ' If neither option is available, the cluster will not appear on the map.'}
    </p>
  </Stack>
);

/** Where the position came from, as the backend reports it; a problem is always about the annotations. */
const sourceOf = (c: ClusterView): string => {
  if (c.locationProblem || c.locationSource === 'annotations') return 'Annotations';
  if (isFromCloudRegion(c)) return c.region ? `Cloud region (${c.region})` : 'Cloud region';
  return EMPTY_VALUE;
};

/**
 * The help beside a cluster's map position: what a map position is and how it's set, always; then
 * this cluster's source and coordinates; then, when there is none, why. An invalid position shows
 * the backend's own problem text, which says which of its several checks failed.
 */
export const PositionHelp: React.FC<{ cluster: ClusterView }> = ({ cluster: c }) => {
  const placed = c.latitude !== undefined && c.longitude !== undefined;
  const details: [string, string][] = [
    ['Source', sourceOf(c)],
    ['Latitude', placed ? String(c.latitude) : EMPTY_VALUE],
    ['Longitude', placed ? String(c.longitude) : EMPTY_VALUE],
  ];
  return (
    <HelpPopover topic="a cluster's map position">
      <Stack hasGutter>
        <MapPositionAbout withoutEither />
        <Title headingLevel="h3" size="md">
          Map position details
        </Title>
        <DescriptionList isCompact isHorizontal aria-label="Map position details">
          {details.map(([term, value]) => (
            <DescriptionListGroup key={term}>
              <DescriptionListTerm>{term}</DescriptionListTerm>
              <DescriptionListDescription>{value}</DescriptionListDescription>
            </DescriptionListGroup>
          ))}
        </DescriptionList>
        {c.locationProblem ? (
          <Alert isInline isPlain variant="warning" title="Invalid position">
            {c.locationProblem}
          </Alert>
        ) : (
          !placed && (
            <Alert isInline isPlain variant="info" title="No position available">
              No position is set by annotations, and one cannot be inherited from the region.
            </Alert>
          )
        )}
      </Stack>
    </HelpPopover>
  );
};
