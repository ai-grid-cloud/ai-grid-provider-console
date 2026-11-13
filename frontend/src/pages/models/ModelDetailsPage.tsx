import { Alert, Breadcrumb, BreadcrumbItem, Flex, Stack } from '@patternfly/react-core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ServiceError } from '../../api/ConsoleService';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { RelativeTime } from '../../components/RelativeTime';
import { PageStateSection } from '../../components/states/PageStateSection';
import { SectionEmptyState } from '../../components/states/SectionEmptyState';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { useConsoleSession } from '../../context/useConsoleSession';
import { modelNotFound, modelPath } from './modelUtils';
import { ClusterLoadNote } from './ClusterLoadNote';
import { ModelClustersTable } from './ModelClustersTable';
import { ModelMaaSTable } from './ModelMaaSTable';
import { ModelAvailability } from './ModelAvailability';
import { ModelStatusDetails, ModelStatusLabel } from './ModelStatus';
import { availabilityOf, rolloutExplanation } from './modelStatusInfo';
import { titleOf } from './modelView';
import { useDeleteModel } from './useDeleteModel';
import { useModel } from './useModels';
import { acceleratorsText, imageNameFor, runtimeImageText } from './modelHardware';
import { RuntimeImageValue } from './RuntimeImageValue';
import { useClusterList } from '../clusters/useClusters';

/**
 * A model deployment at /models/:id: its status explained, its configuration, its MaaS endpoint on
 * each ingress cluster, and its sync and deployment on each cluster it is placed on.
 */
export const ModelDetailsPage: React.FC = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: loadedModel, loaded, error, refresh } = useModel(id);
  const clusterList = useClusterList();
  const clusters = clusterList.data;
  const { user, config } = useConsoleSession();
  // A 404 means the deployment is gone, even when an earlier answer is still held (PageStateSection
  // shows the not-found state then).
  const model = error instanceof ServiceError && error.status === 404 ? undefined : loadedModel;
  const [confirmDelete, deleteModal] = useDeleteModel({
    refresh: () => void refresh(),
    onDeleted: () => navigate('/models'),
  });
  const title = model ? titleOf(model) : id;

  const body = () => {
    if (!model) {
      return null;
    }
    const availability = availabilityOf(model);
    const imageName = imageNameFor(config?.models?.hardware ?? [], model.runtimeImage);
    return (
      <Flex direction={{ default: 'column' }} flexWrap={{ default: 'nowrap' }} spaceItems={{ default: 'spaceItemsXl' }}>
        <ClusterLoadNote clusters={clusterList} />
        {/* The alert explains the header's Status word (status.state) from the placed clusters'
            reports (rolloutExplanation). Ready, Saved to Git and Unknown say all there is; MaaS has
            its own Availability section. */}
        {model.state !== 'Ready' &&
          model.state !== 'Saved to Git' &&
          model.state !== 'Unknown' &&
          rolloutExplanation(model) && (
            <Alert
              isInline
              variant={model.state === 'Failed' ? 'danger' : model.state === 'Partially ready' ? 'warning' : 'info'}
              title={model.state === 'Failed' ? 'Unable to deploy model' : model.state}
              data-testid="model-status-alert"
            >
              <ModelStatusDetails model={model} />
            </Alert>
          )}
        <DetailsSection title="Deployment">
          <DetailsList
            aria-label="Deployment"
            items={[
              { term: 'Resource name', value: model.id },
              { term: 'Description', value: model.description },
              { term: 'Model', value: model.modelName },
              { term: 'Model URI', value: model.modelUri },
              // What the model has, not a match against today's hardware list, which may have changed.
              ...(model.baseRefs.length > 0 ? [{ term: 'Presets', value: model.baseRefs.join(', ') }] : []),
              { term: 'CPU', value: model.cpu },
              { term: 'Memory', value: model.memory },
              { term: 'Accelerators', value: acceleratorsText(model) },
              {
                term: 'Runtime image',
                value:
                  imageName && model.runtimeImage ? (
                    <RuntimeImageValue name={imageName} image={model.runtimeImage} />
                  ) : (
                    runtimeImageText(model)
                  ),
              },
              { term: 'Replicas', value: model.autoscaled ? 'Autoscaled' : model.replicas },
              { term: 'Endpoint', value: model.url },
              { term: 'Created', value: model.creationTimestamp && <RelativeTime time={model.creationTimestamp} /> },
            ]}
          />
        </DetailsSection>
        <DetailsSection title="Availability">
          {model.ingress.length > 0 ? (
            <Stack hasGutter data-testid="model-maas-endpoint">
              {availability && <ModelAvailability model={model} availability={availability} onModelPage />}
              <ModelMaaSTable model={model} clusters={clusters} />
            </Stack>
          ) : (
            <SectionEmptyState title="No MaaS report yet">
              No ingress cluster has reported this model yet.
            </SectionEmptyState>
          )}
        </DetailsSection>
        <DetailsSection title="Clusters">
          {model.clusters.length || model.selectedClusters.length ? (
            // model-clusters names the section either way: each cluster's sync and deployment once
            // one reports, the clusters the placement chose until then.
            <Stack hasGutter data-testid="model-clusters">
              <ModelClustersTable model={model} clusters={clusters} />
              <Link to={`/ai-grid?model=${encodeURIComponent(model.id)}`}>View on the AI grid map</Link>
            </Stack>
          ) : (
            <SectionEmptyState title="No clusters selected">
              {model.placed
                ? 'No AI grid cluster matches this model’s placement.'
                : 'To serve this model, select one or more clusters.'}
            </SectionEmptyState>
          )}
        </DetailsSection>
      </Flex>
    );
  };

  return (
    <>
      <PageStateSection
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
                { key: 'edit', label: 'Edit', onClick: () => navigate(`${modelPath(model)}/edit`) },
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
        loaded={loaded}
        error={error}
        onRetry={() => void refresh()}
        subject="Models"
        object="model"
        loadingLabel="Loading model"
        notFound={modelNotFound(id)}
      >
        {body()}
      </PageStateSection>
      {deleteModal}
    </>
  );
};
