import type { GridMembership } from '../../api/clusters';
import { ServiceError } from '../../api/ConsoleService';
import type { WriteTarget } from '../../notifications/writeText';
import { ClusterChangedError } from './ClusterChangedError';
import type { ClusterView } from './clusterView';
import { canSetRole } from './gridSettings';
import type { MembershipChange } from './MembershipModal';
import { roleOf } from './roles';
import type { MembershipWrites } from './useClusters';

/**
 * Add to AI grid (with the membership the dialog set) or Remove, as the notification center
 * follows it (followWrite): an add until the cluster is provisioned, a remove until it has left.
 */
export const membershipTarget = (name: string, membership: GridMembership | undefined): WriteTarget =>
  membership
    ? { subject: 'cluster', op: 'add', id: name, name, role: membership.role }
    : { subject: 'cluster', op: 'remove', id: name, name };

/**
 * An Edit as the notification center follows it: with the role it set on a cluster that had none
 * (labelsUpdate), followed until the cluster is provisioned; without one, it changed only the
 * location label, and nothing is followed.
 */
export const editTarget = (cluster: ClusterView, labels: Record<string, string>): WriteTarget => {
  const role = canSetRole(cluster) ? roleOf(labels)?.value : undefined;
  return { subject: 'cluster', op: 'update', id: cluster.name, name: cluster.name, ...(role ? { role } : {}) };
};

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
 * Runs a write of the cluster. When the cluster changed since the dialog opened (Aborted, a 409),
 * the update carried old labels and an old version: it loads the cluster again, hands it to
 * onConflict and throws ClusterChangedError, and the dialog decides whether the user's values still
 * stand. Any other failure is thrown as it is. Only Aborted means a stale version here:
 * FailedPrecondition (412, which ServiceError.isConflict also counts for the JSON API's If-Match) is
 * the backend refusing the change itself, such as a role change that would leave AI grid without an
 * ingress cluster, and reloading would not help; the dialog shows its message.
 */
const withConflictReload = async (
  cluster: ClusterView,
  write: () => Promise<ClusterView>,
  { reload, onConflict }: Options,
): Promise<ClusterView> => {
  try {
    return await write();
  } catch (err) {
    if (err instanceof ServiceError && err.status === 409) {
      const current = await reload(cluster.name).catch(() => undefined);
      onConflict(current);
      throw new ClusterChangedError(current);
    }
    throw err;
  }
};

/**
 * Adds the cluster to AI grid (with a membership) or removes it, for the Clusters list and the
 * cluster's page alike, reloading it after a conflict (withConflictReload). Returns the cluster as
 * the backend answered; throws for the dialog to show.
 */
export const changeMembership = async (
  service: Pick<MembershipWrites, 'enrollCluster' | 'removeClusterFromGrid'>,
  { cluster, join }: MembershipChange,
  membership: GridMembership | undefined,
  options: Options,
): Promise<ClusterView> => {
  const updated = await withConflictReload(
    cluster,
    () => (membership ? service.enrollCluster(cluster, membership) : service.removeClusterFromGrid(cluster)),
    options,
  );
  if (updated.aiGridEnabled !== join) {
    throw new Error('The hub did not confirm the change. Refresh the page and try again.');
  }
  return updated;
};

/**
 * Writes an AI grid cluster's edited labels, for the Clusters list and the cluster's page
 * alike, reloading it after a conflict (withConflictReload). Returns the cluster as the backend
 * answered; throws for the dialog to show, the backend's refusals included.
 */
export const editCluster = (
  service: Pick<MembershipWrites, 'updateLabels'>,
  cluster: ClusterView,
  labels: Record<string, string>,
  options: Options,
): Promise<ClusterView> => withConflictReload(cluster, () => service.updateLabels(cluster, labels), options);
