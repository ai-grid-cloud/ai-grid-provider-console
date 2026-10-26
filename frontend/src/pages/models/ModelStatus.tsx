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
      <p>{known?.summary ?? 'The controller couldn’t deploy this model.'}</p>
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
 * The model's phase. Ready is an outline label and opens nothing. On the Models list, every other
 * phase is filled and `onOpen` opens ModelStatusModal. Without `onOpen` (the model page), the
 * backend's message stays in a tooltip; the page explains it in the alert.
 */
export const ModelStatusLabel: React.FC<{ model: ModelView; onOpen?: () => void }> = ({ model, onOpen }) => {
  const phase = modelPhase(model);
  const opens = phase !== 'Ready' && !!onOpen;
  return (
    <span data-testid="model-phase">
      <StatusLabel
        isCompact
        status={phase}
        reason={opens ? undefined : (model.statusMessage ?? model.reason)}
        onClick={opens ? onOpen : undefined}
      />
    </span>
  );
};
