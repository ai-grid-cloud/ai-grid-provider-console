// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/DeleteSubscriptionModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/DeleteSubscriptionModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { Stack, StackItem } from '@patternfly/react-core';
import type { SubscriptionsService } from '../../api/subscriptions';
import type { MaaSSubscription } from '../../api/types';
import { DeleteModal } from '../../components/DeleteModal';
import { useDeleteSubscription } from '../../hooks/useDeleteSubscription';

type Props = {
  service: SubscriptionsService;
  subscription: MaaSSubscription;
  onClose: (deleted?: boolean) => void;
};

export const DeleteSubscriptionModal: React.FC<Props> = ({ service, subscription, onClose }) => {
  const { isDeleting, error, deleteSubscriptionCallback } = useDeleteSubscription(service);
  const name = subscription.displayName || subscription.name;
  return (
    <DeleteModal
      title="Delete subscription?"
      onClose={() => onClose()}
      deleting={isDeleting}
      onDelete={async () => {
        if (await deleteSubscriptionCallback(subscription.name, subscription.resourceVersion)) {
          onClose(true);
        }
      }}
      submitButtonLabel="Delete"
      deleteName={name}
      error={error}
      genericLabel
      testId="delete-subscription-modal"
    >
      <Stack hasGutter>
        <StackItem data-testid="delete-modal-confirmation-message">
          Are you sure you want to delete the subscription <strong>{name}</strong>?
        </StackItem>
        <StackItem>The automatically created authorization policy will also be deleted.</StackItem>
      </Stack>
    </DeleteModal>
  );
};
