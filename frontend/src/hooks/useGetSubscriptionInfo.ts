// Ported from krisv/ai-grid-cloud-provider-poc src/app/hooks/useGetSubscriptionInfo.ts at 62319b8.
import type { SubscriptionsService } from '../api/subscriptions';
import type { SubscriptionInfoResponse } from '../api/types';
import { useServiceData } from './useServiceData';

/** Loads a subscription with its models and policies once, without polling. */
export const useGetSubscriptionInfo = (service: SubscriptionsService, name: string) =>
  useServiceData<SubscriptionInfoResponse | null>(() => service.getSubscriptionInfo(name), null, 0);
