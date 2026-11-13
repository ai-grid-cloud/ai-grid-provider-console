import { useState } from 'react';
import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import type { ModelView } from './modelView';
import { Link, useParams } from 'react-router-dom';
import { PageStateSection } from '../../components/states/PageStateSection';
import { modelNotFound, modelPath } from './modelUtils';
import { ModelWizard } from './ModelWizard';
import { useModel } from './useModels';

/**
 * Edits a model deployment at /models/:id/edit in the deploy wizard. It loads the model once, as
 * the details page does, so the wizard starts from the version the user saw.
 */
export const ModelEditPage: React.FC = () => {
  const { id = '' } = useParams();
  const { data: loadedModel, loaded, error, refresh } = useModel(id, { poll: false });
  // The first model that arrives stays the wizard's: an edit is checked against the version it
  // started from (lock), so a later answer mustn't replace it underneath the user.
  const [model, setModel] = useState<ModelView>();
  if (loadedModel && !model) setModel(loadedModel);
  if (model) {
    return <ModelWizard key={id} model={model} />;
  }
  return (
    <PageStateSection
      title="Edit model"
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/models">Models</Link>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <Link to={modelPath({ id })}>{id}</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>Edit</BreadcrumbItem>
        </Breadcrumb>
      }
      loaded={loaded}
      error={error}
      onRetry={() => void refresh()}
      subject="Models"
      object="model"
      loadingLabel="Loading model"
      notFound={modelNotFound(id)}
    />
  );
};
