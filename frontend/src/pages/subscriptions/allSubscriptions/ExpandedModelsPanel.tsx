// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/ExpandedModelsPanel.tsx
// upstream commit: 6f47c0f775d19c89ef02f74d192b32dc7d3c669d
// The console adds the Locations column (where the model's placement put it), as the org admin's
// view shows regions, named and styled as the Models page names them, and moves the model's
// description into a popover by its name.
import { Button, Label, LabelGroup, Popover, Skeleton } from '@patternfly/react-core';
import { OutlinedQuestionCircleIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ManagedModel, ModelSubscriptionRef } from '../../../api/types';
import { TableRowTitleDescription } from '../../../components/TableRowTitleDescription';
import { isSameModel, modelKey } from '../../../utilities/authpolicies';
import { EMPTY_VALUE } from '../../../utilities/format';
import { formatTokenRateLimitLine } from '../../../utilities/rateLimits';
import { locationLabel } from '../../models/modelUtils';

/** Whether the hub's models have loaded: until then, or when they fail, no locations are known. */
export type ModelsState = 'loading' | 'loaded' | 'failed';

type Props = {
  modelRefs: ModelSubscriptionRef[];
  /** The hub's models, for each reference's locations, display name and description. */
  models: ManagedModel[];
  modelsState: ModelsState;
  /** Each location's site name, for "Paris DC1 (paris)" as on the Models page. */
  siteNames: Map<string, string>;
};

const locationsCell = (
  model: ManagedModel | undefined,
  modelsState: ModelsState,
  siteNames: Map<string, string>,
): React.ReactNode => {
  if (modelsState === 'loading') {
    return <Skeleton width="6rem" screenreaderText="Loading locations" />;
  }
  if (modelsState === 'failed') {
    return 'Unavailable';
  }
  const locations = model?.locations ?? [];
  return locations.length ? (
    <LabelGroup numLabels={4}>
      {locations.map((location) => (
        <Label key={location} color="grey" isCompact>
          {locationLabel(location, siteNames)}
        </Label>
      ))}
    </LabelGroup>
  ) : (
    EMPTY_VALUE
  );
};

const tokenLimits = (ref: ModelSubscriptionRef): string => {
  if (ref.unlimited) {
    return 'Unlimited';
  }
  const limits = Array.isArray(ref.tokenRateLimits) ? ref.tokenRateLimits : [];
  return limits.length
    ? limits.map(({ limit, window }) => formatTokenRateLimitLine(limit, window)).join(', ')
    : EMPTY_VALUE;
};

/** A subscription's models in its row's expansion: name, where each runs, and its token limits. */
export const ExpandedModelsPanel: React.FC<Props> = ({ modelRefs, models, modelsState, siteNames }) => (
  <Table aria-label="Subscription models" variant="compact" data-testid="subscription-models-expanded-panel">
    <Thead>
      <Tr>
        <Th width={40}>Model name</Th>
        <Th width={30}>Locations</Th>
        <Th width={30}>Token limits</Th>
      </Tr>
    </Thead>
    <Tbody>
      {modelRefs.length === 0 ? (
        <Tr>
          <Td colSpan={3}>No models</Td>
        </Tr>
      ) : (
        modelRefs.map((ref) => {
          const model = models.find((m) => isSameModel(m, ref));
          const title = ref.displayName ?? model?.displayName ?? ref.name;
          const description = ref.description ?? model?.description;
          return (
            <Tr key={modelKey(ref)} data-testid="expanded-subscription-model-row">
              <Td dataLabel="Model name">
                <TableRowTitleDescription
                  title={
                    <>
                      <strong>{title}</strong>
                      {description && (
                        <Popover headerContent={title} bodyContent={description}>
                          <Button
                            variant="plain"
                            hasNoPadding
                            className="pf-v6-u-ml-sm"
                            aria-label={`About ${title}`}
                            icon={<OutlinedQuestionCircleIcon />}
                          />
                        </Popover>
                      )}
                    </>
                  }
                  subtitle={<code>{ref.name}</code>}
                />
              </Td>
              <Td dataLabel="Locations" data-testid="expanded-subscription-model-locations">
                {locationsCell(model, modelsState, siteNames)}
              </Td>
              <Td dataLabel="Token limits" data-testid="expanded-subscription-model-token-limits">
                {tokenLimits(ref)}
              </Td>
            </Tr>
          );
        })
      )}
    </Tbody>
  </Table>
);
