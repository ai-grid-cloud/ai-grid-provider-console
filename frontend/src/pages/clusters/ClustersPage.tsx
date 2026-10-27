import { useMemo, useRef, useState } from 'react';
import {
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
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
import type { ClustersService, GridMembership } from '../../api/clusters';
import { ServiceError } from '../../api/ConsoleService';
import type { GridCluster } from '../../api/types';
import { LoadError } from '../../components/LoadError';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { PaginatedTable } from '../../components/PaginatedTable';
import { RefreshButton } from '../../components/RefreshButton';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { StatusLabel } from '../../components/StatusLabel';
import { ToolbarSearch } from '../../components/ToolbarSearch';
import { TableEmptyRow } from '../../components/TableEmptyRow';
import { useConsoleSession } from '../../context/useConsoleSession';
import { useServiceData } from '../../hooks/useServiceData';
import { EMPTY_VALUE } from '../../utilities/format';
import type { MembershipChange } from './MembershipModal';
import { ClusterChangedError } from './ClusterChangedError';
import { MembershipModal } from './MembershipModal';
import { MissingLabel } from './MissingLabel';
import { clusterRoles, roleOf } from './roles';

// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/clusters/ClustersPage.tsx at 62319b8.
// The PoC's columns, labels, and enroll flow, plus the console's Role and OpenShift columns,
// removal from AI Grid, and a confirmation both ways. No Hub column: a cluster the hub hasn't
// accepted shows Not accepted in the Connection tooltip, and Add says why it's disabled (on the
// real backend the BFF derives that state from spec.hub_accepts_client, bff/internal/backend/v1.go).
// Site and Region (ai-grid/site and ai-grid/region) are left out: geography is after the MVP, and
// the console doesn't write either label. The Connection tooltip adds the ACM state behind Unknown (such as
// Importing) and the backend's message, which the PoC's three states don't have.

type Props = { service: ClustersService };

type Column = {
  label: string;
  sort?: (a: GridCluster, b: GridCluster) => number;
  info?: ThProps['info'];
};

const columns: Column[] = [
  { label: 'Cluster', sort: (a, b) => a.name.localeCompare(b.name) },
  { label: 'Location', sort: (a, b) => (a.location ?? '').localeCompare(b.location ?? '') },
  { label: 'Connection', sort: (a, b) => a.status.localeCompare(b.status) },
  { label: 'AI Grid', sort: (a, b) => membership(a).localeCompare(membership(b)) },
  {
    label: 'Role',
    sort: (a, b) => memberRole(a).localeCompare(memberRole(b)),
    info: {
      ariaLabel: 'About cluster roles',
      popover: (
        <DescriptionList isCompact>
          {clusterRoles.map((r) => (
            <DescriptionListGroup key={r.value}>
              <DescriptionListTerm>{r.label}</DescriptionListTerm>
              <DescriptionListDescription>{r.description}</DescriptionListDescription>
            </DescriptionListGroup>
          ))}
        </DescriptionList>
      ),
      popoverProps: { headerContent: 'What a member runs' },
    },
  },
  { label: 'OpenShift' },
];

/** A member's provisioning, or nothing for a cluster outside AI Grid (sorts first). */
const membership = (c: GridCluster) => (c.aiGridEnabled ? c.provisioningStatus : '');

/** A member's role label, '-' for a member without one, nothing outside AI Grid (sorts first). */
const memberRole = (c: GridCluster) => (c.aiGridEnabled ? (roleOf(c.labels)?.label ?? '-') : '');

/** The Connection tooltip: the ACM state behind Unknown, then the backend's message. */
const statusReason = (c: GridCluster) => [c.state, c.statusMessage].filter(Boolean).join(': ') || undefined;

/** Why a cluster can't be added: the hub hasn't accepted it, hasn't finished importing it, or is detaching it. */
const cannotAddReason = (c: GridCluster) => {
  if (c.state === 'Not accepted') {
    return "The hub hasn't accepted this cluster yet. Accept it in ACM, then add it to AI Grid.";
  }
  return c.state ? `The hub can add this cluster to AI Grid once it has imported it (now: ${c.state}).` : undefined;
};

export const ClustersPage: React.FC<Props> = ({ service }) => {
  const navigate = useNavigate();
  const [clusters, loaded, error, refresh] = useServiceData<GridCluster[]>(() => service.listClusters(), []);
  const { user } = useConsoleSession();
  const isProviderAdmin = !!user?.isProviderAdmin;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const [change, setChange] = useState<MembershipChange>();
  // Clusters as the backend returned them from Add or Remove, with their new labels (role and
  // location), shown in place of the listed ones until a reload started after the latest change
  // answers. A poll that answers in between can't bring back the row from before the change.
  const [confirmed, setConfirmed] = useState<Map<string, GridCluster>>(new Map());
  const lastReload = useRef(0);

  const rows = useMemo(() => {
    const term = search.toLowerCase();
    const compare = columns[sortBy.index].sort!;
    return clusters
      .map((c) => confirmed.get(c.name) ?? c)
      .filter((c) => c.name.toLowerCase().includes(term))
      .sort((a, b) => (sortBy.direction === 'asc' ? compare(a, b) : compare(b, a)));
  }, [clusters, confirmed, search, sortBy]);

  /** Reloads the list; its answer includes every change so far, so it replaces the confirmed clusters. */
  const reload = () => {
    const id = ++lastReload.current;
    void refresh().then(() => {
      if (id === lastReload.current) setConfirmed(new Map());
    });
  };

  /** Adds the cluster to AI Grid or removes it; throws for the modal to show. */
  const applyChange = async ({ cluster, join }: MembershipChange, membership?: GridMembership) => {
    let updated: GridCluster;
    try {
      updated = membership
        ? await service.enrollCluster(cluster, membership)
        : await service.removeClusterFromGrid(cluster);
    } catch (err) {
      if (err instanceof ServiceError && err.isConflict) {
        // The cluster changed since the dialog opened, so the PATCH carried old labels and an old
        // version. Load it again and give the open dialog the new one, so the next try sends what
        // the backend has now; the dialog decides whether the user's location and role still
        // stand (ClusterChangedError).
        const current = await service.listClusters().then(
          (list) => list.find((c) => c.name === cluster.name),
          () => undefined,
        );
        if (current) {
          setChange((open) => (open?.cluster.name === current.name ? { ...open, cluster: current } : open));
        }
        reload();
        throw new ClusterChangedError(current);
      }
      throw err;
    }
    if (updated.aiGridEnabled !== join) {
      throw new Error('The Hub did not confirm the change. Refresh and try again.');
    }
    setConfirmed((prev) => new Map(prev).set(updated.name, updated));
    setChange(undefined);
    // Replace, so the notice doesn't add a second Clusters entry to the browser's history.
    navigate('.', {
      replace: true,
      state: { notice: `${updated.name} ${join ? 'added to' : 'removed from'} AI Grid` },
    });
    reload();
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
      return <LoadError subject="Clusters" error={error} title="Error loading clusters" onRetry={reload} />;
    }
    if (clusters.length === 0) {
      return (
        <EmptyState titleText="No managed clusters" headingLevel="h3">
          <EmptyStateBody>No ManagedClusters are available.</EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="link" onClick={reload}>
                Refresh
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
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
                label="Search clusters"
                placeholder="Search clusters by name"
                value={search}
                onChange={setSearch}
              />
              <ToolbarItem>
                <RefreshButton onRefresh={reload} />
              </ToolbarItem>
            </>
          }
        >
          {(pageRows) => (
            <Table aria-label="AI Grid clusters" data-testid="clusters-table">
              <Thead>
                <Tr>
                  {columns.map((c, i) => (
                    <Th key={c.label} sort={sortParams(i)} info={c.info} modifier="wrap">
                      {c.label}
                    </Th>
                  ))}
                  {isProviderAdmin && <Th screenReaderText="Actions" />}
                </Tr>
              </Thead>
              <Tbody>
                {rows.length === 0 ? (
                  <TableEmptyRow
                    colSpan={columns.length + 1}
                    body="Change the search to see more clusters."
                    onClear={() => setSearch('')}
                  />
                ) : (
                  pageRows.map((c) => (
                    <Tr key={c.name}>
                      <Td dataLabel="Cluster">
                        {c.aiGridEnabled ? (
                          <Link to={`/ai-grid?cluster=${encodeURIComponent(c.name)}`}>{c.name}</Link>
                        ) : (
                          c.name
                        )}
                      </Td>
                      <Td dataLabel="Location">
                        {c.location ??
                          (c.aiGridEnabled ? (
                            <MissingLabel
                              testId={`missing-location-${c.name}`}
                              reason="This member has no location label, so models can't be deployed to it."
                            >
                              No location
                            </MissingLabel>
                          ) : (
                            EMPTY_VALUE
                          ))}
                      </Td>
                      <Td dataLabel="Connection">
                        <StatusLabel isCompact status={c.status} reason={statusReason(c)} />
                      </Td>
                      <Td dataLabel="AI Grid">
                        {c.aiGridEnabled ? (
                          <StatusLabel isCompact status={c.provisioningStatus} />
                        ) : (
                          <span className="pf-v6-u-text-color-subtle">Not added</span>
                        )}
                      </Td>
                      <Td dataLabel="Role">
                        {!c.aiGridEnabled
                          ? EMPTY_VALUE
                          : (roleOf(c.labels)?.label ?? (
                              <MissingLabel
                                testId={`missing-role-${c.name}`}
                                reason="This member has no role, so the hub doesn't install OpenShift AI or MaaS on it, and it never finishes provisioning. Remove it from AI Grid and add it again to choose a role."
                              >
                                No role
                              </MissingLabel>
                            ))}
                      </Td>
                      <Td dataLabel="OpenShift">{c.openshiftVersion ?? EMPTY_VALUE}</Td>
                      {isProviderAdmin && (
                        <Td isActionCell>
                          <SimpleMenuActions
                            testId={`cluster-actions-${c.name}`}
                            ariaLabel={`Actions for ${c.name}`}
                            dropdownItems={
                              c.aiGridEnabled
                                ? [
                                    {
                                      key: 'remove',
                                      label: 'Remove from AI Grid',
                                      isDanger: true,
                                      onClick: () => setChange({ cluster: c, join: false }),
                                    },
                                  ]
                                : [
                                    {
                                      key: 'add',
                                      label: 'Add to AI Grid',
                                      disabledReason: cannotAddReason(c),
                                      onClick: () => setChange({ cluster: c, join: true }),
                                    },
                                  ]
                            }
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
      <PageHeader title="Clusters" description="Manage AI Grid membership and provisioning readiness." />
      {!error && !loaded ? <PageLoading label="Loading clusters" /> : <PageSection isFilled>{body()}</PageSection>}
      {change && (
        <MembershipModal
          {...change}
          onConfirm={(membership) => applyChange(change, membership)}
          onClose={() => setChange(undefined)}
        />
      )}
    </>
  );
};
