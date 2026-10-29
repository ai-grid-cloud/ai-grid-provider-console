import { useMemo, useRef, useState } from 'react';
import {
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ToolbarItem,
} from '@patternfly/react-core';
import { CubesIcon } from '@patternfly/react-icons';
import { InnerScrollContainer, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import { Link, useNavigate } from 'react-router-dom';
import type { GridMembership } from '../../api/clusters';
import { PaginatedTable } from '../../components/PaginatedTable';
import { RefreshButton } from '../../components/RefreshButton';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { EmptyListState } from '../../components/states/EmptyListState';
import { PageStateSection } from '../../components/states/PageStateSection';
import { StatusLabel } from '../../components/StatusLabel';
import { ToolbarSearch } from '../../components/ToolbarSearch';
import { TableEmptyRow } from '../../components/TableEmptyRow';
import { OverflowList } from '../../components/OverflowList';
import { useConsoleSession } from '../../context/useConsoleSession';
import { EMPTY_VALUE } from '../../utilities/format';
import type { MembershipChange } from './MembershipModal';
import { changeMembership } from './changeMembership';
import { MembershipModal } from './MembershipModal';
import { MissingLabel } from './MissingLabel';
import { ClusterSite } from './ClusterSite';
import { siteOf } from './site';
import { gpuCount, membershipAction, statusReason } from './clusterInfo';
import { capacityText, configurationText, gpuCountText, gpuSharing } from './gpuText';
import { ClusterRolesList } from './ClusterRolesHelp';
import { roleOf } from './roles';
import type { ClusterView } from './clusterView';
import { useClusterList, useMembershipWrites } from './useClusters';

// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/clusters/ClustersPage.tsx at 62319b8.
// The PoC's columns, labels, and enroll flow, plus the console's Role and GPU columns (capacity and
// configuration, as provider-admin feedback asks: "4 nodes, 32 GPUs" and "H200, 8 GPUs/node"; the
// OpenShift version moved to the details page to make room), removal from AI Grid, and a
// confirmation both ways. The columns sit under nested headers that match the details page's
// cards (UX review). Each name opens the cluster's details page. No Hub column: a cluster the hub
// hasn't accepted shows Not accepted in the cluster status's tooltip, and Add says why it's
// disabled (on the real backend the BFF derives that state from spec.hub_accepts_client,
// the backend's state). Site is where the backend's status.location puts the cluster: the site
// name a hub admin set, or the cloud region (marked "(cloud region)"), with a warning when the coordinate
// annotations are wrong. It is a column of its own, beside but apart from the AI Grid Location (the
// location label Add writes). The status tooltip adds the ACM state behind Unknown (such as
// Importing) and the backend's message, which the PoC's three states don't have.

type Column = {
  /** The header under its group: Name, Status, Location, ... */
  label: string;
  /** The label on a phone, where the table stacks and the group headers are hidden. */
  dataLabel: string;
  /**
   * Hidden text before the label, for a header that repeats another's (Status twice): its sort
   * button's name then says which one, as the group header above it does on screen.
   */
  srPrefix?: string;
  sort: (a: ClusterView, b: ClusterView) => number;
  info?: ThProps['info'];
};

// Nested column headers (PatternFly), grouped the way the details page groups its cards: the
// cluster as the hub sees it, its AI Grid membership, and its GPUs.
const columns: Column[] = [
  { label: 'Name', dataLabel: 'Cluster', sort: (a, b) => a.name.localeCompare(b.name) },
  {
    label: 'Status',
    dataLabel: 'Cluster status',
    srPrefix: 'Cluster',
    sort: (a, b) => a.status.localeCompare(b.status),
  },
  { label: 'Site', dataLabel: 'Site', sort: (a, b) => (siteOf(a) ?? '').localeCompare(siteOf(b) ?? '') },
  {
    label: 'Status',
    dataLabel: 'AI Grid status',
    srPrefix: 'AI Grid',
    sort: (a, b) => membership(a).localeCompare(membership(b)),
  },
  {
    label: 'Location',
    dataLabel: 'Location',
    sort: (a, b) => (a.location ?? '').localeCompare(b.location ?? ''),
  },
  {
    label: 'Role',
    dataLabel: 'Role',
    sort: (a, b) => memberRole(a).localeCompare(memberRole(b)),
    info: {
      ariaLabel: 'About cluster roles',
      popover: <ClusterRolesList />,
      popoverProps: { headerContent: 'Cluster roles' },
    },
  },
  { label: 'Capacity', dataLabel: 'GPU capacity', sort: (a, b) => gpuTotal(a) - gpuTotal(b) },
  {
    label: 'Configuration',
    dataLabel: 'GPU configuration',
    sort: (a, b) => (gpuConfigurations(a)[0] ?? '').localeCompare(gpuConfigurations(b)[0] ?? ''),
  },
];

/** The header groups over the columns, in order: each spans that many columns. */
const groups: { label: string; span: number; info?: ThProps['info'] }[] = [
  { label: 'Cluster', span: 3 },
  { label: 'AI Grid', span: 3 },
  {
    label: 'GPUs',
    span: 2,
    info: {
      ariaLabel: 'About GPUs',
      popover: (
        <DescriptionList isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>Capacity</DescriptionListTerm>
            <DescriptionListDescription>
              The GPU nodes and GPUs reported by the cluster. A GPU split into MIG devices counts once per device. When
              node details are not available, this is the GPU count from the cluster&apos;s capacity.
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Configuration</DescriptionListTerm>
            <DescriptionListDescription>
              The GPU model, the GPUs per node, and how the GPUs are shared.
            </DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>
      ),
      popoverProps: { headerContent: 'GPUs' },
    },
  },
];

/** Each GPU configuration as one line: "NVIDIA L4, 1 GPU/node", with how it is shared. */
const gpuConfigurations = (c: ClusterView) =>
  (c.gpus?.configurations ?? []).map((g) =>
    [configurationText(g), gpuSharing(g.sharing, g.product)].filter(Boolean).join(', '),
  );

/** The GPUs to sort by: the inventory's, else the capacity's, -1 when the hub reports neither. */
const gpuTotal = (c: ClusterView) => c.gpus?.total ?? gpuCount(c) ?? -1;

/** "4 nodes, 32 GPUs" from the inventory; without one, the capacity's count; nothing without GPUs. */
const gpuCapacity = (c: ClusterView) => {
  if (c.gpus) return capacityText(c.gpus);
  const n = gpuCount(c);
  return n ? gpuCountText(n) : EMPTY_VALUE;
};

/** A member's provisioning, or nothing for a cluster outside AI Grid (sorts first). */
const membership = (c: ClusterView) => (c.aiGridEnabled ? c.provisioningStatus : '');

/** A member's role label, '-' for a member without one, nothing outside AI Grid (sorts first). */
const memberRole = (c: ClusterView) => (c.aiGridEnabled ? (roleOf(c.labels)?.label ?? '-') : '');

export const ClustersPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: clusters, loaded, error, refresh } = useClusterList();
  const writes = useMembershipWrites();
  const { user } = useConsoleSession();
  const isProviderAdmin = !!user?.isProviderAdmin;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const [change, setChange] = useState<MembershipChange>();
  // Clusters as the backend returned them from Add or Remove, with their new labels (role and
  // location), shown in place of the listed ones until a reload started after the latest change
  // answers. A poll that answers in between can't bring back the row from before the change.
  const [confirmed, setConfirmed] = useState<Map<string, ClusterView>>(new Map());
  const lastReload = useRef(0);

  const rows = useMemo(() => {
    const term = search.toLowerCase();
    const compare = columns[sortBy.index].sort;
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
  const applyChange = async (change: MembershipChange, membership?: GridMembership) => {
    const { join } = change;
    const updated = await changeMembership(writes, change, membership, {
      reload: writes.loadCluster,
      onConflict: (current) => {
        if (current) {
          setChange((open) => (open?.cluster.name === current.name ? { ...open, cluster: current } : open));
        }
        reload();
      },
    });
    setConfirmed((prev) => new Map(prev).set(updated.name, updated));
    setChange(undefined);
    // Replace, so the notice doesn't add a second Clusters entry to the browser's history.
    navigate('.', {
      replace: true,
      state: { notice: `${updated.name} ${join ? 'added to' : 'removed from'} AI Grid` },
    });
    reload();
  };

  const sortParams = (index: number): ThProps['sort'] => ({
    sortBy,
    onSort: (_event, i, direction) => setSortBy({ index: i, direction }),
    columnIndex: index,
  });

  const body = () => {
    if (clusters.length === 0) {
      return (
        <EmptyListState
          title="No clusters"
          icon={CubesIcon}
          action={
            <Button variant="link" onClick={reload}>
              Refresh
            </Button>
          }
        >
          To add a cluster to AI Grid, first import it into the hub.
        </EmptyListState>
      );
    }
    return (
      <>
        <PaginatedTable
          rows={rows}
          toolbar={
            <>
              <ToolbarSearch label="Filter clusters" placeholder="Filter by name" value={search} onChange={setSearch} />
              <ToolbarItem>
                <RefreshButton onRefresh={reload} />
              </ToolbarItem>
            </>
          }
        >
          {(pageRows) => (
            // The actions column sticks to the right edge: when the window is too narrow for every
            // column, the table scrolls sideways under it instead of pushing it out of view.
            <InnerScrollContainer>
              <Table aria-label="AI Grid clusters" data-testid="clusters-table">
                <Thead hasNestedHeader>
                  <Tr>
                    {groups.map((g, i) => (
                      <Th key={g.label} colSpan={g.span} info={g.info} hasRightBorder={i < groups.length - 1}>
                        {g.label}
                      </Th>
                    ))}
                    {isProviderAdmin && (
                      <Th rowSpan={2} screenReaderText="Actions" isStickyColumn stickyMinWidth="3.5rem" hasLeftBorder />
                    )}
                  </Tr>
                  <Tr>
                    {columns.map((c, i) => (
                      <Th
                        key={c.dataLabel}
                        isSubheader
                        sort={sortParams(i)}
                        info={c.info}
                        modifier="wrap"
                        hasRightBorder={i === 1 || i === 4}
                      >
                        {c.srPrefix && <span className="pf-v6-screen-reader">{c.srPrefix} </span>}
                        {c.label}
                      </Th>
                    ))}
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
                    pageRows.map((c) => (
                      <Tr key={c.name}>
                        <Td dataLabel="Cluster">
                          <Link to={`/clusters/${encodeURIComponent(c.name)}`}>{c.name}</Link>
                        </Td>
                        <Td dataLabel="Cluster status">
                          <StatusLabel isCompact status={c.status} reason={statusReason(c)} />
                        </Td>
                        <Td dataLabel="Site" hasRightBorder>
                          <ClusterSite cluster={c} testId={`cluster-site-${c.name}`} />
                        </Td>
                        <Td dataLabel="AI Grid status">
                          <StatusLabel isCompact status={c.aiGridEnabled ? c.provisioningStatus : 'Not added'} />
                        </Td>
                        <Td dataLabel="Location">
                          {c.location ??
                            (c.aiGridEnabled ? (
                              <MissingLabel
                                testId={`missing-location-${c.name}`}
                                reason="This cluster has no location, so models cannot be deployed to it."
                              >
                                No location
                              </MissingLabel>
                            ) : (
                              EMPTY_VALUE
                            ))}
                        </Td>
                        <Td dataLabel="Role" hasRightBorder>
                          {!c.aiGridEnabled
                            ? EMPTY_VALUE
                            : (roleOf(c.labels)?.label ?? (
                                <MissingLabel
                                  testId={`missing-role-${c.name}`}
                                  reason="This cluster has no role, so the hub cannot install OpenShift AI or MaaS on it, and provisioning cannot finish. To set a role, remove the cluster from AI Grid and add it again."
                                >
                                  No role
                                </MissingLabel>
                              ))}
                        </Td>
                        <Td dataLabel="GPU capacity" data-testid={`cluster-gpu-capacity-${c.name}`}>
                          {gpuCapacity(c)}
                        </Td>
                        <Td dataLabel="GPU configuration" data-testid={`cluster-gpu-models-${c.name}`}>
                          <OverflowList items={gpuConfigurations(c)} noun="GPU configurations" />
                        </Td>
                        {isProviderAdmin && (
                          <Td isActionCell isStickyColumn stickyMinWidth="3.5rem" hasLeftBorder>
                            <SimpleMenuActions
                              testId={`cluster-actions-${c.name}`}
                              ariaLabel={`Actions for ${c.name}`}
                              dropdownItems={[membershipAction(c, setChange)]}
                            />
                          </Td>
                        )}
                      </Tr>
                    ))
                  )}
                </Tbody>
              </Table>
            </InnerScrollContainer>
          )}
        </PaginatedTable>
      </>
    );
  };

  return (
    <>
      <PageStateSection
        title="Clusters"
        description="Add clusters to AI Grid and check their provisioning status."
        loaded={loaded}
        error={error}
        onRetry={reload}
        subject="Clusters"
        loadingLabel="Loading clusters"
      >
        {body()}
      </PageStateSection>
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
