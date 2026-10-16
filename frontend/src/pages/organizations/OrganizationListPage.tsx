// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantListPage.tsx at 62319b8.
// Adapted from OSAC osac-ui/libs/ui-components/src/components/Tenant/TenantListPage.tsx
// and TenantActionsMenu.tsx at commit 8cb0a227e45cc9b17421b6e79ce493ed370ebd5d.
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Content,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Label,
  SearchInput,
  Spinner,
  Stack,
  StackItem,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import { Link, useNavigate } from 'react-router-dom';
import type { UserService } from '../../api/ConsoleService';
import { ServiceError } from '../../api/ConsoleService';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization } from '../../api/types';
import { DeleteModal } from '../../components/DeleteModal';
import { LoadError } from '../../components/LoadError';
import { PaginatedTable } from '../../components/PaginatedTable';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { useServiceData } from '../../hooks/useServiceData';
import { ORGANIZATION_CHANGED } from './serverErrors';

type Props = { service: OrganizationsService & UserService };

type Column = { label: string; sort: (a: Organization, b: Organization) => number };

const columns: Column[] = [
  { label: 'Organization', sort: (a, b) => a.name.localeCompare(b.name) },
  { label: 'Status', sort: (a, b) => a.status.localeCompare(b.status) },
  { label: 'Primary domain', sort: (a, b) => (a.domains[0] ?? '').localeCompare(b.domains[0] ?? '') },
  {
    label: 'Identity provider',
    sort: (a, b) => (a.identityProvider?.title ?? '').localeCompare(b.identityProvider?.title ?? ''),
  },
  { label: 'Registered', sort: (a, b) => a.creationTimestamp.localeCompare(b.creationTimestamp) },
];

/** "Saved" is the PoC's blue; "Disabled", which the PoC can't show, is grey. */
const statusColor = (o: Organization) => (o.status === 'Saved' ? 'blue' : 'grey');

/** The backend may not report a creation time yet. */
const registered = (timestamp: string) => (timestamp ? new Date(timestamp).toLocaleString() : '—');

export const OrganizationListPage: React.FC<Props> = ({ service }) => {
  const navigate = useNavigate();
  const [organizations, loaded, error, refresh] = useServiceData<Organization[]>(() => service.listOrganizations(), []);
  const [user] = useServiceData(() => service.getUser(), undefined, 0);
  const canWrite = !!user?.isProviderAdmin;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const [selected, setSelected] = useState<Organization>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<Error>();

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

  const remove = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await service.deleteOrganization(selected.id, selected.resourceVersion);
      setSelected(undefined);
      void refresh();
    } catch (err) {
      setDeleteError(
        err instanceof ServiceError && err.isNotImplemented
          ? new Error('Deleting organizations is not available on this backend yet.')
          : err instanceof ServiceError && err.status === 409
            ? new Error(ORGANIZATION_CHANGED)
            : err instanceof Error
              ? err
              : new Error('The organization could not be deleted.'),
      );
    } finally {
      setDeleting(false);
    }
  };

  const sortParams = (index: number): ThProps['sort'] => ({
    sortBy,
    onSort: (_event, i, direction) => setSortBy({ index: i, direction }),
    columnIndex: index,
  });

  const body = () => {
    if (error) {
      if (error instanceof ServiceError && error.isNotImplemented) {
        return <LoadError subject="Organizations" error={error} />;
      }
      return (
        <Alert isInline variant="danger" title="Error loading organizations">
          {error.message}
          <Button variant="link" onClick={() => void refresh()}>
            Retry
          </Button>
        </Alert>
      );
    }
    if (!loaded) {
      return <Spinner aria-label="Loading organizations" />;
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
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                aria-label="Search organizations"
                placeholder="Search organizations by name"
                value={search}
                onChange={(_event, value) => setSearch(value)}
                onClear={() => setSearch('')}
              />
            </ToolbarItem>
            {createButton && <ToolbarItem>{createButton}</ToolbarItem>}
          </ToolbarContent>
        </Toolbar>
        <PaginatedTable rows={rows}>
          {(pageRows) => (
            <Table aria-label="Organizations" variant="compact" data-testid="tenants-table">
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
                  <Tr>
                    <Td colSpan={columns.length + 1}>No organizations match your search.</Td>
                  </Tr>
                ) : (
                  pageRows.map((o) => (
                    <Tr key={o.id}>
                      <Td dataLabel="Organization" modifier="nowrap">
                        <Link to={`/organizations/${encodeURIComponent(o.id)}`}>{o.name}</Link>
                      </Td>
                      <Td dataLabel="Status">
                        <Label color={statusColor(o)}>{o.status}</Label>
                      </Td>
                      <Td dataLabel="Primary domain" modifier="nowrap">
                        {o.domains[0] ?? '—'}
                      </Td>
                      <Td dataLabel="Identity provider" modifier="breakWord">
                        {o.identityProvider ? (
                          <>
                            {o.identityProvider.title || 'OIDC'}
                            <p>{o.identityProvider.config.issuer}</p>
                          </>
                        ) : (
                          '—'
                        )}
                      </Td>
                      <Td dataLabel="Registered">{registered(o.creationTimestamp)}</Td>
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
                              {
                                key: 'delete',
                                label: 'Delete',
                                onClick: () => {
                                  setSelected(o);
                                  setDeleteError(undefined);
                                },
                              },
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
    <Stack hasGutter>
      <StackItem>
        <Title headingLevel="h2">Organizations</Title>
        <Content component="p">Manage organizations and their identity providers.</Content>
      </StackItem>
      <StackItem>{body()}</StackItem>
      {selected && (
        <DeleteModal
          title="Delete organization?"
          deleteName={selected.name}
          deleting={deleting}
          error={deleteError}
          onClose={() => {
            if (!deleting) {
              setSelected(undefined);
              setDeleteError(undefined);
            }
          }}
          onDelete={() => void remove()}
          testId="delete-tenant-modal"
        >
          <p>Delete this organization and its saved identity provider configuration?</p>
        </DeleteModal>
      )}
    </Stack>
  );
};
