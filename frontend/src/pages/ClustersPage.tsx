import { useState } from 'react';
import { EmptyState, EmptyStateBody, Label, MenuToggle, Spinner, Stack, StackItem, Title } from '@patternfly/react-core';
import { EllipsisVIcon } from '@patternfly/react-icons';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ConsoleService } from '../api/ConsoleService';
import type { ClusterStatus, GridCluster } from '../api/types';
import { LoadError } from '../components/LoadError';
import { useServiceData } from '../hooks/useServiceData';

type Props = {
  service: ConsoleService;
  /**
   * Whether the signed-in user may enrol and remove clusters (the hub's
   * answer to "may this user patch ManagedClusters?"). The backend still
   * authorizes every write; this only shows or hides the actions.
   */
  canEdit: boolean;
};

type LabelColor = React.ComponentProps<typeof Label>['color'];

/** How the ACM console colours each state, so both consoles agree. */
export const statusPresentation: Record<ClusterStatus, { text: string; color: LabelColor }> = {
  ready: { text: 'Ready', color: 'green' },
  offline: { text: 'Offline', color: 'red' },
  unknown: { text: 'Unknown', color: 'orange' },
  pendingimport: { text: 'Pending import', color: 'blue' },
  importing: { text: 'Importing', color: 'blue' },
  importfailed: { text: 'Import failed', color: 'red' },
  detaching: { text: 'Detaching', color: 'grey' },
  notaccepted: { text: 'Not accepted', color: 'grey' },
};

const StatusLabel: React.FC<{ cluster: GridCluster }> = ({ cluster }) => {
  if (!cluster.status) {
    // The backend sent no derived state (no conditions, or a backend that
    // does not compute one). See docs/plan/bff-api.md.
    return <Label color="grey">No status</Label>;
  }
  const { text, color } = statusPresentation[cluster.status];
  return (
    <Label color={color} title={cluster.statusMessage} data-testid={`status-${cluster.name}`}>
      {text}
    </Label>
  );
};

export const ClustersPage: React.FC<Props> = ({ service, canEdit }) => {
  const [clusters, loaded, error, refresh] = useServiceData<GridCluster[]>(() => service.listClusters(), []);
  // Names of the clusters with an update in flight. A set, not one name: two
  // rows can be pending at once, and each is released only when its own
  // request settles.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<{ name: string; error: Error } | undefined>();

  const toggleEnrolment = async (c: GridCluster) => {
    setBusy((prev) => new Set(prev).add(c.name));
    setActionError(undefined);
    try {
      await service.updateCluster(c.name, { aiGridEnabled: !c.aiGridEnabled });
      await refresh();
    } catch (e) {
      setActionError({ name: c.name, error: e instanceof Error ? e : new Error(String(e)) });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(c.name);
        return next;
      });
    }
  };

  return (
    <Stack hasGutter>
      <StackItem>
        <Title headingLevel="h2">Clusters</Title>
      </StackItem>
      {error && (
        <StackItem>
          <LoadError subject="Clusters" error={error} />
        </StackItem>
      )}
      {actionError && (
        <StackItem>
          <LoadError subject={`Cluster ${actionError.name}`} verb="updated" error={actionError.error} />
        </StackItem>
      )}
      <StackItem>
        {!loaded ? (
          <Spinner aria-label="Loading clusters" />
        ) : error ? null : clusters.length === 0 ? (
          <EmptyState titleText="No clusters" headingLevel="h3">
            <EmptyStateBody>The AI Grid backend reports no ManagedClusters on this hub.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Clusters" variant="compact">
            <Thead>
              <Tr>
                <Th modifier="nowrap">Cluster</Th>
                <Th modifier="fitContent">Status</Th>
                <Th>Site</Th>
                <Th modifier="fitContent">AI Grid</Th>
                <Th modifier="fitContent">Provisioned</Th>
                <Th modifier="fitContent">GPUs</Th>
                <Th modifier="fitContent">OpenShift</Th>
                <Th modifier="fitContent">Console</Th>
                {canEdit && <Th modifier="fitContent" screenReaderText="Actions" />}
              </Tr>
            </Thead>
            <Tbody>
              {clusters.map((c) => (
                <Tr key={c.name}>
                  <Td dataLabel="Cluster" modifier="nowrap">
                    {c.name}
                  </Td>
                  <Td dataLabel="Status" modifier="fitContent">
                    <StatusLabel cluster={c} />
                  </Td>
                  <Td dataLabel="Site">
                    {c.siteName ?? c.site ?? '-'}
                    {c.location && (
                      <div>
                        <small>{c.location}</small>
                      </div>
                    )}
                  </Td>
                  <Td dataLabel="AI Grid" modifier="fitContent">
                    <Label color={c.aiGridEnabled ? 'green' : 'grey'}>{c.aiGridEnabled ? 'Member' : 'Not enrolled'}</Label>
                  </Td>
                  <Td dataLabel="Provisioned" modifier="fitContent">
                    {c.provisioned ? 'Yes' : 'No'}
                  </Td>
                  <Td dataLabel="GPUs" modifier="fitContent">
                    {c.gpuCapacity > 0 ? c.gpuCapacity : '-'}
                  </Td>
                  <Td dataLabel="OpenShift" modifier="fitContent">
                    {c.openshiftVersion ?? '-'}
                  </Td>
                  <Td dataLabel="Console" modifier="fitContent">
                    {c.consoleUrl ? (
                      <a href={c.consoleUrl} target="_blank" rel="noopener noreferrer">
                        Open
                      </a>
                    ) : (
                      '-'
                    )}
                  </Td>
                  {canEdit && (
                    <Td dataLabel="Actions" isActionCell>
                      <ActionsColumn
                        isDisabled={busy.has(c.name) || c.status === 'detaching'}
                        actionsToggle={({ onToggle, isOpen, isDisabled, toggleRef }) => (
                          <MenuToggle
                            ref={toggleRef}
                            aria-label={`Actions for ${c.name}`}
                            variant="plain"
                            icon={<EllipsisVIcon />}
                            isExpanded={isOpen}
                            isDisabled={isDisabled}
                            onClick={onToggle}
                          />
                        )}
                        items={[
                          {
                            title: c.aiGridEnabled ? 'Remove from grid' : 'Enrol in grid',
                            onClick: () => void toggleEnrolment(c),
                          },
                        ]}
                      />
                    </Td>
                  )}
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </StackItem>
    </Stack>
  );
};
