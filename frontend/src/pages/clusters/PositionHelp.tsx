import { HelpPopover } from '../../components/HelpPopover';

/**
 * How a hub admin sets where the map puts a cluster, behind a help icon where a cluster is "not on the map" or placed
 * from its cloud region. The keys and the cloud-region fallback are the backend's
 * (internal/servers/managed_cluster_location.go).
 */
export const PositionHelp: React.FC = () => (
  <HelpPopover topic="a cluster's map position">
    The map places a cluster from two annotations on its ManagedCluster: <code>ai-grid/latitude</code> and{' '}
    <code>ai-grid/longitude</code>, in decimal degrees (for example, 39.9612 and -82.9988). Optionally,{' '}
    <code>ai-grid/site-name</code> sets the name the map shows. Without them, the map uses the approximate area of the
    cluster&apos;s cloud region, when it knows the region. Ask a hub administrator to set the annotations. The position
    isn&apos;t the location label, and neither one places models: models are placed on clusters by name.
  </HelpPopover>
);
