// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/ExpandedGroupsPanel.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/ExpandedGroupsPanel.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { GroupReference } from '../api/types';

type Props = { groups: GroupReference[] };

/** A subscription's groups, in a compound-expand row. */
export const ExpandedGroupsPanel: React.FC<Props> = ({ groups }) => (
  <Table aria-label="Groups" data-testid="groups-expanded-panel" variant="compact" borders>
    <Thead>
      <Tr>
        <Th>Group name</Th>
      </Tr>
    </Thead>
    <Tbody>
      {groups.length === 0 ? (
        <Tr>
          <Td data-testid="empty-groups-expanded-panel">No groups</Td>
        </Tr>
      ) : (
        groups.map((group) => (
          <Tr key={group.name} data-testid="expanded-group-item">
            <Td dataLabel="Group name" data-testid="expanded-group-name">
              {group.name}
            </Td>
          </Tr>
        ))
      )}
    </Tbody>
  </Table>
);
