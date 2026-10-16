// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelsPage.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deployments/DeploymentsTable.tsx
// and components/global/GlobalDeploymentsView.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Content,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Label,
  Popover,
  SearchInput,
  Spinner,
  Stack,
  StackItem,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { ExpandableRowContent, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import type { UserService } from '../../api/ConsoleService';
import { ServiceError } from '../../api/ConsoleService';
import type { ModelsService } from '../../api/models';
import type { ManagedModel } from '../../api/types';
import { CompoundExpandCountCell } from '../../components/CompoundExpandCountCell';
import { DeleteModal } from '../../components/DeleteModal';
import { LoadError } from '../../components/LoadError';
import { PaginatedTable } from '../../components/PaginatedTable';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { useServiceData } from '../../hooks/useServiceData';
import { getPhaseProps } from '../../utilities/phaseLabelUtils';
import { ExpandedLocationsPanel } from './ExpandedLocationsPanel';

type Props = { service: ModelsService & UserService };

type Column = { label: string; sort: (a: ManagedModel, b: ManagedModel) => number };

const columns: Column[] = [
  {
    label: 'Model deployment name',
    sort: (a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
  },
  { label: 'Model', sort: (a, b) => (a.modelName ?? a.modelRef.name).localeCompare(b.modelName ?? b.modelRef.name) },
  { label: 'Replica count', sort: (a, b) => (a.replicas ?? 0) - (b.replicas ?? 0) },
  { label: 'Locations', sort: (a, b) => a.locations.length - b.locations.length },
  { label: 'Last saved', sort: (a, b) => (a.creationTimestamp ?? '').localeCompare(b.creationTimestamp ?? '') },
  { label: 'Status', sort: (a, b) => (a.phase ?? '').localeCompare(b.phase ?? '') },
];

const locationsColumn = 3;

const keyOf = (model: ManagedModel) => `${model.namespace}/${model.name}`;

/**
 * PR 12's phase (Pending, Ready or Failed) in place of the PoC's "Saved to Git"; its reason and
 * message open in a popover.
 */
const PhaseStatus: React.FC<{ model: ManagedModel }> = ({ model }) => {
  const [open, setOpen] = useState(false);
  const phase = model.phase ?? 'Pending';
  const { icon, status, color } = getPhaseProps(phase);
  const explained = !!(model.reason || model.statusMessage);
  const label = (
    <Label
      isCompact
      icon={icon}
      status={status}
      color={color}
      onClick={explained ? () => setOpen((previous) => !previous) : undefined}
    >
      {phase}
    </Label>
  );
  return (
    <span data-testid="model-phase">
      {explained ? (
        <Popover
          isVisible={open}
          shouldClose={() => setOpen(false)}
          headerContent={model.reason ?? phase}
          bodyContent={model.statusMessage ?? model.reason}
        >
          {label}
        </Popover>
      ) : (
        label
      )}
    </span>
  );
};

const deleteErrorOf = (err: unknown) =>
  err instanceof ServiceError && err.isNotImplemented
    ? new Error('Deleting models is not available on this backend yet.')
    : err instanceof Error
      ? err
      : new Error('The deployment could not be deleted.');

export const ModelsPage: React.FC<Props> = ({ service }) => {
  const [deployments, loaded, error, refresh] = useServiceData<ManagedModel[]>(() => service.listModels(), []);
  const [user] = useServiceData(() => service.getUser(), undefined, 0);
  const canWrite = !!user?.isProviderAdmin;
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  const [selected, setSelected] = useState<ManagedModel>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<Error>();
  const [expandedLocations, setExpandedLocations] = useState<Set<string>>(() => new Set());

  const toggleLocations = (key: string) =>
    setExpandedLocations((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rows = useMemo(() => {
    const term = filter.toLowerCase();
    const compare = columns[sortBy.index].sort;
    return deployments
      .filter((d) =>
        `${d.displayName ?? ''} ${d.name} ${d.modelName} ${d.locations.join(' ')}`.toLowerCase().includes(term),
      )
      .sort((a, b) => (sortBy.direction === 'asc' ? compare(a, b) : compare(b, a)));
  }, [deployments, filter, sortBy]);

  const closeDelete = () => {
    if (!deleting) {
      setSelected(undefined);
      setDeleteError(undefined);
    }
  };

  const remove = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await service.deleteModel(selected.namespace, selected.name, selected.resourceVersion);
      setSelected(undefined);
      void refresh();
    } catch (err) {
      setDeleteError(deleteErrorOf(err));
    } finally {
      setDeleting(false);
    }
  };

  const deployButton = canWrite ? (
    <Button component={(props) => <Link {...props} to="/models/deploy" />}>Deploy model</Button>
  ) : null;

  const sortParams = (index: number): ThProps['sort'] => ({
    sortBy,
    onSort: (_event, i, direction) => setSortBy({ index: i, direction }),
    columnIndex: index,
  });

  const body = () => {
    if (error) {
      if (error instanceof ServiceError && error.isNotImplemented) {
        return <LoadError subject="Models" error={error} />;
      }
      return (
        <Alert isInline variant="danger" title="Error loading models">
          {error.message}
          <Button variant="link" onClick={() => void refresh()}>
            Retry
          </Button>
        </Alert>
      );
    }
    if (!loaded) {
      return <Spinner aria-label="Loading models" />;
    }
    if (deployments.length === 0) {
      return (
        <EmptyState titleText="No models" headingLevel="h2">
          <EmptyStateBody>Add a deployment to configure a model for serving.</EmptyStateBody>
          {deployButton && (
            <EmptyStateFooter>
              <EmptyStateActions>{deployButton}</EmptyStateActions>
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
                aria-label="Filter models"
                placeholder="Filter by name or location"
                value={filter}
                onChange={(_event, value) => setFilter(value)}
                onClear={() => setFilter('')}
              />
            </ToolbarItem>
            {deployButton && <ToolbarItem>{deployButton}</ToolbarItem>}
          </ToolbarContent>
        </Toolbar>
        <PaginatedTable rows={rows}>
          {(pageRows) => (
            <Table aria-label="Model deployments" data-testid="model-deployments-table">
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
              {rows.length === 0 ? (
                <Tbody>
                  <Tr>
                    <Td colSpan={columns.length + 1}>
                      <p>No models match the filter.</p>
                      <Button variant="link" onClick={() => setFilter('')}>
                        Clear filter
                      </Button>
                    </Td>
                  </Tr>
                </Tbody>
              ) : (
                pageRows.map((deployment, rowIndex) => {
                  const key = keyOf(deployment);
                  const isExpanded = expandedLocations.has(key);
                  return (
                    <Tbody key={key} isExpanded={isExpanded}>
                      <Tr isControlRow isContentExpanded={isExpanded}>
                        <Td dataLabel="Model deployment name">
                          <strong>{deployment.displayName ?? deployment.name}</strong>
                          <p>{deployment.description}</p>
                        </Td>
                        <Td dataLabel="Model">{deployment.modelName ?? deployment.modelRef.name}</Td>
                        <Td dataLabel="Replica count">{deployment.replicas ?? '—'}</Td>
                        <Td
                          dataLabel="Locations"
                          data-testid={`model-locations-expand-${deployment.name}`}
                          compoundExpand={{
                            isExpanded,
                            onToggle: () => toggleLocations(key),
                            expandId: `expand-${deployment.name}-locations`,
                            rowIndex,
                            columnIndex: locationsColumn,
                          }}
                        >
                          <CompoundExpandCountCell count={deployment.locations.length} />
                        </Td>
                        <Td dataLabel="Last saved">
                          {deployment.creationTimestamp ? new Date(deployment.creationTimestamp).toLocaleString() : '—'}
                        </Td>
                        <Td dataLabel="Status">
                          <PhaseStatus model={deployment} />
                        </Td>
                        {canWrite && (
                          <Td isActionCell>
                            <SimpleMenuActions
                              testId={`model-actions-${deployment.name}`}
                              ariaLabel={`Actions for ${deployment.displayName ?? deployment.name}`}
                              dropdownItems={[
                                {
                                  key: 'delete',
                                  label: 'Delete',
                                  onClick: () => {
                                    setSelected(deployment);
                                    setDeleteError(undefined);
                                  },
                                },
                              ]}
                            />
                          </Td>
                        )}
                      </Tr>
                      <Tr isExpanded={isExpanded}>
                        <Td colSpan={columns.length + 1}>
                          <ExpandableRowContent>
                            <ExpandedLocationsPanel locations={deployment.locations} />
                          </ExpandableRowContent>
                        </Td>
                      </Tr>
                    </Tbody>
                  );
                })
              )}
            </Table>
          )}
        </PaginatedTable>
      </>
    );
  };

  return (
    <Stack hasGutter>
      <StackItem>
        <Title headingLevel="h2">Models</Title>
        <Content component="p">Add and remove model deployments.</Content>
      </StackItem>
      <StackItem>{body()}</StackItem>
      {selected && (
        <DeleteModal
          title="Delete model deployment?"
          deleteName={selected.displayName ?? selected.name}
          onClose={closeDelete}
          onDelete={() => void remove()}
          deleting={deleting}
          error={deleteError}
          testId="delete-deployment-modal"
        >
          <p>
            Delete this model, its saved deployment, and its location placement resources? Remove references from
            subscriptions and authorization policies first.
          </p>
        </DeleteModal>
      )}
    </Stack>
  );
};
