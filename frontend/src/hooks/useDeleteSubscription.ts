// Ported from krisv/ai-grid-cloud-provider-poc src/app/hooks/useDeleteSubscription.ts at 62319b8.
import { useCallback, useState } from 'react';
import { ServiceError } from '../api/ConsoleService';
import type { SubscriptionsService } from '../api/subscriptions';

export const useDeleteSubscription = (service: SubscriptionsService) => {
  const [isDeleting, setDeleting] = useState(false);
  const [error, setError] = useState<Error>();
  const deleteSubscriptionCallback = useCallback(
    async (name: string, resourceVersion: string) => {
      setDeleting(true);
      setError(undefined);
      try {
        await service.deleteSubscription(name, resourceVersion);
        return true;
      } catch (err) {
        setError(
          err instanceof ServiceError && err.isNotImplemented
            ? new Error('Deleting subscriptions is not available on this backend yet.')
            : err instanceof ServiceError && err.status === 409
              ? new Error('This subscription changed since you opened this dialog. Check it and try again.')
              : err instanceof Error
                ? err
                : new Error('Unable to delete subscription.'),
        );
        return false;
      } finally {
        setDeleting(false);
      }
    },
    [service],
  );
  return { isDeleting, error, deleteSubscriptionCallback };
};
