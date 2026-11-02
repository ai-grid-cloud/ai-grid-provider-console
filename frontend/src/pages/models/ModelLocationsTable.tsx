// The model on each cluster its placement names, in the UX team's Models design ("models per
// cluster"): a row per cluster with the status the backend reports for it (ModelStatus.clusters,
// proposal P13), which opens what that cluster reported. While no cluster has reported the model
// (the backend's SavedToGit), the rows are the clusters the placement chose, each Pending sync:
// an outline purple label, and it opens nothing.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Label, Tooltip } from '@patternfly/react-core';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ClusterView } from '../clusters/clusterView';
import { StatusLabel } from '../../components/StatusLabel';
import { EMPTY_VALUE } from '../../utilities/format';
import { locationLabel } from './modelUtils';
import { DeploymentStatusModal } from './DeploymentStatusModal';
import { clusterDeploymentStatus } from './modelStatusInfo';
import { titleOf, type ModelView } from './modelView';

type Props = {
  model: ModelView;
  /** The hub's clusters, for each cluster's location. */
  clusters: Pick<ClusterView, 'name' | 'location' | 'consoleUrl'>[];
  siteNames: Map<string, string>;
  /** Inside the Models page's expanded row. */
  isNested?: boolean;
};

/** The model's locations: each placed cluster's status, or the clusters the placement chose. */
export const ModelLocationsTable: React.FC<Props> = ({ model, clusters, siteNames, isNested }) => {
  // The open status's cluster, not its entry: each poll brings new entries, and the dialog shows the
  // current one, or closes when the model no longer has the cluster.
  const [openCluster, setOpenCluster] = useState<string>();
  const open = model.clusters.find((c) => c.cluster === openCluster);
  const title = titleOf(model);
  const known = (cluster: string) => clusters.find((c) => c.name === cluster);
  const locationOf = (cluster: string) => {
    const location = known(cluster)?.location;
    return location ? locationLabel(location, siteNames) : cluster;
  };
  /** The location as a label. The cluster name is its own column. */
  const locationCell = (cluster: string) => {
    const location = locationOf(cluster);
    // In a div, so the stacked phone layout doesn't stretch the label across the cell.
    return (
      <div>
        <Label isCompact color="grey" data-testid="model-cluster-location">
          {location}
        </Label>
      </div>
    );
  };
  const clusterCell = (cluster: string) => <Link to={`/clusters/${encodeURIComponent(cluster)}`}>{cluster}</Link>;
  const consoleLink = (cluster: string) => {
    const url = known(cluster)?.consoleUrl;
    if (!url) {
      return EMPTY_VALUE;
    }
    return (
      <Tooltip content="View more details and options in the cluster console">
        <Button
          variant="link"
          isInline
          component="a"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          icon={<ExternalLinkAltIcon />}
          iconPosition="end"
          aria-label={`View ${cluster} in cluster console`}
        >
          View
        </Button>
      </Tooltip>
    );
  };

  if (model.clusters.length === 0) {
    return (
      <Table
        aria-label={`Locations of ${title}`}
        variant="compact"
        isNested={isNested}
        borders={isNested ? false : undefined}
        data-testid={`model-selected-clusters-${model.id}`}
      >
        <Thead>
          <Tr resetOffset={isNested}>
            <Th>Cluster</Th>
            <Th>Location</Th>
            <Th>Status</Th>
            <Th modifier="fitContent" screenReaderText="Actions" />
          </Tr>
        </Thead>
        <Tbody>
          {model.selectedClusters.map((cluster) => (
            <Tr key={cluster} resetOffset={isNested} data-testid="model-selected-cluster-row">
              <Td dataLabel="Cluster" data-testid="model-cluster-name">
                {clusterCell(cluster)}
              </Td>
              <Td dataLabel="Location">{locationCell(cluster)}</Td>
              <Td dataLabel="Status">
                <div>
                  <StatusLabel
                    isCompact
                    status="Pending sync"
                    screenReaderSuffix={` at ${locationOf(cluster)}`}
                    data-testid="model-cluster-phase"
                  />
                </div>
              </Td>
              <Td dataLabel="Actions" modifier="fitContent">
                {consoleLink(cluster)}
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    );
  }

  return (
    <>
      <Table
        aria-label={`Locations of ${title}`}
        variant="compact"
        isNested={isNested}
        borders={isNested ? false : undefined}
        data-testid={`model-clusters-${model.id}`}
      >
        <Thead>
          {/* resetOffset: inside the Models page's expanded row, the nested table's first column lines
              up with the row's Name, as PatternFly's nested tables and the UX design do. */}
          <Tr resetOffset={isNested}>
            <Th>Cluster</Th>
            <Th>Location</Th>
            <Th>Status</Th>
            <Th modifier="fitContent" screenReaderText="Actions" />
          </Tr>
        </Thead>
        <Tbody>
          {model.clusters.map((status) => (
            <Tr key={status.cluster} resetOffset={isNested} data-testid="model-cluster-row">
              <Td dataLabel="Cluster" data-testid="model-cluster-name">
                {clusterCell(status.cluster)}
              </Td>
              <Td dataLabel="Location">{locationCell(status.cluster)}</Td>
              <Td dataLabel="Status">
                <div>
                  <StatusLabel
                    isCompact
                    status={clusterDeploymentStatus(status.phase)}
                    onClick={() => setOpenCluster(status.cluster)}
                    screenReaderSuffix={` at ${locationOf(status.cluster)}`}
                    data-testid="model-cluster-phase"
                  />
                </div>
              </Td>
              <Td dataLabel="Actions" modifier="fitContent">
                {consoleLink(status.cluster)}
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
      {open && (
        <DeploymentStatusModal
          title={title}
          phase={clusterDeploymentStatus(open.phase)}
          locationLabel={locationOf(open.cluster)}
          cluster={open.cluster}
          reason={open.reason}
          message={open.message}
          createdAt={model.creationTimestamp}
          onClose={() => setOpenCluster(undefined)}
        />
      )}
    </>
  );
};
