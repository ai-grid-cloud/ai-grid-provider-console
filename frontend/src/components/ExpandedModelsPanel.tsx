// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/ExpandedModelsPanel.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/ExpandedModelsPanel.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { Content, ContentVariants } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ModelRef, ModelSubscriptionRef } from '../api/types';
import { formatTokenLimits } from '../utilities/rateLimits';

type Props = {
  models: ModelSubscriptionRef[] | ModelRef[];
  showTokenLimits?: boolean;
  testIdResource?: string;
};

/** A subscription's models and their token limits, in a compound-expand row. */
export const ExpandedModelsPanel: React.FC<Props> = ({
  models,
  showTokenLimits = true,
  testIdResource = 'subscription',
}) => (
  <Table
    aria-label={`${testIdResource} models`}
    data-testid={`${testIdResource}-models-expanded-panel`}
    variant="compact"
    borders
  >
    <Thead>
      <Tr>
        <Th width={70}>Model name</Th>
        {showTokenLimits && <Th width={30}>Token limits</Th>}
      </Tr>
    </Thead>
    <Tbody>
      {models.length === 0 ? (
        <Tr>
          <Td colSpan={showTokenLimits ? 2 : 1} data-testid={`empty-${testIdResource}-models-expanded-panel`}>
            No models
          </Td>
        </Tr>
      ) : (
        models.map((model) => (
          <Tr key={model.name} data-testid={`expanded-${testIdResource}-model-row`}>
            <Td dataLabel="Model name">
              <span className="pf-v6-u-font-weight-bold" data-testid={`${testIdResource}-expanded-model-display-name`}>
                {model.displayName ?? model.name}
              </span>
              {model.displayName && model.displayName !== model.name && (
                <Content data-testid={`${testIdResource}-expanded-model-resource-name`}>{model.name}</Content>
              )}
              {model.description && (
                <Content data-testid={`${testIdResource}-expanded-model-description`} component={ContentVariants.small}>
                  {model.description}
                </Content>
              )}
            </Td>
            {showTokenLimits && 'tokenRateLimits' in model && (
              <Td dataLabel="Token limits" data-testid={`${testIdResource}-expanded-model-token-limits`}>
                {model.unlimited ? 'Unlimited' : formatTokenLimits(model.tokenRateLimits)}
              </Td>
            )}
          </Tr>
        ))
      )}
    </Tbody>
  </Table>
);
