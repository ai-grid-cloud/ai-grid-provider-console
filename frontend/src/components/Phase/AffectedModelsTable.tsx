// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/Phase/AffectedModelsTable.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/Phase/AffectedModelsTable.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { Flex, FlexItem, Label, Stack, StackItem, Title } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { AffectedModel } from '../../utilities/phaseLabelUtils';
import { getPhaseProps, normalizePhase } from '../../utilities/phaseLabelUtils';

type Props = { models: AffectedModel[] };

const columns = [
  { title: 'Model name', key: 'name' },
  { title: 'Status', key: 'phase' },
  { title: 'Description', key: 'statusMessage' },
];

const StatusLabel: React.FC<{ phase: string }> = ({ phase }) => {
  const normalized = normalizePhase(phase);
  const labelProps = getPhaseProps(normalized);
  return (
    <Label status={labelProps.status} color={labelProps.color} icon={labelProps.icon}>
      {normalized}
    </Label>
  );
};

/** The models that keep a degraded subscription from being Ready. */
export const AffectedModelsTable: React.FC<Props> = ({ models }) => (
  <Stack hasGutter data-testid="affected-models-table">
    <StackItem>
      <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsSm' }}>
        <FlexItem>
          <Title headingLevel="h2" size="xl">
            Affected models{' '}
            <Label variant="filled" color="grey">
              {models.length}
            </Label>
          </Title>
        </FlexItem>
      </Flex>
    </StackItem>
    <StackItem>
      <Table aria-label="Affected models" variant="compact">
        <Thead>
          <Tr>
            {columns.map((column) => (
              <Th key={column.key}>{column.title}</Th>
            ))}
          </Tr>
        </Thead>
        <Tbody>
          {models.map((model) => (
            <Tr key={model.name} data-testid="affected-model-row">
              <Td dataLabel="Model name">
                <span data-testid={`affected-model-name-${model.name}`}>{model.displayName ?? model.name}</span>
              </Td>
              <Td dataLabel="Status">
                <span data-testid={`affected-model-status-${model.name}`}>
                  <StatusLabel phase={model.phase ?? ''} />
                </span>
              </Td>
              <Td dataLabel="Description">
                <span data-testid={`affected-model-status-message-${model.name}`}>
                  {model.statusMessage ?? 'No status message.'}
                </span>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </StackItem>
  </Stack>
);
