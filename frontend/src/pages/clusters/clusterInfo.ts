import type { ClusterView } from './clusterView';
import type { MembershipChange } from './MembershipModal';

/** The cluster status dialog: the ACM state behind Unknown, then the backend's message. */
export const statusReason = (c: ClusterView) => [c.state, c.statusMessage].filter(Boolean).join(': ') || undefined;

/** Why a cluster can't be added: the hub hasn't accepted it, hasn't finished importing it, or is detaching it. */
export const cannotAddReason = (c: ClusterView) => {
  if (c.state === 'Not accepted') {
    return "The hub hasn't accepted this cluster yet. Accept it in ACM, then add it to AI Grid.";
  }
  return c.state ? `The hub can add this cluster to AI Grid once it has imported it (now: ${c.state}).` : undefined;
};

/**
 * The cluster's NVIDIA GPUs as the hub reports its capacity (`gpuCapacity`, clusterView.ts): 0 when
 * it reports capacity without GPUs (no GPU nodes, or no GPU operator yet), undefined when it
 * reports no capacity at all or a negative count.
 */
export const gpuCount = (c: ClusterView): number | undefined => c.gpuCapacity;

/** The one membership action a provider admin has on a cluster: Remove for a member, else Add. */
export const membershipAction = (c: ClusterView, onChange: (change: MembershipChange) => void) =>
  c.aiGridEnabled
    ? {
        key: 'remove',
        label: 'Remove from AI Grid',
        isDanger: true,
        onClick: () => onChange({ cluster: c, join: false }),
      }
    : {
        key: 'add',
        label: 'Add to AI Grid',
        disabledReason: cannotAddReason(c),
        onClick: () => onChange({ cluster: c, join: true }),
      };
