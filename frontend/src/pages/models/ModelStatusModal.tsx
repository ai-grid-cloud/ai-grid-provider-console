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
import type { ClusterView } from '../clusters/clusterView';
import { statusLabelProps } from '../../utilities/status';
import { ModelLocationsTable } from './ModelLocationsTable';
import { ModelStatusDetails } from './ModelStatus';
import {
  gitStatusMessage,
  hasModelStatusDetails,
  listStatusOf,
  modelStatusTitle,
  PARTIALLY_AVAILABLE,
} from './modelStatusInfo';
import { titleOf, type ModelView } from './modelView';
import { statusModalLayout } from './statusModalLayout';

type Props = {
  model: ModelView;
  /** The hub's clusters, so the locations table can name each site and link to the cluster. */
  clusters?: Pick<ClusterView, 'name' | 'location' | 'consoleUrl'>[];
  siteNames?: Map<string, string>;
  onClose: () => void;
};

/**
 * High-level model status from the Models list. Ready does not open this. The phase is the
 * backend's (including Partially ready); the body is that phase in words.
 */
export const ModelStatusModal: React.FC<Props> = ({ model, clusters = [], siteNames = new Map(), onClose }) => {
  const title = titleOf(model);
  const displayStatus = listStatusOf(model);
  const partiallyAvailable = displayStatus === PARTIALLY_AVAILABLE;
  const gitMessage = gitStatusMessage[displayStatus];

  let body: ReactNode;
  if (gitMessage) {
    body = <p data-testid="model-status-modal-message">{gitMessage}</p>;
  } else if (partiallyAvailable) {
    body = (
      <Stack hasGutter>
        <StackItem>
          <p>One or more model deployments are not ready</p>
        </StackItem>
        <StackItem>
          <ModelLocationsTable model={model} clusters={clusters} siteNames={siteNames} />
        </StackItem>
      </Stack>
    );
  } else if (displayStatus === 'Failed' || hasModelStatusDetails(model)) {
    body = (
      <Alert
        isInline
        isPlain
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
      {...statusModalLayout}
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
              <Label isCompact {...statusLabelProps(displayStatus)} variant="filled" data-testid="model-status-text">
                {displayStatus}
              </Label>
            </FlexItem>
          </Flex>
        </Title>
        <p data-testid="model-status-modal-subtitle">
          <strong>Deployment status</strong>
        </p>
      </ModalHeader>
      <ModalBody>{body}</ModalBody>
      {displayStatus === 'Saved to Git' && (
        <ModalFooter>
          {/* Argo CD refresh is not a console call yet. The action is the proposed footer. */}
          <Button variant="primary" onClick={() => undefined} data-testid="model-status-sync-now">
            Sync now
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
};
