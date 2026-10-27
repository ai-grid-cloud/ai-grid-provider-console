// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelsPage.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deployments/DeploymentsTable.tsx
// and components/global/GlobalDeploymentsView.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// jgiardino's "models per cluster" design (jgiardino/ai-grid-provider-console@ada68ad): a model
// row expands to its locations and each one's status; the Locations cell shows up to five compact
// labels.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Label,
  LabelGroup,
  PageSection,
  Stack,
  ToolbarItem,
} from '@patternfly/react-core';
import { ExpandableRowContent, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ThProps } from '@patternfly/react-table';
import type { ClustersService } from '../../api/clusters';
import type { ManagedModel } from '../../api/types';
import { LoadError } from '../../components/LoadError';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { PaginatedTable } from '../../components/PaginatedTable';
import { RelativeTime } from '../../components/RelativeTime';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { ToolbarSearch } from '../../components/ToolbarSearch';
import { TableEmptyRow } from '../../components/TableEmptyRow';
import { useConsoleSession } from '../../context/useConsoleSession';
import { useServiceData } from '../../hooks/useServiceData';
import { EMPTY_VALUE } from '../../utilities/format';
import { locationLabel, modelPath, siteNamesOf } from './modelUtils';
import { ModelLocationsTable } from './ModelLocationsTable';
import { ModelStatusLabel } from './ModelStatus';
import type { ModelDeleteService } from './useDeleteModel';
import { useDeleteModel } from './useDeleteModel';

type Props = { service: ModelDeleteService & Pick<ClustersService, 'listClusters'> };

type Column = { label: string; sort: (a: ManagedModel, b: ManagedModel) => number };

const columns: Column[] = [
  { label: 'Name', sort: (a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name) },
  { label: 'Model', sort: (a, b) => (a.modelName ?? a.modelRef.name).localeCompare(b.modelName ?? b.modelRef.name) },
  { label: 'Replicas', sort: (a, b) => (a.replicas ?? 0) - (b.replicas ?? 0) },
  { label: 'Locations', sort: (a, b) => a.locations.length - b.locations.length },
  { label: 'Created', sort: (a, b) => (a.creationTimestamp ?? '').localeCompare(b.creationTimestamp ?? '') },
  { label: 'Status', sort: (a, b) => (a.phase ?? '').localeCompare(b.phase ?? '') },
];

const keyOf = (model: ManagedModel) => `${model.namespace}/${model.name}`;

export const ModelsPage: React.FC<Props> = ({ service }) => {
  const navigate = useNavigate();
  const [deployments, loaded, error, refresh] = useServiceData<ManagedModel[]>(() => service.listModels(), []);
  const [clusters] = useServiceData(() => service.listClusters(), [], 0);
  const { user } = useConsoleSession();
  const siteNames = useMemo(() => siteNamesOf(clusters), [clusters]);
  const canWrite = !!user?.isProviderAdmin;
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<{ index: number; direction: 'asc' | 'desc' }>({ index: 0, direction: 'asc' });
  // The models whose rows show their locations.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const setRowExpanded = (key: string, open: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  const [confirmDelete, deleteModal] = useDeleteModel(service, {
    refresh: () => void refresh(),
    onDeleted: () => void refresh(),
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

  const deployButton = canWrite ? (
    <Button component={(props) => <Link {...props} to="/models/deploy" />}>Deploy model</Button>
  ) : null;

  const sortParams = (index: number): ThProps['sort'] => ({
    sortBy,
    onSort: (_event, i, direction) => setSortBy({ index: i, direction }),
    columnIndex: index,
  });

  const errorAlert = error && (
    <LoadError subject="Models" error={error} title="Error loading models" onRetry={() => void refresh()} />
  );

  const body = () => {
    // A failed refresh keeps the last list and shows the error above it.
    if (error && deployments.length === 0) {
      return errorAlert;
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
      <Stack hasGutter>
        {errorAlert}
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
            </>
          }
        >
          {(pageRows) => (
            <Table aria-label="Model deployments" isExpandable data-testid="model-deployments-table">
              <Thead>
                <Tr>
                  <Th screenReaderText="Show locations" />
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
                pageRows.map((deployment, rowIndex) => {
                  const title = deployment.displayName ?? deployment.name;
                  const key = keyOf(deployment);
                  const works = deployment.works ?? [];
                  const isExpanded = works.length > 0 && expanded.has(key);
                  return (
                    <Tbody key={key} isExpanded={isExpanded}>
                      <Tr isContentExpanded={isExpanded}>
                        {works.length > 0 ? (
                          <Td
                            expand={{
                              rowIndex,
                              isExpanded,
                              onToggle: () => setRowExpanded(key, !isExpanded),
                              expandId: `model-locations-toggle-${deployment.name}`,
                            }}
                          />
                        ) : (
                          <Td />
                        )}
                        <Td dataLabel="Name">
                          <Link to={modelPath(deployment)}>{title}</Link>
                        </Td>
                        <Td dataLabel="Model" modifier="breakWord">
                          {deployment.modelName ?? deployment.modelRef.name}
                        </Td>
                        <Td dataLabel="Replicas">{deployment.replicas ?? EMPTY_VALUE}</Td>
                        <Td dataLabel="Locations" data-testid={`model-locations-${deployment.name}`}>
                          {deployment.locations.length ? (
                            <LabelGroup numLabels={5}>
                              {deployment.locations.map((location) => (
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
                          <RelativeTime time={deployment.creationTimestamp} />
                        </Td>
                        <Td dataLabel="Status">
                          <ModelStatusLabel
                            model={deployment}
                            onViewLocations={works.length ? () => setRowExpanded(key, true) : undefined}
                          />
                        </Td>
                        {canWrite && (
                          <Td isActionCell>
                            <SimpleMenuActions
                              testId={`model-actions-${deployment.name}`}
                              ariaLabel={`Actions for ${title}`}
                              dropdownItems={[
                                { key: 'view', label: 'View details', onClick: () => navigate(modelPath(deployment)) },
                                {
                                  key: 'edit',
                                  label: 'Edit',
                                  onClick: () => navigate(`${modelPath(deployment)}/edit`),
                                },
                                { isSpacer: true },
                                {
                                  key: 'delete',
                                  label: 'Delete',
                                  isDanger: true,
                                  onClick: () => confirmDelete(deployment),
                                },
                              ]}
                            />
                          </Td>
                        )}
                      </Tr>
                      {works.length > 0 && (
                        <Tr isExpanded={isExpanded}>
                          <Td />
                          <Td noPadding colSpan={columns.length + (canWrite ? 1 : 0)}>
                            <ExpandableRowContent>
                              {isExpanded && (
                                <div className="pf-v6-u-pb-lg">
                                  <ModelLocationsTable
                                    model={deployment}
                                    works={works}
                                    clusters={clusters}
                                    siteNames={siteNames}
                                    onEdit={canWrite ? () => navigate(`${modelPath(deployment)}/edit`) : undefined}
                                    isNested
                                  />
                                </div>
                              )}
                            </ExpandableRowContent>
                          </Td>
                        </Tr>
                      )}
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
      <PageHeader title="Models" description="Add and remove model deployments." />
      {!(error && deployments.length === 0) && !loaded ? (
        <PageLoading label="Loading models" />
      ) : (
        <PageSection isFilled>{body()}</PageSection>
      )}
      {deleteModal}
    </>
  );
};
