// The model on each cluster it was sent to, in jgiardino's Models design ("models per cluster"):
// a row per location with its status, which opens that location's status. One row per work, so
// two clusters at one location are two rows, each with its own status as the backend derived it
// (proposal P13); the page adds no status of its own.
import { useState } from 'react';
import { Label, Tooltip } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { GridCluster, ManagedModel, ModelWork } from '../../api/types';
import { getPhaseProps } from '../../utilities/phaseLabelUtils';
import { DeploymentStatusModal } from './DeploymentStatusModal';
import { locationLabel } from './modelUtils';

type Props = {
  model: ManagedModel;
  works: ModelWork[];
  /** The hub's clusters, for each work's location. */
  clusters: GridCluster[];
  siteNames: Map<string, string>;
  /** Opens the model's edit page from a location's status; absent for a viewer. */
  onEdit?: () => void;
  /** Inside the Models page's expanded row. */
  isNested?: boolean;
};

/** The model's locations and each one's status; a status opens DeploymentStatusModal. */
export const ModelLocationsTable: React.FC<Props> = ({ model, works, clusters, siteNames, onEdit, isNested }) => {
  // The open status's cluster, not its work: each poll brings new works, and the dialog shows the
  // current one, or closes when the model no longer has a work there.
  const [openCluster, setOpenCluster] = useState<string>();
  const open = works.find((work) => work.cluster === openCluster);
  const title = model.displayName ?? model.name;
  const locationOf = (work: ModelWork) => {
    const location = clusters.find((c) => c.name === work.cluster)?.location;
    return location ? locationLabel(location, siteNames) : work.cluster;
  };
  return (
    <>
      <Table
        aria-label={`Locations of ${title}`}
        variant="compact"
        isNested={isNested}
        data-testid={`model-works-${model.name}`}
      >
        <Thead>
          {/* resetOffset: inside the Models page's expanded row, the nested table's first column lines
              up with the row's Name, as PatternFly's nested tables and jgiardino's design do. */}
          <Tr resetOffset={isNested}>
            <Th>Location</Th>
            <Th modifier="fitContent">Status</Th>
          </Tr>
        </Thead>
        <Tbody>
          {works.map((work) => {
            const location = locationOf(work);
            const { icon, status, color } = getPhaseProps(work.phase);
            return (
              <Tr key={work.cluster} resetOffset={isNested} data-testid="model-work-row">
                <Td dataLabel="Location">
                  {/* In a div, so the stacked phone layout doesn't stretch the label across the cell.
                      The cluster is detail most rows don't need (one cluster per location): it shows
                      on hover, is read with the location by a screen reader, and the status dialog
                      names it too. A location without a label shows its cluster's name instead. */}
                  <div>
                    {location === work.cluster ? (
                      <Label color="grey">{location}</Label>
                    ) : (
                      <Tooltip content={`Cluster: ${work.cluster}`}>
                        <Label color="grey" data-testid="model-work-location">
                          {location}
                          <span className="pf-v6-screen-reader">, cluster {work.cluster}</span>
                        </Label>
                      </Tooltip>
                    )}
                  </div>
                </Td>
                <Td dataLabel="Status" modifier="fitContent">
                  <div>
                    <Label
                      icon={icon}
                      status={status}
                      color={color}
                      variant="filled"
                      onClick={() => setOpenCluster(work.cluster)}
                      data-testid="model-work-phase"
                    >
                      {work.phase}
                      <span className="pf-v6-screen-reader"> at {location}</span>
                    </Label>
                  </div>
                </Td>
              </Tr>
            );
          })}
        </Tbody>
      </Table>
      {open && (
        <DeploymentStatusModal
          model={model}
          work={open}
          location={locationOf(open)}
          onClose={() => setOpenCluster(undefined)}
          onEdit={onEdit}
        />
      )}
    </>
  );
};
