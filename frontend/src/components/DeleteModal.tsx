// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/DeleteModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/DeleteModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Flex,
  FlexItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  StackItem,
  TextInput,
} from '@patternfly/react-core';

type Props = {
  title: string;
  onClose: () => void;
  deleting: boolean;
  onDelete: () => void;
  /** The user types this to enable Delete. */
  deleteName: string;
  submitButtonLabel?: string;
  error?: Error;
  children: React.ReactNode;
  testId?: string;
  genericLabel?: boolean;
};

/** A delete confirmation that needs the resource's name typed in. */
export const DeleteModal: React.FC<Props> = ({
  children,
  title,
  onClose,
  deleting,
  onDelete,
  deleteName,
  error,
  submitButtonLabel = 'Delete',
  testId,
  genericLabel,
}) => {
  const [value, setValue] = useState('');
  const deleteNameSanitized = useMemo(() => deleteName.trim().replace(/\s+/g, ' '), [deleteName]);
  const confirmed = value.trim() === deleteNameSanitized;

  return (
    <Modal isOpen onClose={onClose} variant="small" data-testid={testId || 'delete-modal'}>
      <ModalHeader title={title} titleIconVariant="warning" />
      <ModalBody>
        <Stack hasGutter>
          <StackItem>{children}</StackItem>
          <StackItem>
            <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsSm' }}>
              <FlexItem>
                Type <strong>{deleteNameSanitized}</strong> to confirm
                {genericLabel ? '' : ' deletion'}:
              </FlexItem>
              <TextInput
                id="delete-modal-input"
                data-testid="delete-modal-input"
                aria-label="Delete modal input"
                value={value}
                onChange={(_event, newValue) => setValue(newValue)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && confirmed && !deleting) {
                    onDelete();
                  }
                }}
              />
            </Flex>
          </StackItem>
          {error && (
            <StackItem>
              <Alert
                data-testid="delete-model-error-message-alert"
                title={`Error deleting ${deleteNameSanitized}`}
                isInline
                variant="danger"
              >
                {error.message}
              </Alert>
            </StackItem>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button variant="danger" isLoading={deleting} isDisabled={deleting || !confirmed} onClick={onDelete}>
          {submitButtonLabel}
        </Button>
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};
