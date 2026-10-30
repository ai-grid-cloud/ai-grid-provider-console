/** What a spoke runs, as the hub's Placements read it from the `ai-grid/role` label. */
export type ClusterRole = 'combined' | 'ingress' | 'inference';

/**
 * What Add to AI Grid writes besides `ai-grid/enabled`: the role (the hub provisions nothing
 * without one) and the location label, empty for none.
 */
export type GridMembership = { location: string; role: ClusterRole };
