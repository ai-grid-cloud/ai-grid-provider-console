// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/viewSubscription/SubscriptionGroupsSection.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/viewSubscription/SubscriptionGroupsSection.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { Bullseye, Content, Flex, FlexItem, Stack, StackItem, Title } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { GroupReference } from '../../../api/types';

type Props = { groups: GroupReference[] };

export const SubscriptionGroupsSection: React.FC<Props> = ({ groups }) => (
  <Stack hasGutter data-testid="subscription-groups-section">
    <StackItem>
      <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsSm' }}>
        <FlexItem>
          <Title headingLevel="h2" size="xl">
            Groups
          </Title>
        </FlexItem>
        <FlexItem>
          <Content component="p">User groups that can use models in this subscription.</Content>
        </FlexItem>
      </Flex>
    </StackItem>
    <StackItem>
      {groups.length === 0 ? (
        <Bullseye>
          <Content component="p">No groups assigned to this subscription.</Content>
        </Bullseye>
      ) : (
        <Table aria-label="Subscription groups" variant="compact" data-testid="subscription-groups-table">
          <Thead>
            <Tr>
              <Th>Name</Th>
            </Tr>
          </Thead>
          <Tbody>
            {groups.map((group) => (
              <Tr key={group.name}>
                <Td dataLabel="Name">{group.name}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </StackItem>
  </Stack>
);
