// Every text of Edit, in one place so the wording can be reviewed together (frontend/AGENTS.md,
// "Wording"): the action, the dialog, and what setting a role does to the cluster.
//
// Edit changes an AI Grid cluster's location label, and its role only while it has none. What a
// role installs is what the hub's GitOps delivers for it (ai-grid-cloud/ai-grid-cluster-gitops, one
// OpenShift AI application per cluster from its role), as checked on a live hub: ingress gets MaaS,
// the consumer gateway, the MaaS portal and the MaaS database replica; inference gets KServe, the
// provider gateway and the GPU operators; combined both. From no role, the hub's ready policy has
// no entry for the cluster until it is compliant, which the backend reports as Provisioning.
// Changing a role a cluster already has isn't offered: the hub doesn't fully remove what the old
// role installed (leaving inference uninstalls the GPU operators; leaving ingress leaves objects
// behind, its database credentials among them), and adding ingress needs per-cluster config in Git.
import type { ClusterRole } from '../../api/clusters';
import { clusterRoles } from './roles';

/** What each role installs, as an admin knows the parts. */
const installs: Record<ClusterRole, string> = {
  ingress: 'MaaS, the consumer gateway, the MaaS portal, and the database replica',
  inference: 'KServe model serving, the provider gateway, and the GPU operators',
  combined:
    'MaaS, the consumer gateway, the MaaS portal, the database replica, KServe model serving, the provider gateway, and the GPU operators',
};

const roleLabel = (role: ClusterRole) => clusterRoles.find((r) => r.value === role)?.label ?? role;

/**
 * What setting a role on a cluster without one will do, as the dialog shows it before Save: so
 * worded as what follows Save, not as done.
 */
export type RoleSet = { title: string; installs: string; settling: string };

/** Setting a role on a cluster that has none: it only installs, so it asks for no typed name. */
export const roleSet = (role: ClusterRole): RoleSet => ({
  title: 'What the hub installs',
  installs: `Saving sets the role to ${roleLabel(role)}. The hub then installs ${installs[role]} on this cluster.`,
  settling: 'The cluster shows Provisioning until the installation finishes.',
});

/** The dialog's other texts. */
export const editText = {
  /** The row and page action, for AI Grid clusters only. */
  action: 'Edit',
  title: 'Edit AI Grid cluster',
  errorTitle: 'Unable to update cluster',
  notAvailable: 'Editing a cluster is not available on this AI Grid backend.',
  changedByOther:
    "Another user changed this cluster's location label or role after this dialog opened. Their values are now shown. Review them and try again.",
  /** The No role warning's tooltip, which points to the action. */
  noRole:
    "This cluster has no role, so the hub cannot install OpenShift AI or MaaS on it, and provisioning cannot finish. To set a role, select Edit in the cluster's actions.",
} as const;
