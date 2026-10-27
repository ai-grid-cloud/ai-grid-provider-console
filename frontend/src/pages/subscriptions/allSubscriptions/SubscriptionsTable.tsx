// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/SubscriptionsTable.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/SubscriptionsTable.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's dashboard Table: sortable columns, the console's PaginatedTable, and its
// "No results found" view when the filter matches nothing. Each row is its own Tbody, so its
// groups or models can expand under it.
import { useMemo, useState } from 'react';
import { Table, Tbody, Th, Thead, Tr } from '@patternfly/react-table';
import type { MaaSSubscription, ManagedModel } from '../../../api/types';
import { PaginatedTable } from '../../../components/PaginatedTable';
import { TableEmptyRow } from '../../../components/TableEmptyRow';
import { subscriptionsColumns } from './columns';
import type { ModelsState } from './ExpandedModelsPanel';
import { SubscriptionTableRow } from './SubscriptionTableRow';

type Props = {
  subscriptions: MaaSSubscription[];
  /** A subscription's organization name, or its id when the organization is unknown. */
  organizationName: (subscription: MaaSSubscription) => string;
  /** The hub's models, for the rows' models expansion, and whether they have loaded. */
  models: ManagedModel[];
  modelsState: ModelsState;
  /** Each location's site name, from the clusters. */
  siteNames: Map<string, string>;
  toolbarContent: React.ReactNode;
  onClearFilters: () => void;
  canWrite: boolean;
  setDeleteSubscription: (subscription: MaaSSubscription) => void;
};

export const SubscriptionsTable: React.FC<Props> = ({
  subscriptions,
  organizationName,
  models,
  modelsState,
  siteNames,
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
      <PaginatedTable rows={sorted} toolbar={toolbarContent} clearAllFilters={onClearFilters}>
        {(pageRows) => (
          <Table aria-label="Subscriptions" data-testid="subscriptions-table">
            <Thead>
              <Tr>
                {columns.map((col, index) => (
                  <Th
                    key={col.label}
                    width={col.width}
                    className={col.isNumeric ? 'console-number' : undefined}
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
              pageRows.map((subscription) => (
                <SubscriptionTableRow
                  key={subscription.name}
                  subscription={subscription}
                  columns={columns}
                  organization={organizationName(subscription)}
                  models={models}
                  modelsState={modelsState}
                  siteNames={siteNames}
                  canWrite={canWrite}
                  setDeleteSubscription={setDeleteSubscription}
                />
              ))
            ) : (
              <Tbody>
                <TableEmptyRow
                  colSpan={columns.length + 1}
                  body="Change the filter to see more subscriptions."
                  onClear={onClearFilters}
                />
              </Tbody>
            )}
          </Table>
        )}
      </PaginatedTable>
    </>
  );
};
