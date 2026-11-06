// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelsPage.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deployments/DeploymentsTable.tsx
// and components/global/GlobalDeploymentsView.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The UX team's "models per cluster" design (jgiardino/ai-grid-provider-console@ada68ad): a model
// row expands to its clusters and each one's status; the Clusters cell shows up to five compact
// labels. Status and Availability follow jgiardino/ai-grid-provider-console@a4e6090: Status
// is Git sync and deployment in one word (status.state), sorted in rollout order; Availability is
// the model in MaaS (status.maas). The models are the backend's Models/List over Connect
// (useModels.ts).
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Label, LabelGroup, Stack, ToolbarItem } from '@patternfly/react-core';
import { ExpandableRowContent, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import { RefreshButton } from '../../components/RefreshButton';
import { PaginatedTable } from '../../components/PaginatedTable';
import { RelativeTime } from '../../components/RelativeTime';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { EmptyListState } from '../../components/states/EmptyListState';
import { PageStateSection } from '../../components/states/PageStateSection';
import { ToolbarSearch } from '../../components/ToolbarSearch';
import { TableEmptyRow } from '../../components/TableEmptyRow';
import { useConsoleSession } from '../../context/useConsoleSession';
import { EMPTY_VALUE } from '../../utilities/format';
import { modelPath } from './modelUtils';
import { ModelClustersTable } from './ModelClustersTable';
import { ClusterLoadNote } from './ClusterLoadNote';
import { NotPlaced } from './NotPlaced';
import { ModelAvailability } from './ModelAvailability';
import { ModelStatusLabel } from './ModelStatus';
import { ModelStatusModal } from './ModelStatusModal';
import { availabilityOf, stateRank, statusOpens } from './modelStatusInfo';
import { titleOf, type ModelView } from './modelView';
import { useDeleteModel } from './useDeleteModel';
import { useModelList } from './useModels';
import { useClusterList } from '../clusters/useClusters';

type Column = { label: string; sort: (a: ModelView, b: ModelView) => number };

const columns: Column[] = [
  { label: 'Name', sort: (a, b) => titleOf(a).localeCompare(titleOf(b)) },
  { label: 'Model', sort: (a, b) => (a.modelName ?? a.id).localeCompare(b.modelName ?? b.id) },
  { label: 'Clusters', sort: (a, b) => a.selectedClusters.length - b.selectedClusters.length },
  { label: 'Created', sort: (a, b) => (a.creationTimestamp ?? '').localeCompare(b.creationTimestamp ?? '') },
  { label: 'Status', sort: (a, b) => stateRank(a.state) - stateRank(b.state) || titleOf(a).localeCompare(titleOf(b)) },
  {
    label: 'Availability',
    sort: (a, b) => (availabilityOf(a)?.label ?? '').localeCompare(availabilityOf(b)?.label ?? ''),
  },
];

/** The list opens sorted by Status through stateRank. */
const STATUS_COLUMN = columns.findIndex((c) => c.label === 'Status');

export const ModelsPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: models, loaded, error, refresh } = useModelList();
  const clusterList = useClusterList();
  const clusters = clusterList.data;
  const { user } = useConsoleSession();
  const canWrite = !!user?.isProviderAdmin;
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({
    index: STATUS_COLUMN,
    direction: 'asc',
  });
  // The models whose rows show their clusters.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const setRowExpanded = (id: string, open: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  // The model whose status dialog is open, by id, so each poll shows its current status.
  const [statusModelId, setStatusModelId] = useState<string>();
  const [confirmDelete, deleteModal] = useDeleteModel({
    refresh: () => void refresh(),
    // The list refetches once the delete lands; the notification center says how it went.
    onDeleted: () => undefined,
  });

  const rows = useMemo(() => {
    const term = filter.toLowerCase();
    const compare = columns[sortBy.index].sort;
    return models
      .filter((m) =>
        `${m.displayName ?? ''} ${m.id} ${m.modelName ?? ''} ${m.selectedClusters.join(' ')}`
          .toLowerCase()
          .includes(term),
      )
      .sort((a, b) => (sortBy.direction === 'asc' ? compare(a, b) : compare(b, a)));
  }, [models, filter, sortBy]);

  const statusModel = models.find((m) => m.id === statusModelId);
  if (statusModelId && (!statusModel || !statusOpens(statusModel.state))) {
    setStatusModelId(undefined);
  }

  const deployButton = canWrite ? (
    <Button component={(props) => <Link {...props} to="/models/deploy" />}>Deploy model</Button>
  ) : null;

  const sortParams = (index: number): ThProps['sort'] => ({
    sortBy,
    onSort: (_event, i, direction) => setSortBy({ index: i, direction }),
    columnIndex: index,
  });

  const body = () => {
    if (models.length === 0) {
      return (
        <EmptyListState title="No models" action={deployButton}>
          Deploy a model to serve it on AI Grid clusters.
        </EmptyListState>
      );
    }
    return (
      <Stack hasGutter>
        <ClusterLoadNote clusters={clusterList} />
        <PaginatedTable
          rows={rows}
          toolbar={
            <>
              <ToolbarSearch
                label="Filter models"
                placeholder="Filter by name or cluster"
                value={filter}
                onChange={setFilter}
              />
              {deployButton && <ToolbarItem>{deployButton}</ToolbarItem>}
              <ToolbarItem>
                <RefreshButton onRefresh={() => void refresh()} />
              </ToolbarItem>
            </>
          }
        >
          {(pageRows) => (
            <Table aria-label="Models" isExpandable data-testid="model-deployments-table">
              <Thead>
                <Tr>
                  <Th screenReaderText="Show clusters" />
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
                  <TableEmptyRow
                    colSpan={columns.length + 1 + (canWrite ? 1 : 0)}
                    body="Change the filter to see more models."
                    onClear={() => setFilter('')}
                  />
                </Tbody>
              ) : (
                pageRows.map((model, rowIndex) => {
                  const title = titleOf(model);
                  const availability = availabilityOf(model);
                  const isExpanded = expanded.has(model.id);
                  const edit = canWrite ? () => navigate(`${modelPath(model)}/edit`) : undefined;
                  return (
                    <Tbody key={model.id} isExpanded={isExpanded}>
                      <Tr isContentExpanded={isExpanded} isControlRow>
                        {/* Every row expands: to each placed cluster's sync and deployment, to the
                          clusters its placement chose while none has reported, or to say it has none. */}
                        <Td
                          expand={{
                            rowIndex,
                            isExpanded,
                            onToggle: () => setRowExpanded(model.id, !isExpanded),
                            expandId: `model-clusters-toggle-${model.id}`,
                          }}
                        />
                        <Td dataLabel="Name">
                          <Link to={modelPath(model)}>{title}</Link>
                        </Td>
                        <Td dataLabel="Model" modifier="breakWord">
                          {model.modelName ?? EMPTY_VALUE}
                        </Td>
                        <Td dataLabel="Clusters" data-testid={`model-cluster-names-${model.id}`}>
                          {model.selectedClusters.length ? (
                            <LabelGroup numLabels={5}>
                              {model.selectedClusters.map((cluster) => (
                                <Label key={cluster} color="grey" isCompact>
                                  {cluster}
                                </Label>
                              ))}
                            </LabelGroup>
                          ) : (
                            EMPTY_VALUE
                          )}
                        </Td>
                        <Td dataLabel="Created" modifier="nowrap">
                          <RelativeTime time={model.creationTimestamp} />
                        </Td>
                        <Td dataLabel="Status">
                          <ModelStatusLabel model={model} onOpen={() => setStatusModelId(model.id)} />
                        </Td>
                        <Td dataLabel="Availability" data-testid={`model-availability-${model.id}`}>
                          {availability ? <ModelAvailability model={model} availability={availability} /> : EMPTY_VALUE}
                        </Td>
                        {canWrite && (
                          <Td isActionCell>
                            <SimpleMenuActions
                              testId={`model-actions-${model.id}`}
                              ariaLabel={`Actions for ${title}`}
                              dropdownItems={[
                                { key: 'view', label: 'View details', onClick: () => navigate(modelPath(model)) },
                                { key: 'edit', label: 'Edit', onClick: () => navigate(`${modelPath(model)}/edit`) },
                                { isSpacer: true },
                                {
                                  key: 'delete',
                                  label: 'Delete',
                                  isDanger: true,
                                  onClick: () => confirmDelete(model),
                                },
                              ]}
                            />
                          </Td>
                        )}
                      </Tr>
                      <Tr isExpanded={isExpanded}>
                        <Td colSpan={columns.length + 1 + (canWrite ? 1 : 0)}>
                          <ExpandableRowContent>
                            {isExpanded &&
                              (model.clusters.length > 0 || model.selectedClusters.length > 0 ? (
                                <ModelClustersTable model={model} clusters={clusters} />
                              ) : (
                                <NotPlaced model={model} onEdit={edit} />
                              ))}
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
      </Stack>
    );
  };

  return (
    <>
      <PageStateSection
        title="Models"
        description="Deploy models to AI Grid clusters and check their status."
        loaded={loaded}
        error={error}
        onRetry={() => void refresh()}
        subject="Models"
        loadingLabel="Loading models"
      >
        {body()}
      </PageStateSection>
      {deleteModal}
      {/* A poll can move the model out of a state that opens the dialog; it closes then. */}
      {statusModel && statusOpens(statusModel.state) && (
        <ModelStatusModal model={statusModel} clusters={clusters} onClose={() => setStatusModelId(undefined)} />
      )}
    </>
  );
};
