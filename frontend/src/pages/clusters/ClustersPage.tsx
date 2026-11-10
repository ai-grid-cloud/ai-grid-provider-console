import { Fragment, useMemo, useRef, useState } from 'react';
import {
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Modal,
  ModalBody,
  ModalHeader,
  Stack,
  ToolbarItem,
} from '@patternfly/react-core';
import { CubesIcon } from '@patternfly/react-icons';
import { InnerScrollContainer, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import { Link } from 'react-router-dom';
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
import { useBackgroundWrites } from '../../notifications/useBackgroundWrites';
import { EMPTY_VALUE } from '../../utilities/format';
import type { MembershipChange } from './MembershipModal';
import { changeMembership, editCluster, editTarget, membershipTarget } from './changeMembership';
import { MembershipModal } from './MembershipModal';
import { EditClusterModal } from './EditClusterModal';
import { editText } from './editClusterText';
import { MissingLabel } from './MissingLabel';
import { ClusterSite } from './ClusterSite';
import { AddClusterButton } from './AddClusterButton';
import { gpuCount, membershipActions, statusReason } from './clusterInfo';
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
// the backend's state). Site is the name a hub admin set (annotation ai-grid/site-name), with a
// warning when the coordinate annotations are wrong; Region is the cloud region ACM reports. Location
// label is the `location` label Add and Edit write, which nothing places or routes by; Edit also
// sets the role of a member without one. The status tooltip adds the ACM state behind Unknown (such
// as Importing) and the backend's message, which the PoC's three states don't have.

type Column = {
  /** The header under its group: Name, Status, Site, ... */
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
  {
    label: 'Site',
    dataLabel: 'Site',
    sort: (a, b) => (a.siteName ?? '').localeCompare(b.siteName ?? ''),
  },
  { label: 'Region', dataLabel: 'Region', sort: (a, b) => (a.region ?? '').localeCompare(b.region ?? '') },
  {
    label: 'Status',
    dataLabel: 'AI Grid status',
    srPrefix: 'AI Grid',
    sort: (a, b) => membership(a).localeCompare(membership(b)),
  },
  {
    label: 'Location label',
    dataLabel: 'Location label',
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

/**
 * The header groups over the columns, in order: each spans that many data columns.
 * For a provider admin, Actions is the last column of AI Grid, so that group spans one more.
 */
const groups: { label: string; span: number; info?: ThProps['info'] }[] = [
  { label: 'Cluster', span: 4 },
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
  const { followWrite } = useBackgroundWrites();
  const { data: clusters, loaded, error, refresh } = useClusterList();
  const writes = useMembershipWrites();
  const { user } = useConsoleSession();
  const isProviderAdmin = !!user?.isProviderAdmin;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const [change, setChange] = useState<MembershipChange>();
  const [statusClusterName, setStatusClusterName] = useState<string>();
  // The AI Grid cluster whose Edit dialog is open.
  const [editing, setEditing] = useState<ClusterView>();
  // Clusters as the backend returned them from Add, Remove or Edit, with their new labels (role and
  // location), shown in place of the listed ones until a reload started after the latest change
  // answers. A poll that answers in between can't bring back the row from before the change.
  const [confirmed, setConfirmed] = useState<Map<string, ClusterView>>(new Map());
  const lastReload = useRef(0);
  const statusCluster = statusClusterName
    ? (confirmed.get(statusClusterName) ?? clusters.find((cluster) => cluster.name === statusClusterName))
    : undefined;
  if (statusClusterName && !statusCluster?.statusMessage?.trim()) setStatusClusterName(undefined);

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

  /**
   * Adds the cluster to AI Grid or removes it; throws for the modal to show. The notification center
   * says it was done and follows what the hub does next.
   */
  const applyChange = async (change: MembershipChange, membership?: GridMembership) => {
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
    followWrite(membershipTarget(updated.name, membership));
    reload();
  };

  /**
   * Saves an AI Grid cluster's edited labels; throws for the modal to show. The notification center
   * says they were saved, and follows the provisioning a role set starts.
   */
  const applyEdit = async (cluster: ClusterView, labels: Record<string, string>) => {
    const updated = await editCluster(writes, cluster, labels, {
      reload: writes.loadCluster,
      onConflict: (current) => {
        if (current) setEditing((open) => (open?.name === current.name ? current : open));
        reload();
      },
    });
    setConfirmed((prev) => new Map(prev).set(updated.name, updated));
    setEditing(undefined);
    followWrite(editTarget(cluster, labels));
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
            // When the window is too narrow for every column, the table scrolls sideways.
            <InnerScrollContainer>
              <Table aria-label="AI Grid clusters" data-testid="clusters-table">
                <Thead hasNestedHeader>
                  <Tr>
                    {groups.map((g, i) => (
                      <Th
                        key={g.label}
                        colSpan={g.label === 'AI Grid' && isProviderAdmin ? g.span + 1 : g.span}
                        info={g.info}
                        hasRightBorder={i < groups.length - 1}
                      >
                        {g.label}
                      </Th>
                    ))}
                  </Tr>
                  <Tr>
                    {columns.map((c, i) => (
                      <Fragment key={c.dataLabel}>
                        <Th
                          isSubheader
                          sort={sortParams(i)}
                          info={c.info}
                          modifier="wrap"
                          hasRightBorder={i === 3 || (i === 6 && !isProviderAdmin)}
                        >
                          {c.srPrefix && <span className="pf-v6-screen-reader">{c.srPrefix} </span>}
                          {c.label}
                        </Th>
                        {/* Actions is the last column of AI Grid, after Role and before the GPU columns. */}
                        {isProviderAdmin && i === 6 && <Th isSubheader screenReaderText="Actions" hasRightBorder />}
                      </Fragment>
                    ))}
                  </Tr>
                </Thead>
                <Tbody>
                  {rows.length === 0 ? (
                    <TableEmptyRow
                      colSpan={columns.length + (isProviderAdmin ? 1 : 0)}
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
                          <StatusLabel
                            isCompact
                            status={c.status}
                            reason={statusReason(c)}
                            onClick={c.statusMessage?.trim() ? () => setStatusClusterName(c.name) : undefined}
                            screenReaderSuffix={c.statusMessage?.trim() ? ` for ${c.name}` : undefined}
                          />
                        </Td>
                        <Td dataLabel="Site">
                          <ClusterSite cluster={c} testId={`cluster-site-${c.name}`} />
                        </Td>
                        <Td dataLabel="Region" hasRightBorder>
                          {c.region ?? EMPTY_VALUE}
                        </Td>
                        <Td dataLabel="AI Grid status">
                          {c.aiGridEnabled ? <StatusLabel isCompact status={c.provisioningStatus} /> : EMPTY_VALUE}
                        </Td>
                        <Td dataLabel="Location label">{c.location ?? EMPTY_VALUE}</Td>
                        <Td dataLabel="Role" hasRightBorder={!isProviderAdmin}>
                          {!c.aiGridEnabled
                            ? EMPTY_VALUE
                            : (roleOf(c.labels)?.label ?? (
                                <MissingLabel testId={`missing-role-${c.name}`} reason={editText.noRole}>
                                  No role
                                </MissingLabel>
                              ))}
                        </Td>
                        {isProviderAdmin && (
                          <Td isActionCell hasRightBorder>
                            {c.aiGridEnabled ? (
                              <SimpleMenuActions
                                testId={`cluster-actions-${c.name}`}
                                ariaLabel={`Actions for ${c.name}`}
                                dropdownItems={membershipActions(c, setChange, setEditing)}
                              />
                            ) : (
                              <AddClusterButton cluster={c} onAdd={() => setChange({ cluster: c, join: true })} />
                            )}
                          </Td>
                        )}
                        <Td dataLabel="GPU capacity" data-testid={`cluster-gpu-capacity-${c.name}`}>
                          {gpuCapacity(c)}
                        </Td>
                        <Td dataLabel="GPU configuration" data-testid={`cluster-gpu-models-${c.name}`}>
                          <OverflowList items={gpuConfigurations(c)} noun="GPU configurations" />
                        </Td>
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
      {statusCluster?.statusMessage?.trim() && (
        <Modal
          variant="medium"
          isOpen
          appendTo={() => document.body}
          aria-label={`${statusCluster.name} status`}
          onClose={() => setStatusClusterName(undefined)}
        >
          <ModalHeader title={`${statusCluster.name} status`} />
          <ModalBody>
            <Stack hasGutter>
              <StatusLabel isCompact status={statusCluster.status} />
              <p>{statusReason(statusCluster)}</p>
            </Stack>
          </ModalBody>
        </Modal>
      )}
      {change && (
        <MembershipModal
          {...change}
          onConfirm={(membership) => applyChange(change, membership)}
          onClose={() => setChange(undefined)}
        />
      )}
      {editing && (
        <EditClusterModal
          // A new dialog for another cluster; the same one keeps its state when a conflict reloads it.
          key={editing.name}
          cluster={editing}
          onConfirm={(labels) => applyEdit(editing, labels)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
};
