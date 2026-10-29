import { ExpandableSection, Stack } from '@patternfly/react-core';
import type { ModelView } from './modelView';
import { StatusLabel } from '../../components/StatusLabel';
import { failureExplanations, modelPhase } from './modelStatusInfo';

/**
 * The status in words: a sentence and the next step for a known failure, else the backend's
 * message; the raw reason and message fold away under "Details".
 */
export const ModelStatusDetails: React.FC<{ model: ModelView }> = ({ model }) => {
  const known = model.reason ? failureExplanations[model.reason] : undefined;
  const failed = modelPhase(model) === 'Failed';
  if (!known && !failed) {
    return <>{model.statusMessage ?? model.reason}</>;
  }
  return (
    <Stack hasGutter>
      <p>{known?.summary ?? 'Unable to deploy this model.'}</p>
      {known && <p>{known.next}</p>}
      <ExpandableSection toggleText="Details">
        <code className="pf-v6-u-font-size-sm pf-v6-u-text-break-word">
          {[model.reason, model.statusMessage].filter(Boolean).join(': ')}
        </code>
      </ExpandableSection>
    </Stack>
  );
};

/**
 * The model's phase as an outline StatusLabel, the backend's message (else its reason) in a tooltip.
 * A model's status opens nothing: its locations are in the row's expanded content and on its page,
 * where each cluster's status opens what that cluster reported.
 */
export const ModelStatusLabel: React.FC<{ model: ModelView }> = ({ model }) => (
  <span data-testid="model-phase">
    <StatusLabel isCompact status={modelPhase(model)} reason={model.statusMessage ?? model.reason} />
  </span>
);
