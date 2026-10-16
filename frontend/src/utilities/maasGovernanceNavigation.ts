// Ported from krisv/ai-grid-cloud-provider-poc src/app/utilities/maasGovernanceNavigation.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/utilities/maasGovernanceNavigation.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The authorization policy URLs are not ported: the PoC has no routes for them.

export type GovernanceSection = 'subscriptions';

export const getSectionUrl = (section: GovernanceSection): string => `/${section}`;

export const getSubscriptionViewUrl = (name: string): string =>
  `${getSectionUrl('subscriptions')}/view/${encodeURIComponent(name)}`;

export const getSubscriptionEditUrl = (name: string): string =>
  `${getSectionUrl('subscriptions')}/edit/${encodeURIComponent(name)}`;

export const getSubscriptionCreateUrl = (): string => `${getSectionUrl('subscriptions')}/create`;

/** A same-origin path from router state's returnTo, or undefined. */
export const getReturnToFromState = (state: unknown): string | undefined => {
  if (state == null || typeof state !== 'object' || !('returnTo' in state)) {
    return undefined;
  }
  const { returnTo } = state as { returnTo: unknown };
  if (typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    return returnTo;
  }
  return undefined;
};

export const getBackUrl = (state: unknown, section: GovernanceSection): string =>
  getReturnToFromState(state) ?? getSectionUrl(section);
