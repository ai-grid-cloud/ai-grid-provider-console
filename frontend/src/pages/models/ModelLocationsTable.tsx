// The model on each cluster its placement names, in the UX team's Models design ("models per
// cluster"): a row per cluster with the status the backend reports for it (ModelStatus.clusters,
// proposal P13), which opens what that cluster reported. While no cluster has reported the model
// (the backend's SavedToGit), the rows are the clusters the placement chose, with one line saying
// no status is reported yet and no Status column to repeat it. The page adds no status of its own.
import { useState } from 'react';
import {
  Button,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Flex,
  FlexItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  Tooltip,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ClusterView } from '../clusters/clusterView';
import { StatusLabel } from '../../components/StatusLabel';
import { SubtleText } from '../../components/SubtleText';
import { EMPTY_VALUE } from '../../utilities/format';
import { locationLabel } from './modelUtils';
import { titleOf, type ModelClusterView, type ModelView } from './modelView';

type Props = {
  model: ModelView;
  /** The hub's clusters, for each cluster's location. */
  clusters: Pick<ClusterView, 'name' | 'location'>[];
  siteNames: Map<string, string>;
  /** Opens the model's edit page from a cluster's status; absent for a viewer. */
  onEdit?: () => void;
  /** Inside the Models page's expanded row. */
  isNested?: boolean;
};

/** What one cluster reported about the model, opened from its status in the table. */
const ClusterStatusModal: React.FC<{
  model: ModelView;
  status: ModelClusterView;
  location: string;
  onClose: () => void;
  onEdit?: () => void;
}> = ({ model, status, location, onClose, onEdit }) => (
  <Modal
    isOpen
    variant="small"
    onClose={onClose}
    aria-labelledby="cluster-status-modal-title"
    data-testid="cluster-status-modal"
  >
    <ModalHeader
      labelId="cluster-status-modal-title"
      title={
        <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>{titleOf(model)} status</FlexItem>
          <FlexItem>
            <StatusLabel isCompact status={status.phase} />
          </FlexItem>
        </Flex>
      }
      description={
        <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <Label color="grey">{location}</Label>
          </FlexItem>
          {location !== status.cluster && <FlexItem>on cluster {status.cluster}</FlexItem>}
        </Flex>
      }
    />
    <ModalBody>
      <DescriptionList isCompact aria-label={`What ${status.cluster} reported`}>
        <DescriptionListGroup>
          <DescriptionListTerm>Reason</DescriptionListTerm>
          <DescriptionListDescription>{status.reason || EMPTY_VALUE}</DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Message</DescriptionListTerm>
          <DescriptionListDescription>{status.message ?? EMPTY_VALUE}</DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>
    </ModalBody>
    {onEdit && (
      <ModalFooter>
        <Button variant="link" onClick={onEdit}>
          Edit model
        </Button>
      </ModalFooter>
    )}
  </Modal>
);

/** The model's locations: each placed cluster's status, or the clusters the placement chose. */
export const ModelLocationsTable: React.FC<Props> = ({ model, clusters, siteNames, onEdit, isNested }) => {
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
          <SubtleText>No cluster has reported a status for this model.</SubtleText>
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
        <ClusterStatusModal
          model={model}
          status={open}
          location={locationOf(open.cluster)}
          onClose={() => setOpenCluster(undefined)}
          onEdit={onEdit}
        />
      )}
    </>
  );
};
