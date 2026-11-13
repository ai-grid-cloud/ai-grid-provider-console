import { HelpPopover } from '../../components/HelpPopover';
import type { ClusterView } from './clusterView';
import { isFromCloudRegion } from './site';

const Line: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div>
    <code>{children}</code>
  </div>
);

/**
 * Where the cluster's map position comes from, behind a help icon beside it: the hub admin's
 * annotations, the cloud region's area, that the annotations can't be used, or how to set one when there is none. The keys and the
 * cloud-region fallback are the backend's (internal/servers/managed_cluster_location.go).
 */
export const PositionHelp: React.FC<{ cluster: ClusterView }> = ({ cluster: c }) => {
  let body: React.ReactNode;
  if ((c.latitude === undefined || c.longitude === undefined) && c.locationProblem) {
    body = (
      <>
        Invalid <code>ai-grid/latitude</code> and <code>ai-grid/longitude</code> annotations. Use decimal degrees, such
        as 40.7128 and -74.006.
      </>
    );
  } else if (c.latitude === undefined || c.longitude === undefined) {
    body = (
      <>
        Not set. Add the <code>ai-grid/latitude</code> and <code>ai-grid/longitude</code> annotations, or use a cluster
        whose cloud region the map knows.
      </>
    );
  } else if (isFromCloudRegion(c)) {
    const region = `region (${c.region ?? 'unknown'})`;
    body = (
      <>
        <Line>{`${region} latitude: ${c.latitude}`}</Line>
        <Line>{`${region} longitude: ${c.longitude}`}</Line>
      </>
    );
  } else {
    body = (
      <>
        <Line>{`ai-grid/latitude: ${c.latitude}`}</Line>
        <Line>{`ai-grid/longitude: ${c.longitude}`}</Line>
      </>
    );
  }
  return <HelpPopover topic="a cluster's map position">{body}</HelpPopover>;
};
