// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/SubscriptionsTable.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/SubscriptionsTable.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's dashboard Table: sortable columns, the console's PaginatedTable, and its
// "No results found" view when the filter matches nothing.
import { useMemo, useState } from 'react';
import { Button, EmptyState, EmptyStateActions, EmptyStateBody, EmptyStateFooter } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { MaaSSubscription } from '../../../api/types';
import { PaginatedTable } from '../../../components/PaginatedTable';
import { subscriptionsColumns } from './columns';
import { SubscriptionTableRow } from './SubscriptionTableRow';

type Props = {
  subscriptions: MaaSSubscription[];
  /** A subscription's organization name, or its id when the organization is unknown. */
  organizationName: (subscription: MaaSSubscription) => string;
  toolbarContent: React.ReactNode;
  onClearFilters: () => void;
  canWrite: boolean;
  setDeleteSubscription: (subscription: MaaSSubscription) => void;
};

export const SubscriptionsTable: React.FC<Props> = ({
  subscriptions,
  organizationName,
  toolbarContent,
  onClearFilters,
  canWrite,
  setDeleteSubscription,
}) => {
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const columns = useMemo(() => subscriptionsColumns(organizationName), [organizationName]);
  const sorted = useMemo(() => {
    const compare = columns[sortBy.index].sortable;
    return [...subscriptions].sort((a, b) => compare(a, b) * (sortBy.direction === 'asc' ? 1 : -1));
  }, [subscriptions, columns, sortBy]);

  return (
    <>
      {toolbarContent}
      <PaginatedTable rows={sorted}>
        {(pageRows) => (
          <Table aria-label="Subscriptions" isExpandable data-testid="subscriptions-table">
            <Thead>
              <Tr>
                {columns.map((col, index) => (
                  <Th
                    key={col.label}
                    width={col.width}
                    modifier="wrap"
                    sort={{
                      sortBy,
                      columnIndex: index,
                      onSort: (_e, i, direction) => setSortBy({ index: i, direction }),
                    }}
                  >
                    {col.label}
                  </Th>
                ))}
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            {sorted.length ? (
              pageRows.map((subscription, rowIndex) => (
                <SubscriptionTableRow
                  key={subscription.name}
                  subscription={subscription}
                  columns={columns}
                  organization={organizationName(subscription)}
                  rowIndex={rowIndex}
                  canWrite={canWrite}
                  setDeleteSubscription={setDeleteSubscription}
                />
              ))
            ) : (
              <Tbody>
                <Tr>
                  <Td colSpan={columns.length + 1}>
                    <EmptyState titleText="No results found" headingLevel="h2">
                      <EmptyStateBody>Adjust your filter to find subscriptions.</EmptyStateBody>
                      <EmptyStateFooter>
                        <EmptyStateActions>
                          <Button variant="link" onClick={onClearFilters}>
                            Clear all filters
                          </Button>
                        </EmptyStateActions>
                      </EmptyStateFooter>
                    </EmptyState>
                  </Td>
                </Tr>
              </Tbody>
            )}
          </Table>
        )}
      </PaginatedTable>
    </>
  );
};
