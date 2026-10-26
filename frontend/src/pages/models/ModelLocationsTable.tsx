// The model on each cluster its placement names, in the UX team's Models design ("models per
// cluster"): a row per cluster with the status the backend reports for it (ModelStatus.clusters,
// proposal P13), which opens what that cluster reported. While no cluster has reported the model
// (the backend's SavedToGit), the rows are the clusters the placement chose, with one line saying
// no status is reported yet and no Status column to repeat it. The page adds no status of its own.
import { useState } from 'react';
import { Content, Label, Stack, Tooltip } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ClusterView } from '../clusters/clusterView';
import { StatusLabel } from '../../components/StatusLabel';
import { SubtleText } from '../../components/SubtleText';
import { locationLabel } from './modelUtils';
import { DeploymentStatusModal } from './DeploymentStatusModal';
import { titleOf, type ModelView } from './modelView';

type Props = {
  model: ModelView;
  /** The hub's clusters, for each cluster's location. */
  clusters: Pick<ClusterView, 'name' | 'location'>[];
  siteNames: Map<string, string>;
  /** Opens the model's edit page from a cluster's status; absent for a viewer. */
  onEdit?: () => void;
  /** Opens delete for the model; absent for a viewer. */
  onDelete?: () => void;
  /** Inside the Models page's expanded row. */
  isNested?: boolean;
};

/** The model's locations: each placed cluster's status, or the clusters the placement chose. */
export const ModelLocationsTable: React.FC<Props> = ({ model, clusters, siteNames, onEdit, onDelete, isNested }) => {
  // The open status's cluster, not its entry: each poll brings new entries, and the dialog shows the
  // current one, or closes when the model no longer has the cluster.
  const [openCluster, setOpenCluster] = useState<string>();
  const open = model.clusters.find((c) => c.cluster === openCluster);
  const title = titleOf(model);
  const locationOf = (cluster: string) => {
    const location = clusters.find((c) => c.name === cluster)?.location;
    return location ? locationLabel(location, siteNames) : cluster;
  };
  /** The location as a label; its cluster shows on hover and is read with it by a screen reader. */
  const locationCell = (cluster: string) => {
    const location = locationOf(cluster);
    // In a div, so the stacked phone layout doesn't stretch the label across the cell.
    return (
      <div>
        {location === cluster ? (
          <Label color="grey">{location}</Label>
        ) : (
          <Tooltip content={`Cluster: ${cluster}`}>
            <Label color="grey" data-testid="model-cluster-location">
              {location}
              <span className="pf-v6-screen-reader">, cluster {cluster}</span>
            </Label>
          </Tooltip>
        )}
      </div>
    );
  };

  if (model.clusters.length === 0) {
    return (
      <Stack hasGutter data-testid={`model-selected-clusters-${model.id}`}>
        <Content component="p">
          <SubtleText>No cluster has reported this model yet.</SubtleText>
        </Content>
        <Table aria-label={`Locations of ${title}`} variant="compact" isNested={isNested}>
          <Thead>
            <Tr resetOffset={isNested}>
              <Th>Location</Th>
            </Tr>
          </Thead>
          <Tbody>
            {model.selectedClusters.map((cluster) => (
              <Tr key={cluster} resetOffset={isNested} data-testid="model-selected-cluster-row">
                <Td dataLabel="Location">{locationCell(cluster)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Stack>
    );
  }

  return (
    <>
      <Table
        aria-label={`Locations of ${title}`}
        variant="compact"
        isNested={isNested}
        data-testid={`model-clusters-${model.id}`}
      >
        <Thead>
          {/* resetOffset: inside the Models page's expanded row, the nested table's first column lines
              up with the row's Name, as PatternFly's nested tables and the UX design do. */}
          <Tr resetOffset={isNested}>
            <Th>Location</Th>
            <Th modifier="fitContent">Status</Th>
          </Tr>
        </Thead>
        <Tbody>
          {model.clusters.map((status) => (
            <Tr key={status.cluster} resetOffset={isNested} data-testid="model-cluster-row">
              <Td dataLabel="Location">{locationCell(status.cluster)}</Td>
              <Td dataLabel="Status" modifier="fitContent">
                <div>
                  <StatusLabel
                    status={status.phase}
                    onClick={() => setOpenCluster(status.cluster)}
                    screenReaderSuffix={` at ${locationOf(status.cluster)}`}
                    data-testid="model-cluster-phase"
                  />
                </div>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
      {open && (
        <DeploymentStatusModal
          title={title}
          phase={open.phase}
          locationLabel={locationOf(open.cluster)}
          cluster={open.cluster}
          reason={open.reason}
          message={open.message}
          createdAt={model.creationTimestamp}
          onClose={() => setOpenCluster(undefined)}
          onEdit={onEdit}
          onStop={
            onDelete
              ? () => {
                  setOpenCluster(undefined);
                  onDelete();
                }
              : undefined
          }
        />
      )}
    </>
  );
};
