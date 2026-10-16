// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/SubscriptionsToolbar.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/SubscriptionsToolbar.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's FilterToolbar (one keyword filter and "Clear all filters") is inlined.
import { Link } from 'react-router-dom';
import { Button, SearchInput, Toolbar, ToolbarContent, ToolbarGroup, ToolbarItem } from '@patternfly/react-core';
import { getSubscriptionCreateUrl } from '../../../utilities/maasGovernanceNavigation';
import type { SubscriptionsFilterDataType } from './const';
import { SubscriptionsFilterOptions } from './const';

type Props = {
  filterData: SubscriptionsFilterDataType;
  onFilterUpdate: (key: SubscriptionsFilterOptions, value?: string) => void;
  /** Shows Create subscription. */
  canWrite: boolean;
};

export const SubscriptionsToolbar: React.FC<Props> = ({ filterData, onFilterUpdate, canWrite }) => {
  const keyword = filterData[SubscriptionsFilterOptions.keyword] ?? '';
  return (
    <Toolbar data-testid="subscriptions-table-toolbar">
      <ToolbarContent>
        <ToolbarItem>
          <SearchInput
            style={{ minWidth: '350px' }}
            aria-label="Filter by name, resource name, or description"
            placeholder="Filter by name, resource name, or description"
            value={keyword}
            onChange={(_event, value) => onFilterUpdate(SubscriptionsFilterOptions.keyword, value)}
            onClear={() => onFilterUpdate(SubscriptionsFilterOptions.keyword, '')}
            data-testid="subscriptions-filter-input"
          />
        </ToolbarItem>
        {canWrite && (
          <ToolbarGroup>
            <ToolbarItem>
              <Button
                variant="primary"
                component={(props) => <Link {...props} to={getSubscriptionCreateUrl()} />}
                data-testid="create-subscription-button"
              >
                Create subscription
              </Button>
            </ToolbarItem>
          </ToolbarGroup>
        )}
        {keyword && (
          <ToolbarItem>
            <Button variant="link" onClick={() => onFilterUpdate(SubscriptionsFilterOptions.keyword, '')}>
              Clear all filters
            </Button>
          </ToolbarItem>
        )}
      </ToolbarContent>
    </Toolbar>
  );
};
