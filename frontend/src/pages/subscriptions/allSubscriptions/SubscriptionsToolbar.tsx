// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/SubscriptionsToolbar.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/SubscriptionsToolbar.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's FilterToolbar is inlined as PatternFly's attribute search: a menu picks what the
// search box filters (the subscription, or its models), and each filter in use shows as a label.
// Below md the filters fold behind PatternFly's filter toggle, where their labels show too
// (PaginatedTable collapses the labels at the same breakpoint).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  MenuToggle,
  SearchInput,
  Select,
  SelectList,
  SelectOption,
  ToolbarFilter,
  ToolbarGroup,
  ToolbarItem,
  ToolbarToggleGroup,
} from '@patternfly/react-core';
import { FilterIcon } from '@patternfly/react-icons';
import { getSubscriptionCreateUrl } from '../../../utilities/maasGovernanceNavigation';
import type { SubscriptionsFilterDataType } from './const';
import { SubscriptionsFilterOptions, subscriptionsFilterOptions } from './const';

type Props = {
  filterData: SubscriptionsFilterDataType;
  onFilterUpdate: (key: SubscriptionsFilterOptions, value?: string) => void;
  /** Shows Create subscription. */
  canWrite: boolean;
};

const attributes = Object.values(SubscriptionsFilterOptions);

/**
 * The subscriptions list's toolbar items: the filters and Create subscription. The toolbar's own
 * Clear all filters (PaginatedTable's clearAllFilters) follows the filters' labels.
 */
export const SubscriptionsToolbar: React.FC<Props> = ({ filterData, onFilterUpdate, canWrite }) => {
  const [attribute, setAttribute] = useState(SubscriptionsFilterOptions.keyword);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <ToolbarToggleGroup toggleIcon={<FilterIcon />} breakpoint="md">
        <ToolbarGroup variant="filter-group">
          <ToolbarItem>
            <Select
              isOpen={menuOpen}
              selected={attribute}
              // Back to the menu after a keyboard choice, instead of losing focus to the page.
              shouldFocusToggleOnSelect
              onSelect={(_event, value) => {
                setAttribute(value as SubscriptionsFilterOptions);
                setMenuOpen(false);
              }}
              onOpenChange={setMenuOpen}
              toggle={(ref) => (
                <MenuToggle
                  ref={ref}
                  icon={<FilterIcon />}
                  isExpanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label="Filter by"
                  data-testid="subscriptions-filter-attribute"
                >
                  {subscriptionsFilterOptions[attribute].label}
                </MenuToggle>
              )}
            >
              <SelectList>
                {attributes.map((key) => (
                  <SelectOption key={key} value={key}>
                    {subscriptionsFilterOptions[key].label}
                  </SelectOption>
                ))}
              </SelectList>
            </Select>
          </ToolbarItem>
          {attributes.map((key) => {
            const value = filterData[key] ?? '';
            const { label, placeholder } = subscriptionsFilterOptions[key];
            return (
              <ToolbarFilter
                key={key}
                categoryName={label}
                labels={value ? [value] : []}
                deleteLabel={() => onFilterUpdate(key, '')}
                showToolbarItem={attribute === key}
                className="console-toolbar-field"
              >
                <SearchInput
                  aria-label={placeholder}
                  placeholder={placeholder}
                  value={value}
                  onChange={(_event, next) => onFilterUpdate(key, next)}
                  onClear={() => onFilterUpdate(key, '')}
                  data-testid={
                    key === SubscriptionsFilterOptions.keyword
                      ? 'subscriptions-filter-input'
                      : `subscriptions-${key}-filter-input`
                  }
                />
              </ToolbarFilter>
            );
          })}
        </ToolbarGroup>
      </ToolbarToggleGroup>
      {canWrite && (
        <ToolbarItem>
          <Button
            variant="primary"
            component={(props) => <Link {...props} to={getSubscriptionCreateUrl()} />}
            data-testid="create-subscription-button"
          >
            Create subscription
          </Button>
        </ToolbarItem>
      )}
    </>
  );
};
