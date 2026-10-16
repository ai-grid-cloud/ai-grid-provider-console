// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/const.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/const.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
export enum SubscriptionsFilterOptions {
  keyword = 'keyword',
}

export type SubscriptionsFilterDataType = Record<SubscriptionsFilterOptions, string | undefined>;

export const initialSubscriptionsFilterData: SubscriptionsFilterDataType = {
  [SubscriptionsFilterOptions.keyword]: '',
};
