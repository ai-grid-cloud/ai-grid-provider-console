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
  Tooltip,
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
  /** Loading the object again after a failed delete failed too, so a retry sends the old version. */
  reloadError?: Error;
  children: React.ReactNode;
  testId?: string;
  /** The failure's title; "Unable to delete <name>" without one. */
  errorTitle?: string;
  /** Why Delete can't be used now; set, it disables Delete and shows this in a tooltip. */
  disabledReason?: string;
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
  reloadError,
  submitButtonLabel = 'Delete',
  testId,
  errorTitle,
  disabledReason,
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
            <Flex
              direction={{ default: 'column' }}
              flexWrap={{ default: 'nowrap' }}
              spaceItems={{ default: 'spaceItemsSm' }}
            >
              <FlexItem id="delete-modal-prompt">
                Type <strong>{deleteNameSanitized}</strong> to confirm:
              </FlexItem>
              <TextInput
                id="delete-modal-input"
                data-testid="delete-modal-input"
                // Named by the prompt above it, so a screen reader says what to type.
                aria-labelledby="delete-modal-prompt"
                value={value}
                onChange={(_event, newValue) => setValue(newValue)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && confirmed && !deleting && !disabledReason) {
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
                title={errorTitle ?? `Unable to delete ${deleteNameSanitized}`}
                isInline
                variant="danger"
              >
                {error.message}
                {reloadError && <p>Unable to reload the latest version: {reloadError.message}</p>}
              </Alert>
            </StackItem>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        {disabledReason ? (
          // Aria-disabled, not disabled, so the button takes focus and shows why from the keyboard.
          <Tooltip content={disabledReason}>
            <Button variant="danger" isAriaDisabled>
              {submitButtonLabel}
            </Button>
          </Tooltip>
        ) : (
          <Button variant="danger" isLoading={deleting} isDisabled={deleting || !confirmed} onClick={onDelete}>
            {submitButtonLabel}
          </Button>
        )}
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};
