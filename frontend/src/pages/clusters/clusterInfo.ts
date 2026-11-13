import type { ClusterView } from './clusterView';
import { editText } from './editClusterText';
import type { MembershipChange } from './MembershipModal';

/**
 * What Unavailable means, in the console's words: the hub's own message for the state varies, so
 * the Clusters list's status popover shows this alert instead.
 */
export const unavailableAlert = {
  title: 'Cannot reach API server',
  body: 'Telemetry and console updates are unavailable, and the system is unable to confirm whether the cluster is running.',
} as const;

/** The same in one sentence, which the cluster page's status tooltip leads with. */
export const unavailableText = `The cluster's API server cannot be reached. ${unavailableAlert.body}`;

/** The hub's side of the status: the ACM state behind Unknown, then the backend's message. */
export const hubMessage = (c: ClusterView) =>
  [c.state, c.statusMessage?.trim()].filter(Boolean).join(': ') || undefined;

/** Why a cluster can't be added: the hub hasn't accepted it, hasn't finished importing it, or is detaching it. */
export const cannotAddReason = (c: ClusterView) => {
  if (c.state === 'Not accepted') {
    return 'The hub has not accepted this cluster. To add it to the AI grid, first accept it in ACM.';
  }
  return c.state
    ? `This cluster can be added to the AI grid after the hub imports it. Current state: ${c.state}.`
    : undefined;
};

/**
 * The cluster's NVIDIA GPUs as the hub reports its capacity (`gpuCapacity`, clusterView.ts): 0 when
 * it reports capacity without GPUs (no GPU nodes, or no GPU operator yet), undefined when it
 * reports no capacity at all or a negative count.
 */
export const gpuCount = (c: ClusterView): number | undefined => c.gpuCapacity;

/**
 * Remove from AI grid's texts. A cluster that receives requests (Ingress or Combined) holds a copy
 * of every subscription. Deleting a copy runs MaaS's `maas.opendatahub.io/subscription-cleanup`
 * finalizer, which revokes the subscription's API keys in the database every ingress cluster
 * shares, so on every cluster. The backend therefore refuses the removal, with a message that says
 * why, while the cluster is the only ingress cluster of the other members, and while removing it
 * would make Argo CD delete a copy: today while any subscription exists, and once the catalog marks
 * subscriptions as kept on removal (Argo CD `Delete=false`, label `ai-grid/kept-on-removal`), while
 * a copy on it isn't kept (the backend's `docs/UI_API_REFERENCE.md`, "Roles"). A removal it allows
 * deletes the cluster's MaaS authorization policies, so its users' requests go through the other
 * ingress clusters, where their keys keep working. A kept copy keeps the finalizer: deleting it,
 * uninstalling MaaS or deleting its namespace on the removed cluster still revokes the keys
 * everywhere. The warning gives no cleanup procedure, because no safe one is known: maas-controller
 * puts the finalizer back whenever it reconciles a subscription that isn't being deleted, and taking
 * it off triggers such a reconcile, so a delete after it can find the finalizer back.
 */
export const removeText = {
  action: 'Remove from AI grid',
  /** The warning of the Remove dialog of an Ingress or Combined cluster: what happens to users. */
  warningTitle: 'Requests move to the other ingress clusters',
  warningBody:
    "This cluster receives requests from organizations' users. After it is removed, their requests go through the other ingress clusters, and their API keys keep working. The AI grid refuses the removal and shows the reason while this is the only ingress cluster, or while removing it would delete a subscription's copy and revoke its API keys.",
  /** The warning's second paragraph: what not to do on the removed cluster while it keeps copies. */
  warningDetail:
    "If this cluster keeps copies of subscriptions after removal, don't delete them, uninstall MaaS, or delete their namespace on this cluster. MaaS would revoke their API keys on every cluster.",
} as const;

/** Add to AI grid's label, on the details page's menu and as the list's add-button tooltip. */
export const addText = {
  action: 'Add to AI grid',
} as const;

/**
 * The AI grid actions a provider admin has on a cluster: for a member, Edit, then Remove
 * (destructive, last, after a divider); otherwise Add. The list shows Add as an icon button
 * instead of this menu.
 */
export const membershipActions = (
  c: ClusterView,
  onChange: (change: MembershipChange) => void,
  onEdit: (cluster: ClusterView) => void,
) =>
  c.aiGridEnabled
    ? [
        { key: 'edit', label: editText.action, onClick: () => onEdit(c) },
        { key: 'divider', isSpacer: true },
        {
          key: 'remove',
          label: removeText.action,
          isDanger: true,
          onClick: () => onChange({ cluster: c, join: false }),
        },
      ]
    : [
        {
          key: 'add',
          label: addText.action,
          disabledReason: cannotAddReason(c),
          onClick: () => onChange({ cluster: c, join: true }),
        },
      ];
