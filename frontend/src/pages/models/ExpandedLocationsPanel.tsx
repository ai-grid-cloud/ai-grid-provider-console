// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ExpandedLocationsPanel.tsx at 62319b8.
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

type Props = { locations: string[] };

/** The locations of one model deployment, in its expanded table row. */
export const ExpandedLocationsPanel: React.FC<Props> = ({ locations }) => (
  <Table aria-label="Locations" data-testid="locations-expanded-panel" variant="compact" borders>
    <Thead>
      <Tr>
        <Th>Location name</Th>
      </Tr>
    </Thead>
    <Tbody>
      {locations.length === 0 ? (
        <Tr>
          <Td>No locations</Td>
        </Tr>
      ) : (
        locations.map((location) => (
          <Tr key={location}>
            <Td dataLabel="Location name">{location}</Td>
          </Tr>
        ))
      )}
    </Tbody>
  </Table>
);
