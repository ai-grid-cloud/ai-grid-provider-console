/** What a spoke runs, as the hub's Placements read it from the `ai-grid/role` label. */
export type ClusterRole = 'combined' | 'ingress' | 'inference';

/** What Add to AI grid writes besides `ai-grid/enabled`; the hub provisions nothing without a role. */
export type GridMembership = { location: string; role: ClusterRole };
