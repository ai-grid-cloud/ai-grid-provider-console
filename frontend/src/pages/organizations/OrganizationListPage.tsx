// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantListPage.tsx at 62319b8.
// Adapted from OSAC osac-ui/libs/ui-components/src/components/Tenant/TenantListPage.tsx
// and TenantActionsMenu.tsx at commit 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d.
import { useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  PageSection,
  ToolbarItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import { Link, useNavigate } from 'react-router-dom';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization } from '../../api/types';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { LoadError } from '../../components/LoadError';
import { PaginatedTable } from '../../components/PaginatedTable';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { StatusLabel } from '../../components/StatusLabel';
import { ToolbarSearch } from '../../components/ToolbarSearch';
import { TableEmptyRow } from '../../components/TableEmptyRow';
import { useConsoleSession } from '../../context/useConsoleSession';
import { useServiceData } from '../../hooks/useServiceData';
import { EMPTY_VALUE } from '../../utilities/format';
import { useDeleteOrganization } from './useDeleteOrganization';

type Props = { service: OrganizationsService };

type Column = { label: string; sort: (a: Organization, b: Organization) => number };

const columns: Column[] = [
  { label: 'Organization', sort: (a, b) => a.name.localeCompare(b.name) },
  { label: 'Status', sort: (a, b) => a.status.localeCompare(b.status) },
  { label: 'Primary domain', sort: (a, b) => (a.domains[0] ?? '').localeCompare(b.domains[0] ?? '') },
  {
    label: 'Identity provider',
    sort: (a, b) => (a.identityProvider?.title ?? '').localeCompare(b.identityProvider?.title ?? ''),
  },
];

export const OrganizationListPage: React.FC<Props> = ({ service }) => {
  const navigate = useNavigate();
  const [organizations, loaded, error, refresh] = useServiceData<Organization[]>(() => service.listOrganizations(), []);
  const { user } = useConsoleSession();
  const canWrite = !!user?.isProviderAdmin;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const [confirmDelete, deleteModal] = useDeleteOrganization(service, {
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
    if (error) {
      return (
        <LoadError
          subject="Organizations"
          error={error}
          title="Error loading organizations"
          onRetry={() => void refresh()}
        />
      );
    }
    if (organizations.length === 0) {
      return (
        <EmptyState titleText="No organizations" headingLevel="h3">
          <EmptyStateBody>No organizations yet. Register one to get started.</EmptyStateBody>
          {createButton && (
            <EmptyStateFooter>
              <EmptyStateActions>{createButton}</EmptyStateActions>
            </EmptyStateFooter>
          )}
        </EmptyState>
      );
    }
    return (
      <>
        <PaginatedTable
          rows={rows}
          toolbar={
            <>
              <ToolbarSearch
                label="Search organizations"
                placeholder="Search organizations by name"
                value={search}
                onChange={setSearch}
              />
              {createButton && <ToolbarItem>{createButton}</ToolbarItem>}
            </>
          }
        >
          {(pageRows) => (
            <Table aria-label="Organizations" data-testid="tenants-table">
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
                    body="Change the search to see more organizations."
                    onClear={() => setSearch('')}
                  />
                ) : (
                  pageRows.map((o) => (
                    <Tr key={o.id}>
                      <Td dataLabel="Organization" modifier="nowrap">
                        <Link to={`/organizations/${encodeURIComponent(o.id)}`}>{o.name}</Link>
                      </Td>
                      <Td dataLabel="Status">
                        <StatusLabel isCompact status={o.status} />
                      </Td>
                      <Td dataLabel="Primary domain" modifier="nowrap">
                        {o.domains[0] ?? EMPTY_VALUE}
                      </Td>
                      <Td dataLabel="Identity provider" modifier="breakWord">
                        {o.identityProvider ? o.identityProvider.title || 'OIDC' : EMPTY_VALUE}
                      </Td>
                      {canWrite && (
                        <Td isActionCell>
                          <SimpleMenuActions
                            testId={`tenant-actions-${o.name}`}
                            ariaLabel={`Actions for ${o.name}`}
                            dropdownItems={[
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
      <PageHeader title="Organizations" description="Manage organizations and their identity providers." />
      {!error && !loaded ? <PageLoading label="Loading organizations" /> : <PageSection isFilled>{body()}</PageSection>}
      {deleteModal}
    </>
  );
};
