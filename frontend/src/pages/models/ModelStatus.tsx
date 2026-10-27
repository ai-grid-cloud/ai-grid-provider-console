import { useState } from 'react';
import { ExpandableSection, Label, Stack } from '@patternfly/react-core';
import type { ManagedModel } from '../../api/types';
import { getPhaseProps } from '../../utilities/phaseLabelUtils';
import { ModelStatusModal } from './ModelStatusModal';
import { failureExplanations, modelPhase } from './modelStatusInfo';

/**
 * The status in words: a sentence and the next step for a known failure, else the controller's
 * message; the controller's raw reason and message fold away under "Details".
 */
export const ModelStatusDetails: React.FC<{ model: ManagedModel }> = ({ model }) => {
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

type LabelProps = {
  model: ManagedModel;
  /** On the Models page: expands the model's row to its locations, from the Partially available modal. */
  onViewLocations?: () => void;
};

/**
 * The model's phase as a label. As in jgiardino's Models design (an RHOAI pattern), only a label
 * that can be clicked is filled: Ready and Saved to Git are outline labels with nothing to open (Saved
 * to Git is all git mode knows, so a modal would only repeat it); any other status opens
 * ModelStatusModal.
 */
export const ModelStatusLabel: React.FC<LabelProps> = ({ model, onViewLocations }) => {
  const [open, setOpen] = useState(false);
  const phase = modelPhase(model);
  const { icon, status, color } = getPhaseProps(phase);
  if (phase === 'Ready' || phase === 'Saved to Git') {
    return (
      <span data-testid="model-phase">
        <Label isCompact variant="outline" icon={icon} status={status} color={color}>
          {phase}
        </Label>
      </span>
    );
  }
  return (
    <span data-testid="model-phase">
      <Label isCompact variant="filled" icon={icon} status={status} color={color} onClick={() => setOpen(true)}>
        {phase}
      </Label>
      {open && (
        <ModelStatusModal
          model={model}
          onClose={() => setOpen(false)}
          onViewLocations={
            onViewLocations &&
            (() => {
              setOpen(false);
              onViewLocations();
            })
          }
        />
      )}
    </span>
  );
};
