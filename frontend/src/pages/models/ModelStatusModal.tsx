// A model's status in a modal, opened from its status label: jgiardino's Models page design
// ("models per cluster"), where a status label that can be clicked always opens a modal.
import { Button, Flex, FlexItem, Label, Modal, ModalBody, ModalFooter, ModalHeader } from '@patternfly/react-core';
import type { ManagedModel } from '../../api/types';
import { getPhaseProps } from '../../utilities/phaseLabelUtils';
import { ModelStatusDetails } from './ModelStatus';
import { PARTIALLY_AVAILABLE, hasModelStatusDetails, modelPhase } from './modelStatusInfo';

type Props = {
  model: ManagedModel;
  onClose: () => void;
  /** Shows each location's status (the Models page expands the model's row); absent on its own page. */
  onViewLocations?: () => void;
};

/** The model's status explained; Partially available says how many clusters serve it and points at the locations. */
export const ModelStatusModal: React.FC<Props> = ({ model, onClose, onViewLocations }) => {
  const title = model.displayName ?? model.name;
  const phase = modelPhase(model);
  const { icon, status, color } = getPhaseProps(phase);
  const partial = phase === PARTIALLY_AVAILABLE;
  return (
    <Modal
      isOpen
      variant="small"
      onClose={onClose}
      aria-labelledby="model-status-modal-title"
      data-testid="model-status-modal"
    >
      <ModalHeader
        labelId="model-status-modal-title"
        title={
          <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>{title} status</FlexItem>
            <FlexItem>
              <Label isCompact variant="outline" icon={icon} status={status} color={color}>
                {phase}
              </Label>
            </FlexItem>
          </Flex>
        }
      />
      <ModalBody>
        {partial ? (
          <>
            <p>{model.statusMessage ?? 'Some of its clusters aren’t serving the model.'}</p>
            <p>
              {onViewLocations
                ? 'See each location’s status in the table.'
                : 'See each location’s status under Locations.'}
            </p>
          </>
        ) : hasModelStatusDetails(model) ? (
          <ModelStatusDetails model={model} />
        ) : (
          <p>The backend hasn’t reported more about this status yet.</p>
        )}
      </ModalBody>
      <ModalFooter>
        {partial && onViewLocations && (
          <Button variant="primary" onClick={onViewLocations}>
            View locations
          </Button>
        )}
        <Button variant="link" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
