import { Breadcrumb, BreadcrumbItem, PageSection } from '@patternfly/react-core';
import { Link, useParams } from 'react-router-dom';
import type { UserService } from '../../api/ConsoleService';
import type { ClustersService } from '../../api/clusters';
import type { ModelsService } from '../../api/models';
import type { ManagedModel } from '../../api/types';
import { LoadError } from '../../components/LoadError';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { useServiceData } from '../../hooks/useServiceData';
import { modelNotFound, modelPath } from './modelUtils';
import { ModelWizard } from './ModelWizard';

type Props = { service: ModelsService & UserService & Pick<ClustersService, 'listClusters'> };

/**
 * Edits a model deployment at /models/:namespace/:name/edit in the deploy wizard. It loads the
 * model once, as the details page does, so the wizard starts from the version the user saw.
 */
export const ModelEditPage: React.FC<Props> = ({ service }) => {
  const { namespace = '', name = '' } = useParams();
  const [model, loaded, error] = useServiceData<ManagedModel | undefined>(
    () => service.getModel(namespace, name),
    undefined,
    0,
  );
  if (model) {
    return <ModelWizard key={`${namespace}/${name}`} service={service} model={model} />;
  }
  const detailsPath = modelPath({ namespace, name });
  return (
    <>
      <PageHeader
        title={`Edit ${name}`}
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to="/models">Models</Link>
            </BreadcrumbItem>
            <BreadcrumbItem>
              <Link to={detailsPath}>{name}</Link>
            </BreadcrumbItem>
            <BreadcrumbItem isActive>Edit</BreadcrumbItem>
          </Breadcrumb>
        }
      />
      {!error && !loaded ? (
        <PageLoading label="Loading model" />
      ) : (
        <PageSection isFilled>
          {error && <LoadError subject="Models" error={error} notFound={modelNotFound(namespace, name)} />}
        </PageSection>
      )}
    </>
  );
};
