import { Alert } from '@patternfly/react-core';
import { olderServedNameOf, type ModelView } from './modelView';

/**
 * Says that a model saved before the backend served every model as its id still answers only to
 * another name, and that saving any change moves it to its id (backend 1141af0, README.md "For
 * models"). Nothing for any other model.
 *
 * Why users' requests fail: MaaS lists the model under its id and forwards the request body
 * unchanged, so vLLM receives the id. The AI gateway applies an ExternalModel's targetModel (the
 * served name) only with API translation on, and strips it otherwise
 * (opendatahub-io/ai-gateway-controller pkg/envelope/envelope.go L253-L262 at d1bad0c7). If API
 * translation is ever enabled for these models, revisit "so their requests to it fail".
 */
export const OlderServedNameAlert: React.FC<{ model: Pick<ModelView, 'id' | 'modelName'> }> = ({ model }) => {
  const served = olderServedNameOf(model);
  if (!served) return null;
  return (
    <Alert isInline variant="info" title="This model uses an older name" data-testid="model-older-name">
      Users request models by their ID, <code>{model.id}</code>, but this model still answers only to{' '}
      <code>{served}</code>, so their requests to it fail. Saving any change updates it to use its ID. The model is
      unavailable for a moment while it restarts.
    </Alert>
  );
};
