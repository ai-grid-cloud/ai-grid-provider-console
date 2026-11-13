// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantListPage.tsx at 62319b8.
// Adapted from OSAC osac-ui/libs/ui-components/src/components/Tenant/TenantListPage.tsx
// and TenantActionsMenu.tsx at commit 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d.
import { useMemo, useState } from 'react';
import { Button, ToolbarItem } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshButton } from '../../components/RefreshButton';
import { EmptyListState } from '../../components/states/EmptyListState';
import { PageStateSection } from '../../components/states/PageStateSection';
import { PaginatedTable } from '../../components/PaginatedTable';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { ToolbarSearch } from '../../components/ToolbarSearch';
import { TableEmptyRow } from '../../components/TableEmptyRow';
import { useConsoleSession } from '../../context/useConsoleSession';
import { EMPTY_VALUE } from '../../utilities/format';
import { MissingLabel } from '../../components/MissingLabel';
import { NO_IDENTITY_PROVIDER, NO_IDENTITY_PROVIDER_REASON, type OrganizationView } from './organizationView';
import { useDeleteOrganization } from './useDeleteOrganization';
import { useOrganizationList } from './useOrganizations';

type Column = { label: string; sort: (a: OrganizationView, b: OrganizationView) => number };

// No Status column: the backend's Tenant reports no state (TenantStatus is empty).
const columns: Column[] = [
  { label: 'Organization', sort: (a, b) => a.name.localeCompare(b.name) },
  { label: 'Primary domain', sort: (a, b) => (a.domains[0] ?? '').localeCompare(b.domains[0] ?? '') },
  {
    label: 'Identity provider',
    sort: (a, b) => (a.identityProvider?.title ?? '').localeCompare(b.identityProvider?.title ?? ''),
  },
];

export const OrganizationListPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: organizations, loaded, error, refresh } = useOrganizationList();
  const { user } = useConsoleSession();
  const canWrite = !!user?.isProviderAdmin;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const [confirmDelete, deleteModal] = useDeleteOrganization({
    refresh: () => void refresh(),
    onDeleted: () => void refresh(),
  });

  const rows = useMemo(() => {
    const term = search.toLowerCase();
    const compare = columns[sortBy.index].sort;
    return organizations
      .filter((o) => o.name.toLowerCase().includes(term))
      .sort((a, b) => (sortBy.direction === 'asc' ? compare(a, b) : compare(b, a)));
  }, [organizations, search, sortBy]);

  const createButton = canWrite ? (
    <Button component={(props) => <Link {...props} to="/organizations/create" />}>Create organization</Button>
  ) : null;

  const sortParams = (index: number): ThProps['sort'] => ({
    sortBy,
    onSort: (_event, i, direction) => setSortBy({ index: i, direction }),
    columnIndex: index,
  });

  const body = () => {
    if (organizations.length === 0) {
      return (
        <EmptyListState title="No organizations" action={createButton}>
          To give an organization's users access to models, create an organization.
        </EmptyListState>
      );
    }
    return (
      <>
        <PaginatedTable
          rows={rows}
          toolbar={
            <>
              <ToolbarSearch
                label="Filter organizations"
                placeholder="Filter by name"
                value={search}
                onChange={setSearch}
              />
              {createButton && <ToolbarItem>{createButton}</ToolbarItem>}
              <ToolbarItem>
                <RefreshButton onRefresh={() => void refresh()} />
              </ToolbarItem>
            </>
          }
        >
          {(pageRows) => (
            <Table aria-label="Organizations" data-testid="organizations-table">
              <Thead>
                <Tr>
                  {columns.map((c, i) => (
                    <Th key={c.label} sort={sortParams(i)} modifier="wrap">
                      {c.label}
                    </Th>
                  ))}
                  {canWrite && <Th screenReaderText="Actions" />}
                </Tr>
              </Thead>
              <Tbody>
                {rows.length === 0 ? (
                  <TableEmptyRow
                    colSpan={columns.length + 1}
                    body="Adjust your filters and try again."
                    onClear={() => setSearch('')}
                  />
                ) : (
                  pageRows.map((o) => (
                    <Tr key={o.id}>
                      <Td dataLabel="Organization" modifier="nowrap">
                        <Link to={`/organizations/${encodeURIComponent(o.id)}`}>{o.name}</Link>
                      </Td>
                      <Td dataLabel="Primary domain" modifier="nowrap">
                        {o.domains[0] ?? EMPTY_VALUE}
                      </Td>
                      <Td dataLabel="Identity provider" modifier="breakWord">
                        {o.identityProvider ? (
                          o.identityProvider.title || 'OIDC (no title)'
                        ) : (
                          // As a cluster without a role: a setting the organization may not work without.
                          <MissingLabel testId={`missing-idp-${o.name}`} reason={NO_IDENTITY_PROVIDER_REASON}>
                            {NO_IDENTITY_PROVIDER}
                          </MissingLabel>
                        )}
                      </Td>
                      {canWrite && (
                        <Td isActionCell>
                          <SimpleMenuActions
                            testId={`organization-actions-${o.name}`}
                            ariaLabel={`Actions for ${o.name}`}
                            dropdownItems={[
                              {
                                key: 'view',
                                label: 'View details',
                                onClick: () => navigate(`/organizations/${encodeURIComponent(o.id)}`),
                              },
                              {
                                key: 'edit',
                                label: 'Edit',
                                onClick: () => navigate(`/organizations/${encodeURIComponent(o.id)}/edit`),
                              },
                              { isSpacer: true },
                              { key: 'delete', label: 'Delete', isDanger: true, onClick: () => confirmDelete(o) },
                            ]}
                          />
                        </Td>
                      )}
                    </Tr>
                  ))
                )}
              </Tbody>
            </Table>
          )}
        </PaginatedTable>
      </>
    );
  };

  return (
    <>
      <PageStateSection
        title="Organizations"
        description="Manage organizations that can access models in the AI grid. An organization contains users who all sign in through the same identity provider."
        loaded={loaded}
        error={error}
        onRetry={() => void refresh()}
        subject="Organizations"
        loadingLabel="Loading organizations"
      >
        {body()}
      </PageStateSection>
      {deleteModal}
    </>
  );
};
