// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/const.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/const.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Model and Group filters, as the org admin's view has (UXD's AI grid
// vision doc, RHAI-10554: Model, Group and Subscription as separate filter categories; the
// Subscription filter searches the name, ID or description).
export enum SubscriptionsFilterOptions {
  keyword = 'keyword',
  model = 'model',
  group = 'group',
}

/** Each filter's name in the toolbar's attribute menu and on its label, and its search box's placeholder. */
export const subscriptionsFilterOptions: Record<SubscriptionsFilterOptions, { label: string; placeholder: string }> = {
  [SubscriptionsFilterOptions.keyword]: {
    label: 'Subscription',
    placeholder: 'Filter by name, ID, or description',
  },
  [SubscriptionsFilterOptions.model]: {
    label: 'Model',
    placeholder: 'Filter by model name, ID, or description',
  },
  [SubscriptionsFilterOptions.group]: {
    label: 'Group',
    placeholder: 'Filter by group name',
  },
};

export type SubscriptionsFilterDataType = Record<SubscriptionsFilterOptions, string | undefined>;

export const initialSubscriptionsFilterData: SubscriptionsFilterDataType = {
  [SubscriptionsFilterOptions.keyword]: '',
  [SubscriptionsFilterOptions.model]: '',
  [SubscriptionsFilterOptions.group]: '',
};
