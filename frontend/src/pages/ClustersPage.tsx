import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Content,
  EmptyState,
  EmptyStateBody,
  Label,
  SearchInput,
  Spinner,
  Stack,
  StackItem,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Tooltip,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import { useNavigate } from 'react-router-dom';
import type { ClustersService } from '../api/clusters';
import type { UserService } from '../api/ConsoleService';
import { ServiceError } from '../api/ConsoleService';
import type { GridCluster } from '../api/types';
import { LoadError } from '../components/LoadError';
import { PaginatedTable } from '../components/PaginatedTable';
import { useServiceData } from '../hooks/useServiceData';

// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/clusters/ClustersPage.tsx at 62319b8.
// The PoC's columns, labels, and enroll flow, plus the console's Site, Region, Hub, and
// OpenShift columns. The Status cell adds the ACM state under Unknown (such as Importing)
// and the backend's message as a tooltip, which the PoC's three states don't have.

type Props = { service: ClustersService & UserService };

// A wide column shows from the 2xl breakpoint (1450 px) up; below it the table fits the
// content area without clipping the Action column.
type Column = { label: string; sort?: (a: GridCluster, b: GridCluster) => number; wide?: boolean };

const columns: Column[] = [
  { label: 'Cluster', sort: (a, b) => a.name.localeCompare(b.name) },
  { label: 'Location', sort: (a, b) => (a.location ?? '').localeCompare(b.location ?? '') },
  { label: 'Status', sort: (a, b) => a.status.localeCompare(b.status) },
  { label: 'AI Grid', sort: (a, b) => Number(a.aiGridEnabled) - Number(b.aiGridEnabled) },
  { label: 'Provisioning', sort: (a, b) => a.provisioningStatus.localeCompare(b.provisioningStatus) },
  { label: 'Site', wide: true },
  { label: 'Region', wide: true },
  { label: 'Hub', wide: true },
  { label: 'OpenShift' },
];

const wideOnly: ThProps['visibility'] = ['hidden', 'visibleOn2Xl'];

const statusColor = (status: GridCluster['status']) =>
  status === 'Ready' ? 'green' : status === 'Offline' ? 'red' : 'grey';

const StatusLabel: React.FC<{ cluster: GridCluster }> = ({ cluster }) => {
  const label = <Label color={statusColor(cluster.status)}>{cluster.status}</Label>;
  return cluster.statusMessage ? <Tooltip content={cluster.statusMessage}>{label}</Tooltip> : label;
};

const enrollErrorMessage = (err: unknown) => {
  if (err instanceof ServiceError && err.isNotImplemented) {
    return 'Adding clusters to AI Grid is not available on this backend yet.';
  }
  return err instanceof Error ? err.message : 'The cluster could not be enrolled.';
};

export const ClustersPage: React.FC<Props> = ({ service }) => {
  const navigate = useNavigate();
  const [clusters, loaded, error, refresh] = useServiceData<GridCluster[]>(() => service.listClusters(), []);
  const [user] = useServiceData(() => service.getUser(), undefined, 0);
  const isProviderAdmin = !!user?.isProviderAdmin;
  // An ACM state (importing, detaching, import failed, ...) is on `state`; only a cluster
  // that is ready, offline, or unknown without one can be added.
  const canEnroll = (c: GridCluster) => isProviderAdmin && !c.state;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  // Clusters the backend confirmed as members, shown before the next list arrives.
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => setConfirmed(new Set()), [clusters]);

  const rows = useMemo(() => {
    const term = search.toLowerCase();
    const compare = columns[sortBy.index].sort!;
    return clusters
      .map((c) => (confirmed.has(c.name) ? { ...c, aiGridEnabled: true } : c))
      .filter((c) => c.name.toLowerCase().includes(term))
      .sort((a, b) => (sortBy.direction === 'asc' ? compare(a, b) : compare(b, a)));
  }, [clusters, confirmed, search, sortBy]);

  const reload = () => {
    setConfirmed(new Set());
    setErrors({});
    void refresh();
  };

  const enroll = async (cluster: GridCluster) => {
    if (cluster.aiGridEnabled || pending.current.has(cluster.name)) {
      return;
    }
    pending.current.add(cluster.name);
    setBusy(new Set(pending.current));
    setErrors((previous) => {
      const next = { ...previous };
      delete next[cluster.name];
      return next;
    });
    try {
      const updated = await service.enrollCluster(cluster);
      if (!updated.aiGridEnabled) {
        throw new Error('The Hub did not confirm AI Grid membership. Refresh and try again.');
      }
      setConfirmed((previous) => new Set([...previous, updated.name]));
      navigate('.', { state: { notice: `${updated.name} added to AI Grid` } });
      void refresh();
    } catch (err) {
      setErrors((previous) => ({ ...previous, [cluster.name]: enrollErrorMessage(err) }));
    } finally {
      pending.current.delete(cluster.name);
      setBusy(new Set(pending.current));
    }
  };

  const sortParams = (index: number): ThProps['sort'] =>
    columns[index].sort
      ? {
          sortBy,
          onSort: (_event, i, direction) => setSortBy({ index: i, direction }),
          columnIndex: index,
        }
      : undefined;

  const body = () => {
    if (error) {
      if (error instanceof ServiceError && error.isNotImplemented) {
        return <LoadError subject="Clusters" error={error} />;
      }
      return (
        <Alert isInline variant="danger" title="Error loading clusters">
          {error.message}
          <Button variant="link" onClick={reload}>
            Retry
          </Button>
        </Alert>
      );
    }
    if (!loaded) {
      return <Spinner aria-label="Loading clusters" />;
    }
    if (clusters.length === 0) {
      return (
        <EmptyState titleText="No managed clusters" headingLevel="h3">
          <EmptyStateBody>No ManagedClusters are available.</EmptyStateBody>
          <Button variant="link" onClick={reload}>
            Refresh
          </Button>
        </EmptyState>
      );
    }
    return (
      <>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                aria-label="Search clusters"
                placeholder="Search clusters by name"
                value={search}
                onChange={(_event, value) => setSearch(value)}
                onClear={() => setSearch('')}
              />
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="secondary" onClick={reload}>
                Refresh
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        <PaginatedTable rows={rows}>
          {(pageRows) => (
            <Table aria-label="AI Grid clusters" variant="compact" data-testid="clusters-table">
              <Thead>
                <Tr>
                  {columns.map((c, i) => (
                    <Th key={c.label} sort={sortParams(i)} modifier="wrap" visibility={c.wide ? wideOnly : undefined}>
                      {c.label}
                    </Th>
                  ))}
                  <Th modifier="wrap">Action</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.length === 0 ? (
                  <Tr>
                    <Td colSpan={columns.length + 1}>No clusters match your search.</Td>
                  </Tr>
                ) : (
                  pageRows.map((c) => (
                    <Tr key={c.name}>
                      <Td dataLabel="Cluster">{c.name}</Td>
                      <Td dataLabel="Location">{c.location ?? '—'}</Td>
                      <Td dataLabel="Status">
                        <StatusLabel cluster={c} />
                        {c.state && <div className="pf-v6-u-font-size-sm pf-v6-u-mt-xs">{c.state}</div>}
                      </Td>
                      <Td dataLabel="AI Grid">{c.aiGridEnabled ? 'Member' : 'Not enrolled'}</Td>
                      <Td dataLabel="Provisioning">
                        <Label color={c.provisioned ? 'green' : c.aiGridEnabled ? 'blue' : 'grey'}>
                          {c.provisioningStatus}
                        </Label>
                      </Td>
                      <Td dataLabel="Site" visibility={wideOnly}>
                        {c.site ?? '—'}
                      </Td>
                      <Td dataLabel="Region" visibility={wideOnly}>
                        {c.region ?? '—'}
                      </Td>
                      <Td dataLabel="Hub" visibility={wideOnly}>
                        {c.hubAcceptsClient ? 'Accepted' : 'Pending'}
                      </Td>
                      <Td dataLabel="OpenShift">{c.openshiftVersion ?? '—'}</Td>
                      <Td dataLabel="Action">
                        {c.aiGridEnabled ? (
                          <span>AI Grid Member</span>
                        ) : canEnroll(c) ? (
                          <Button
                            variant="secondary"
                            isDisabled={busy.has(c.name)}
                            isLoading={busy.has(c.name)}
                            aria-label={`Add ${c.name} to AI Grid`}
                            onClick={() => void enroll(c)}
                          >
                            Add to AI Grid
                          </Button>
                        ) : null}
                        {errors[c.name] && (
                          <Alert
                            isInline
                            variant="danger"
                            title={`Unable to add ${c.name} to AI Grid`}
                            className="pf-v6-u-mt-sm"
                          >
                            {errors[c.name]}
                          </Alert>
                        )}
                      </Td>
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
        <Title headingLevel="h2">Clusters</Title>
        <Content component="p">Manage AI Grid membership and provisioning readiness.</Content>
      </StackItem>
      <StackItem>{body()}</StackItem>
    </Stack>
  );
};
