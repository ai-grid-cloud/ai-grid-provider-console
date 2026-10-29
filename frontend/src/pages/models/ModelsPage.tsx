// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelsPage.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deployments/DeploymentsTable.tsx
// and components/global/GlobalDeploymentsView.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The UX team's "models per cluster" design (jgiardino/ai-grid-provider-console@ada68ad): a model
// row expands to its locations and each one's status; the Locations cell shows up to five compact
// labels. The models are the backend's Models/List over Connect (useModels.ts).
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Label, LabelGroup, ToolbarItem } from '@patternfly/react-core';
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
import { locationLabel, modelPath, siteNamesOf } from './modelUtils';
import { ModelLocationsTable } from './ModelLocationsTable';
import { NotPlaced } from './NotPlaced';
import { ModelStatusLabel } from './ModelStatus';
import { titleOf, type ModelView } from './modelView';
import { useDeleteModel } from './useDeleteModel';
import { useModelList } from './useModels';
import { useClusterList } from '../clusters/useClusters';

type Column = { label: string; isNumber?: boolean; sort: (a: ModelView, b: ModelView) => number };

const columns: Column[] = [
  { label: 'Name', sort: (a, b) => titleOf(a).localeCompare(titleOf(b)) },
  { label: 'Model', sort: (a, b) => (a.modelName ?? a.id).localeCompare(b.modelName ?? b.id) },
  { label: 'Replicas', isNumber: true, sort: (a, b) => (a.replicas ?? 0) - (b.replicas ?? 0) },
  { label: 'Locations', sort: (a, b) => a.locations.length - b.locations.length },
  { label: 'Created', sort: (a, b) => (a.creationTimestamp ?? '').localeCompare(b.creationTimestamp ?? '') },
  { label: 'Status', sort: (a, b) => a.phase.localeCompare(b.phase) },
];

export const ModelsPage: React.FC = () => {
  const navigate = useNavigate();
  const { data: models, loaded, error, refresh } = useModelList();
  const { data: clusters } = useClusterList();
  const { user } = useConsoleSession();
  const siteNames = useMemo(() => siteNamesOf(clusters), [clusters]);
  const canWrite = !!user?.isProviderAdmin;
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  // The models whose rows show their locations.
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
  const [confirmDelete, deleteModal] = useDeleteModel({
    refresh: () => void refresh(),
    onDeleted: () => {
      // Replace, so the notice doesn't add a second Models entry to the browser's history.
      void navigate('.', { replace: true, state: { notice: 'Model deleted' } });
    },
  });

  const rows = useMemo(() => {
    const term = filter.toLowerCase();
    const compare = columns[sortBy.index].sort;
    return models
      .filter((m) =>
        `${m.displayName ?? ''} ${m.id} ${m.modelName ?? ''} ${m.locations.join(' ')}`.toLowerCase().includes(term),
      )
      .sort((a, b) => (sortBy.direction === 'asc' ? compare(a, b) : compare(b, a)));
  }, [models, filter, sortBy]);

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
      <PaginatedTable
        rows={rows}
        toolbar={
          <>
            <ToolbarSearch
              label="Filter models"
              placeholder="Filter by name or location"
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
                <Th screenReaderText="Show locations" />
                {columns.map((c, i) => (
                  <Th
                    key={c.label}
                    sort={sortParams(i)}
                    modifier="wrap"
                    className={c.isNumber ? 'console-number' : undefined}
                  >
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
                const isExpanded = expanded.has(model.id);
                const edit = canWrite ? () => navigate(`${modelPath(model)}/edit`) : undefined;
                return (
                  <Tbody key={model.id} isExpanded={isExpanded}>
                    <Tr isContentExpanded={isExpanded}>
                      {/* Every row expands: to each placed cluster's status, to the clusters its
                          placement chose while none has reported, or to say it has none. */}
                      <Td
                        expand={{
                          rowIndex,
                          isExpanded,
                          onToggle: () => setRowExpanded(model.id, !isExpanded),
                          expandId: `model-locations-toggle-${model.id}`,
                        }}
                      />
                      <Td dataLabel="Name">
                        <Link to={modelPath(model)}>{title}</Link>
                      </Td>
                      <Td dataLabel="Model" modifier="breakWord">
                        {model.modelName ?? EMPTY_VALUE}
                      </Td>
                      <Td dataLabel="Replicas" className="console-number">
                        {model.replicas ?? EMPTY_VALUE}
                      </Td>
                      <Td dataLabel="Locations" data-testid={`model-locations-${model.id}`}>
                        {model.locations.length ? (
                          <LabelGroup numLabels={5}>
                            {model.locations.map((location) => (
                              <Label key={location} color="grey" isCompact>
                                {locationLabel(location, siteNames)}
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
                        <ModelStatusLabel model={model} />
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
                      <Td />
                      <Td colSpan={columns.length + (canWrite ? 1 : 0)}>
                        <ExpandableRowContent>
                          {isExpanded &&
                            (model.clusters.length > 0 || model.selectedClusters.length > 0 ? (
                              <ModelLocationsTable
                                model={model}
                                clusters={clusters}
                                siteNames={siteNames}
                                onEdit={edit}
                                isNested
                              />
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
    );
  };

  return (
    <>
      <PageStateSection
        title="Models"
        description="Deploy models to AI Grid locations and check their status."
        loaded={loaded}
        error={error}
        onRetry={() => void refresh()}
        subject="Models"
        loadingLabel="Loading models"
      >
        {body()}
      </PageStateSection>
      {deleteModal}
    </>
  );
};
