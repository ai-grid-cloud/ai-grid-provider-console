// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/columns.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/columns.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization column, sorted by the name it shows. Groups and Models show
// counts that expand the row (SubscriptionTableRow), sorted by count.
import type { ThProps } from '@patternfly/react-table';
import type { MaaSSubscription } from '../../../api/types';
import { normalizePhase } from '../../../utilities/phaseLabelUtils';

export type SubscriptionColumn = {
  label: string;
  width?: ThProps['width'];
  /** A number column: right-aligned with tabular digits, as every number column is. */
  isNumeric?: boolean;
  sortable: (a: MaaSSubscription, b: MaaSSubscription) => number;
};

/** The list's columns; organizationName shows a subscription's organization. */
export const subscriptionsColumns = (organizationName: (s: MaaSSubscription) => string): SubscriptionColumn[] => [
  {
    label: 'Subscription',
    sortable: (a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
  },
  {
    label: 'Organization',
    width: 15,
    sortable: (a, b) => organizationName(a).localeCompare(organizationName(b)),
  },
  {
    label: 'Status',
    width: 15,
    sortable: (a, b) => normalizePhase(a.phase).localeCompare(normalizePhase(b.phase)),
  },
  {
    label: 'Groups',
    width: 10,
    sortable: (a, b) => a.owner.groups.length - b.owner.groups.length,
  },
  {
    label: 'Models',
    width: 10,
    sortable: (a, b) => a.modelRefs.length - b.modelRefs.length,
  },
  {
    label: 'Priority',
    width: 10,
    isNumeric: true,
    sortable: (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
  },
];
