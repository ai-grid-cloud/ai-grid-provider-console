import type { CSSProperties, ReactNode } from 'react';
import {
  Alert,
  Button,
  Flex,
  FlexItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  StackItem,
  Title,
} from '@patternfly/react-core';
import { statusLabelProps } from '../../utilities/status';
import { ModelStatusDetails } from './ModelStatus';
import { hasModelStatusDetails, modelPhase, modelStatusTitle, PARTIALLY_AVAILABLE } from './modelStatusInfo';
import { titleOf, type ModelView } from './modelView';

type Props = {
  model: ModelView;
  onClose: () => void;
  /** Partially available: close the modal and expand the model's location rows. */
  onViewDeployments?: () => void;
};

/**
 * High-level model status from the Models list. Ready does not open this. The phase is the
 * backend's (including Partially available); the body is that phase in words.
 */
export const ModelStatusModal: React.FC<Props> = ({ model, onClose, onViewDeployments }) => {
  const title = titleOf(model);
  const displayStatus = modelPhase(model);
  const partiallyAvailable = displayStatus === PARTIALLY_AVAILABLE;

  let body: ReactNode;
  if (partiallyAvailable) {
    body = (
      <Stack hasGutter data-testid="model-status-modal-message">
        <StackItem>
          <p>One or more model deployments are not ready</p>
        </StackItem>
        {model.statusMessage && (
          <StackItem>
            <p>{model.statusMessage}</p>
          </StackItem>
        )}
      </Stack>
    );
  } else if (displayStatus === 'Failed' || hasModelStatusDetails(model)) {
    body = (
      <Alert
        isInline
        variant={displayStatus === 'Failed' ? 'danger' : 'info'}
        title={modelStatusTitle(model)}
        data-testid="model-status-modal-alert"
      >
        <ModelStatusDetails model={model} />
      </Alert>
    );
  } else if (displayStatus === 'Pending') {
    body = (
      <Stack hasGutter data-testid="model-status-modal-message">
        <StackItem>
          <p>This model is still being placed or rolled out to its locations.</p>
        </StackItem>
        {model.statusMessage && (
          <StackItem>
            <p>{model.statusMessage}</p>
          </StackItem>
        )}
      </Stack>
    );
  } else {
    body = (
      <p data-testid="model-status-modal-message">
        {model.statusMessage ?? `This model is ${displayStatus.toLowerCase()}.`}
      </p>
    );
  }

  return (
    <Modal
      variant="medium"
      isOpen
      onClose={onClose}
      data-testid="model-status-modal"
      aria-label={`${title} model status`}
    >
      <ModalHeader
        data-testid="model-status-modal-header"
        style={{ '--pf-v6-c-modal-box__header--Gap': 'var(--pf-t--global--spacer--sm)' } as CSSProperties}
      >
        <Title headingLevel="h1" size="2xl" data-testid="model-status-modal-title">
          <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>{title}</FlexItem>
            <FlexItem>
              <Label {...statusLabelProps(displayStatus)} variant="filled" data-testid="model-status-text">
                {displayStatus}
              </Label>
            </FlexItem>
          </Flex>
        </Title>
        <p data-testid="model-status-modal-subtitle">Deployment status</p>
      </ModalHeader>
      <ModalBody>{body}</ModalBody>
      {partiallyAvailable && onViewDeployments && (
        <ModalFooter>
          <Button variant="link" isInline onClick={onViewDeployments} data-testid="model-status-view-deployments">
            View model deployments per location
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
};
