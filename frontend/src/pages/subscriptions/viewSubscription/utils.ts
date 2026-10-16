// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/viewSubscription/utils.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/viewSubscription/utils.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import type { ModelSubscriptionRef } from '../../../api/types';
import { isSameModel } from '../../../utilities/authpolicies';
import { formatTokenRateLimitLine } from '../../../utilities/rateLimits';

/** One line per token limit of the model, matched by namespace and name. */
export const formatTokenLimits = (
  modelRefs: ModelSubscriptionRef[],
  model: { name: string; namespace?: string },
): string[] => {
  const ref = modelRefs.find((r) => isSameModel(r, model));
  const limits = ref && Array.isArray(ref.tokenRateLimits) ? ref.tokenRateLimits : [];
  return limits.map(({ limit, window }) => formatTokenRateLimitLine(limit, window));
};
