// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/DeleteSubscriptionModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/DeleteSubscriptionModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useState } from 'react';
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
  const { error, deleteSubscriptionCallback } = useDeleteSubscription(service);
  // After a failed delete the modal loads the subscription again, so a retry sends the version the
  // backend has now (as a model's delete does) while the typed name stays. The dialog stays busy
  // until that reload is in, so a retry never sends the old version.
  const [current, setCurrent] = useState(subscription);
  const [busy, setBusy] = useState(false);
  const [reloadError, setReloadError] = useState<Error>();
  const name = subscription.displayName || subscription.name;
  return (
    <DeleteModal
      title="Delete subscription?"
      onClose={() => onClose()}
      deleting={busy}
      onDelete={async () => {
        if (busy) return;
        setBusy(true);
        setReloadError(undefined);
        try {
          if (await deleteSubscriptionCallback(current.name, current.resourceVersion)) {
            onClose(true);
            return;
          }
          try {
            setCurrent((await service.getSubscriptionInfo(subscription.name)).subscription);
          } catch (err) {
            setReloadError(err instanceof Error ? err : new Error(String(err)));
          }
        } finally {
          setBusy(false);
        }
      }}
      submitButtonLabel="Delete"
      deleteName={name}
      error={error}
      reloadError={reloadError}
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
