import { Alert, Breadcrumb, BreadcrumbItem, Flex, List, ListItem, PageSection, Stack } from '@patternfly/react-core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ClustersService } from '../../api/clusters';
import { ServiceError } from '../../api/ConsoleService';
import type { ManagedModel } from '../../api/types';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { LoadError } from '../../components/LoadError';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { useConsoleSession } from '../../context/useConsoleSession';
import { useServiceData } from '../../hooks/useServiceData';
import { formatDateTime } from '../../utilities/format';
import { locationLabel, modelNotFound, modelPath, siteNamesOf } from './modelUtils';
import { ModelLocationsTable } from './ModelLocationsTable';
import { ModelStatusDetails, ModelStatusLabel } from './ModelStatus';
import { PARTIALLY_AVAILABLE, hasModelStatusDetails, modelPhase, modelStatusTitle } from './modelStatusInfo';
import type { ModelDeleteService } from './useDeleteModel';
import { useDeleteModel } from './useDeleteModel';

type Props = { service: ModelDeleteService & Pick<ClustersService, 'listClusters'> };

/** A model deployment at /models/:namespace/:name: its status explained, its configuration and its locations. */
export const ModelDetailsPage: React.FC<Props> = ({ service }) => {
  const { namespace = '', name = '' } = useParams();
  const navigate = useNavigate();
  const [loadedModel, loaded, error, refresh] = useServiceData<ManagedModel | undefined>(
    () => service.getModel(namespace, name),
    undefined,
  );
  const [clusters] = useServiceData(() => service.listClusters(), [], 0);
  const { user } = useConsoleSession();
  // A 404 means the deployment is gone, even when an earlier answer is still held.
  const notFound = error instanceof ServiceError && error.status === 404;
  const model = notFound ? undefined : loadedModel;
  const [confirmDelete, deleteModal] = useDeleteModel(service, {
    refresh: () => void refresh(),
    onDeleted: () => navigate('/models', { state: { notice: 'Model deployment deleted' } }),
  });
  const title = model?.displayName ?? name;
  const siteNames = siteNamesOf(clusters);

  const body = () => {
    if (!model) {
      return error && <LoadError subject="Models" error={error} notFound={modelNotFound(namespace, name)} />;
    }
    const phase = modelPhase(model);
    return (
      <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXl' }}>
        {/* Saved to Git says all git mode knows; the status label shows it, so no alert repeats it. */}
        {phase !== 'Ready' && phase !== 'Saved to Git' && hasModelStatusDetails(model) && (
          <Alert
            isInline
            variant={phase === 'Failed' ? 'danger' : phase === PARTIALLY_AVAILABLE ? 'warning' : 'info'}
            title={modelStatusTitle(model)}
            data-testid="model-status-alert"
          >
            <ModelStatusDetails model={model} />
          </Alert>
        )}
        <DetailsSection title="Deployment">
          <DetailsList
            aria-label="Deployment"
            items={[
              { term: 'Resource name', value: model.name },
              { term: 'Description', value: model.description },
              { term: 'Model', value: model.modelName ?? model.modelRef.name },
              { term: 'Model URI', value: model.modelUri },
              { term: 'Runtime image', value: model.runtimeImage },
              { term: 'Replicas', value: model.replicas },
              { term: 'Endpoint', value: model.endpoint },
              { term: 'Created', value: formatDateTime(model.creationTimestamp) },
            ]}
          />
        </DetailsSection>
        <DetailsSection title="Locations">
          {model.locations.length || model.works?.length ? (
            // model-locations names the section either way: the list until the clusters report,
            // then their table.
            <Stack hasGutter data-testid="model-locations">
              {/* Each cluster's status, as the Models page shows it under the model's row. */}
              {model.works?.length ? (
                <ModelLocationsTable
                  model={model}
                  works={model.works}
                  clusters={clusters}
                  siteNames={siteNames}
                  onEdit={user?.isProviderAdmin ? () => navigate(`${modelPath(model)}/edit`) : undefined}
                />
              ) : (
                <List>
                  {model.locations.map((location) => (
                    <ListItem key={location}>{locationLabel(location, siteNames)}</ListItem>
                  ))}
                </List>
              )}
              <Link to={`/ai-grid?model=${encodeURIComponent(`${model.namespace}/${model.name}`)}`}>
                Show on the AI Grid map
              </Link>
            </Stack>
          ) : (
            <p>The placement hasn’t chosen any locations yet.</p>
          )}
        </DetailsSection>
      </Flex>
    );
  };

  return (
    <>
      <PageHeader
        title={title}
        status={model && <ModelStatusLabel model={model} />}
        headerAction={
          model &&
          user?.isProviderAdmin && (
            <SimpleMenuActions
              toggleLabel="Actions"
              ariaLabel={`Actions for ${title}`}
              testId="model-actions"
              dropdownItems={[
                {
                  key: 'edit',
                  label: 'Edit',
                  onClick: () => navigate(`${modelPath(model)}/edit`),
                },
                { isSpacer: true },
                { key: 'delete', label: 'Delete', isDanger: true, onClick: () => confirmDelete(model) },
              ]}
            />
          )
        }
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to="/models">Models</Link>
            </BreadcrumbItem>
            <BreadcrumbItem isActive>{title}</BreadcrumbItem>
          </Breadcrumb>
        }
      />
      {!error && !loaded ? <PageLoading label="Loading model" /> : <PageSection isFilled>{body()}</PageSection>}
      {deleteModal}
    </>
  );
};
