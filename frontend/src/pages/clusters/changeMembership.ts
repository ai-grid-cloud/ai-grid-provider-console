import type { GridMembership } from '../../api/clusters';
import { ServiceError } from '../../api/ConsoleService';
import { ClusterChangedError } from './ClusterChangedError';
import type { ClusterView } from './clusterView';
import type { MembershipChange } from './MembershipModal';
import type { MembershipWrites } from './useClusters';

type Options = {
  /** Loads the cluster as the backend has it now; undefined when it can't. */
  reload: (name: string) => Promise<ClusterView | undefined>;
  /**
   * After a conflict, with the cluster as loaded again (undefined when it couldn't be): the page
   * gives the open dialog that version, so the next try sends what the backend has now.
   */
  onConflict: (current: ClusterView | undefined) => void;
};

/**
 * Adds the cluster to AI Grid (with a membership) or removes it, for the Clusters list and the
 * cluster's page alike. When the cluster changed since the dialog opened (Aborted, a 409), the
 * update carried old labels and an old version: it loads the cluster again, hands it to onConflict and throws
 * ClusterChangedError, and the dialog decides whether the user's location and role still stand.
 * Returns the cluster as the backend answered; throws for the dialog to show.
 */
export const changeMembership = async (
  service: Pick<MembershipWrites, 'enrollCluster' | 'removeClusterFromGrid'>,
  { cluster, join }: MembershipChange,
  membership: GridMembership | undefined,
  { reload, onConflict }: Options,
): Promise<ClusterView> => {
  let updated: ClusterView;
  try {
    updated = membership
      ? await service.enrollCluster(cluster, membership)
      : await service.removeClusterFromGrid(cluster);
  } catch (err) {
    if (err instanceof ServiceError && err.isConflict) {
      const current = await reload(cluster.name).catch(() => undefined);
      onConflict(current);
      throw new ClusterChangedError(current);
    }
    throw err;
  }
  if (updated.aiGridEnabled !== join) {
    throw new Error('The hub did not confirm the change. Refresh the page and try again.');
  }
  return updated;
};
