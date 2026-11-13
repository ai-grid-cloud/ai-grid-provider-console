// Every word the notification center says about a write, in one place for review. The backend
// commits Models and Subscriptions to a Git repository, and Argo CD applies them to the clusters
// later, so the words name each stage as it is: a write is "saved to Git" (or "deleted from Git"), a
// model is "ready" only once it runs on every cluster it is placed on (each cluster's deployment;
// users reach it through MaaS once a subscription covers it too), "running but isn't available to
// users" when it runs but MaaS failed to publish it, and a subscription is "active" only once it and
// its authorization policy are active on every ingress cluster. A cluster's labels are written at
// once, and the hub then installs what its role needs, or lets it go: a cluster is "provisioned"
// once the hub's ready check passes, which never covers MaaS. An organization's save is complete
// when the backend answers.
// They follow frontend/AGENTS.md, "Wording": "Unable to <verb> <object>" for errors, no end
// punctuation in titles.
import { clusterRoles } from '../pages/clusters/roles';
import { modelPath } from '../pages/models/modelUtils';
import {
  getSectionUrl,
  getSubscriptionCreateUrl,
  getSubscriptionEditUrl,
  getSubscriptionViewUrl,
} from '../utilities/maasGovernanceNavigation';
import type { ClusterRole } from '../api/clusters';
import type { NotificationLink } from './useNotifications';
import type { WriteFields } from './writeFields';

export type WriteSubject = 'model' | 'subscription' | 'cluster';
/** `add` and `remove` put a cluster into AI grid and take it out; the others are Git writes. */
export type WriteOp = 'create' | 'update' | 'delete' | 'add' | 'remove';

/** A write the notification center follows: what it changes and the name the pages show. */
export type WriteTarget = {
  subject: WriteSubject;
  op: WriteOp;
  id: string;
  /** The display name, else the id. */
  name: string;
  /** For an update: the version the write was sent at, which a landed update moves on from. */
  version?: number;
  /** What the write sent (writeFields.ts), which a read-back must find to confirm it. */
  expected?: WriteFields;
  /** For a model: the clusters the write deploys it to, or removes it from. */
  clusters?: string[];
  /** For a created subscription: its organization's name, when the form had it. */
  organization?: string;
  /**
   * For a cluster added to AI grid, or edited to set the role it lacked: that role, whose
   * installation the notification center then follows. A cluster edit without one changed only
   * the location label.
   */
  role?: ClusterRole;
};

const clusterPath = (name: string) => `/clusters/${encodeURIComponent(name)}`;

const subjects: Record<
  WriteSubject,
  {
    object: string;
    Object: string;
    list: string;
    listPath: string;
    view: (id: string) => string;
    edit: (id: string) => string;
    createPath: string;
    createAction: string;
  }
> = {
  model: {
    object: 'model',
    Object: 'Model',
    list: 'Models',
    listPath: '/models',
    view: (id) => modelPath({ id }),
    edit: (id) => `${modelPath({ id })}/edit`,
    createPath: '/models/deploy',
    createAction: 'Deploy model',
  },
  subscription: {
    object: 'subscription',
    Object: 'Subscription',
    list: 'Subscriptions',
    listPath: getSectionUrl('subscriptions'),
    view: getSubscriptionViewUrl,
    edit: getSubscriptionEditUrl,
    createPath: getSubscriptionCreateUrl(),
    createAction: 'Create subscription',
  },
  // A cluster is edited in a dialog on its page, and added to AI grid from the Clusters list.
  cluster: {
    object: 'cluster',
    Object: 'Cluster',
    list: 'Clusters',
    listPath: '/clusters',
    view: clusterPath,
    edit: clusterPath,
    createPath: '/clusters',
    createAction: 'Go to Clusters',
  },
};

type Text = { title: string; message?: string; actions?: NotificationLink[] };

const viewAction = (t: WriteTarget): NotificationLink => {
  const s = subjects[t.subject];
  return { title: `View ${s.object}`, to: s.view(t.id) };
};

const listAction = (t: WriteTarget): NotificationLink => {
  const s = subjects[t.subject];
  return { title: `Go to ${s.list}`, to: s.listPath };
};

/** "a", "a and b", "a, b, and c" (the Oxford comma, frontend/AGENTS.md wording rule 18). */
export const listOf = (items: string[]) =>
  items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;

/** The model's clusters in words, or "its clusters" when the write doesn't name them. */
const clustersOf = (t: WriteTarget) => (t.clusters?.length ? listOf(t.clusters) : 'its clusters');

/** What the write does, as a title: "model Granite", "changes to model Granite". */
const thing = (t: WriteTarget) =>
  t.op === 'update' ? `changes to ${subjects[t.subject].object} ${t.name}` : `${subjects[t.subject].object} ${t.name}`;

/** How long a write that outlasts the form is checked for, in the words below. */
export const READBACK_MINUTES = 2;

/**
 * How long a deployed model is watched until it is ready, a created subscription until it is
 * active (and an edited one of either at all), in the words below.
 */
export const READY_MINUTES = 30;

/** The info entry while the write is out: the form left before the backend answered. */
export const pendingText = (t: WriteTarget): Text => {
  const s = subjects[t.subject];
  if (t.op === 'delete') {
    return { title: `Deleting ${s.object} ${t.name}`, message: "You'll be notified when it's deleted from Git." };
  }
  return t.op === 'create'
    ? { title: `Saving ${s.object} ${t.name}`, message: "You'll be notified when it's saved to Git." }
    : { title: `Saving changes to ${s.object} ${t.name}`, message: "You'll be notified when they're saved to Git." };
};

/**
 * The write is in Git: what happens next, which the backend doesn't do itself. Argo CD delivers a
 * model to its clusters, and a subscription to the ingress clusters.
 */
const nextStep = (t: WriteTarget): string => {
  if (t.subject === 'model') {
    if (t.op === 'create') return `It's being deployed to ${clustersOf(t)}. You'll be notified when it's ready.`;
    if (t.op === 'update') return `They're being rolled out to ${clustersOf(t)}.`;
    return `It's being removed from ${clustersOf(t)}.`;
  }
  if (t.op === 'create') return 'It takes effect once the ingress clusters apply it.';
  if (t.op === 'update') return 'They take effect once the ingress clusters apply them.';
  return "It's being removed from the ingress clusters.";
};

/** The write is confirmed: saved to Git (or deleted from it), on the fast path and the read-back alike. */
export const succeededText = (t: WriteTarget): Text => {
  if (t.subject === 'cluster') return clusterSavedText(t);
  const s = subjects[t.subject];
  const title =
    t.op === 'delete'
      ? `${s.Object} ${t.name} deleted from Git`
      : t.op === 'update'
        ? `Changes to ${s.object} ${t.name} saved to Git`
        : `${s.Object} ${t.name} saved to Git`;
  return { title, message: nextStep(t), ...(t.op === 'delete' ? {} : { actions: [viewAction(t)] }) };
};

/** The verb of an error title: "Unable to save model Granite", "Unable to delete model Granite". */
const unable = (t: WriteTarget) => `Unable to ${t.op === 'delete' ? 'delete' : 'save'} ${thing(t)}`;

/** The backend refused the write after the form had left: its message, and the way back to the form. */
export const failedText = (t: WriteTarget, message: string, draftId?: string): Text => {
  const s = subjects[t.subject];
  if (t.op === 'create') {
    // The link reopens the form with what was submitted, when the tab kept it (draftId).
    const to = draftId ? `${s.createPath}?draft=${encodeURIComponent(draftId)}` : s.createPath;
    return { title: unable(t), message, actions: [{ title: s.createAction, to }] };
  }
  if (t.op === 'update') {
    // The edit page opens on the object as it is now: the refused changes are gone, so say so.
    return {
      title: unable(t),
      message: `${message} Your changes weren't saved. Edit the ${s.object} again to make them.`,
      actions: [{ title: `Edit ${s.object}`, to: s.edit(t.id) }],
    };
  }
  return { title: unable(t), message, actions: [viewAction(t)] };
};

/** The backend answered every check, but the write never showed in Git. */
export const notConfirmedText = (t: WriteTarget): Text => {
  const s = subjects[t.subject];
  const after = `${READBACK_MINUTES} minutes after`;
  const message =
    t.op === 'create'
      ? `The ${s.object} wasn't found in Git ${after} it was submitted, and the reason is unknown. If it isn't in the ${s.list} list, ${t.subject === 'model' ? 'deploy' : 'create'} it again.`
      : t.op === 'update'
        ? `The changes weren't found in Git ${after} they were submitted, and the reason is unknown. Open the ${s.object} to check them, and edit it again if needed.`
        : `The ${s.object} is still in Git ${after} it was deleted, and the reason is unknown. If it's still in the ${s.list} list, delete it again.`;
  return { title: unable(t), message, actions: [t.op === 'create' ? listAction(t) : viewAction(t)] };
};

/**
 * A subscription create whose answer never came, and which the read-back didn't confirm: the backend
 * may have added a suffix to the requested name (backend PR 89), which only the lost answer carried,
 * so neither a read of the requested name nor its absence says whether it was created. Creating it
 * again could make a second one, so the list is the place to check first.
 */
export const unknownCreatedNameText = (t: WriteTarget): Text => {
  const s = subjects[t.subject];
  return {
    title: `Unable to confirm ${s.object} ${t.name}`,
    message: `The AI grid backend's answer was lost, and the backend may have added a suffix to the ${s.object}'s name, so it's unknown whether the ${s.object} was saved to Git. Check the ${s.list} list before you create it again.`,
    actions: [listAction(t)],
  };
};

/** The checks themselves failed until the end: nobody can say whether the write landed. */
export const unconfirmedText = (t: WriteTarget): Text => {
  const s = subjects[t.subject];
  const what =
    t.op === 'delete'
      ? `the ${s.object} was deleted from Git`
      : t.op === 'update'
        ? 'the changes were saved to Git'
        : `the ${s.object} was saved to Git`;
  return {
    title: `Unable to confirm ${s.object} ${t.name}`,
    message: `The AI grid backend didn't answer for ${READBACK_MINUTES} minutes, so it's unknown whether ${what}. Check the ${s.list} list.`,
    actions: [listAction(t)],
  };
};

/**
 * The object read back doesn't hold what this write sent: a create whose id holds another object,
 * an update whose version moved on with other content. Someone else's write may have won, so the
 * outcome is unknown: a warning, with the object to check.
 */
export const mismatchText = (t: WriteTarget): Text => {
  const s = subjects[t.subject];
  const message =
    t.op === 'create'
      ? `A ${s.object} with this name is in Git, but it doesn't match what you submitted. Someone else may have created it. Open the ${s.object} to check it.`
      : `The ${s.object} was changed in Git, but not as you submitted. Someone else may have edited it. Open the ${s.object} to check your changes.`;
  return { title: `Unable to confirm ${s.object} ${t.name}`, message, actions: [viewAction(t)] };
};

/** An update whose object was deleted meanwhile. */
export const goneText = (t: WriteTarget): Text => ({
  title: unable(t),
  message: `The ${subjects[t.subject].object} no longer exists.`,
  actions: [listAction(t)],
});

/** A deployed model became ready, on these clusters (none for a model on the hub alone). */
export const modelReadyText = (id: string, name: string, clusters: string[]): Text => ({
  title: clusters.length ? `Model ${name} is ready on ${listOf(clusters)}` : `Model ${name} is ready`,
  actions: [{ title: 'View model', to: modelPath({ id }) }],
});

/**
 * A deployed model isn't running on every cluster it is placed on after READY_MINUTES: the clusters
 * it isn't ready on, from each cluster's status, and the model to check. A warning: it may still
 * come up.
 */
export const modelNotReadyText = (id: string, name: string, clusters: string[]): Text => ({
  title: `Model ${name} isn't ready yet`,
  message: clusters.length
    ? `It isn't ready on ${listOf(clusters)} ${READY_MINUTES} minutes after it was saved to Git. Open the model to check each cluster's status.`
    : `It isn't ready ${READY_MINUTES} minutes after it was saved to Git. Open the model to check its status.`,
  actions: [{ title: 'View model', to: modelPath({ id }) }],
});

/** What a status watch says when its last read failed: nothing about the status it couldn't read. */
const unreadStatus = (object: string) =>
  `The console couldn't read its status ${READY_MINUTES} minutes after it was saved to Git. Open the ${object} to check its status.`;

/**
 * A deployed model's readiness watch reached READY_MINUTES with its last read failed: whether it
 * is ready is unknown, so a warning that says so, not that it isn't ready.
 */
export const modelUnconfirmedText = (id: string, name: string): Text => ({
  title: `Unable to confirm model ${name} is ready`,
  message: unreadStatus('model'),
  actions: [{ title: 'View model', to: modelPath({ id }) }],
});

/** A deployed model failed: why, in the words the model's page uses. */
export const modelFailedText = (id: string, name: string, why: string | undefined): Text => ({
  title: `Unable to deploy model ${name}`,
  message: why ?? 'The model failed to deploy. Open it for details.',
  actions: [{ title: 'View model', to: modelPath({ id }) }],
});

/** A message as the end of a sentence of ours: trimmed, without its own final period. */
const withoutPeriod = (message: string) => message.trim().replace(/\.+$/, '');

/**
 * A deployed model runs on every cluster it is placed on, but MaaS failed to publish it on an
 * ingress cluster, so users can't call it: a warning, not "ready" and not "Unable to deploy". It
 * names the clusters it runs on, and each ingress cluster MaaS failed on with MaaS's (or Argo CD's)
 * message, for example "It runs on site-b. MaaS couldn't publish it on site-a: <message>. Open the
 * model to check its status."
 */
export const modelUnavailableText = (
  id: string,
  name: string,
  runsOn: string[],
  failedOn: { cluster: string; message?: string }[],
): Text => {
  const where = failedOn.map((f) => (f.message ? `on ${f.cluster}: ${withoutPeriod(f.message)}` : `on ${f.cluster}`));
  const runs = runsOn.length ? `It runs on ${listOf(runsOn)}. ` : '';
  const maas = where.length ? `MaaS couldn't publish it ${where.join('; ')}.` : "MaaS couldn't publish it.";
  return {
    title: `Model ${name} is running but isn't available to users`,
    message: `${runs}${maas} Open the model to check its status.`,
    actions: [{ title: 'View model', to: modelPath({ id }) }],
  };
};

/** An edited model failed while its changes rolled out: why, in the words the model's page uses. */
export const modelChangesFailedText = (id: string, name: string, why: string | undefined): Text => ({
  title: `Unable to roll out changes to model ${name}`,
  message: why ?? 'The model failed after the changes were saved to Git. Open it for details.',
  actions: [{ title: 'View model', to: modelPath({ id }) }],
});

/**
 * Who a subscription serves: the users in its groups (the glossary's words), in its organization
 * when the form knew the organization's name. The name is never first, so it keeps its own case.
 */
const usersOf = (t: WriteTarget) =>
  t.organization ? `users in its groups in the ${t.organization} organization` : 'users in its groups';

/**
 * A created subscription is active, and so is its authorization policy, on every ingress cluster:
 * its users can call its models. MaaS needs both, the policy for access and the subscription for
 * the quota.
 */
export const subscriptionActiveText = (t: WriteTarget): Text => {
  const users = usersOf(t);
  return {
    title: `Subscription ${t.name} is active`,
    message: `${users.charAt(0).toUpperCase()}${users.slice(1)} can use its models.`,
    actions: [viewAction(t)],
  };
};

/**
 * A created subscription, or its authorization policy, isn't active on every ingress cluster after
 * READY_MINUTES: what that means for its users, and where to look. A warning: it may still turn
 * active. A subscription turns active once every model it names is registered on the cluster, so
 * its models' status on its page is the first place to look.
 */
export const subscriptionNotActiveText = (t: WriteTarget, inactive: 'subscription' | 'policy'): Text => {
  const after = `${READY_MINUTES} minutes after it was saved to Git, so ${usersOf(t)} might not be able to use its models`;
  return {
    title: `Subscription ${t.name} isn't active yet`,
    message:
      inactive === 'policy'
        ? `Its authorization policy isn't active on every ingress cluster ${after}. Open the subscription to check the policy's status.`
        : `It isn't active on every ingress cluster ${after}. Open the subscription to check its status and its models' status.`,
    actions: [viewAction(t)],
  };
};

/**
 * A created subscription's watch reached READY_MINUTES with an ingress cluster reporting the
 * subscription, or its authorization policy, failed (Degraded): a reported failure, so not "yet",
 * with the backend's message when the status carries one. A warning, not an error: Degraded is also
 * how a subscription reads while a model it names isn't published yet.
 */
export const subscriptionFailedText = (
  t: WriteTarget,
  failed: 'subscription' | 'policy',
  message: string | undefined,
): Text => {
  const what = failed === 'policy' ? 'its authorization policy' : 'it';
  const reported = message
    ? `An ingress cluster reports ${what} failed: ${withoutPeriod(message)}.`
    : `An ingress cluster reports ${what} failed.`;
  const check =
    failed === 'policy'
      ? "Open the subscription to check the policy's status."
      : "Open the subscription to check its status and its models' status.";
  return { title: `Subscription ${t.name} isn't active`, message: `${reported} ${check}`, actions: [viewAction(t)] };
};

/**
 * A created subscription's watch reached READY_MINUTES without a status to judge by: its last read
 * failed, or found no status (the backend's read of the clusters' reports failed). Whether it is
 * active is unknown, so a warning that says so, not that it isn't active.
 */
export const subscriptionUnconfirmedText = (t: WriteTarget): Text => ({
  title: `Unable to confirm subscription ${t.name} is active`,
  message: unreadStatus('subscription'),
  actions: [viewAction(t)],
});

/**
 * How long a cluster is watched after it is added to AI grid or given a role, until it is
 * provisioned, and after it is removed, until it has left: an OpenShift AI installation takes a
 * while.
 */
export const CLUSTER_MINUTES = 60;

const viewCluster = (t: WriteTarget): NotificationLink => ({ title: 'View cluster', to: clusterPath(t.id) });

const roleLabel = (role: ClusterRole) => clusterRoles.find((r) => r.value === role)?.label ?? role;

/**
 * A cluster's write, answered by the backend: added to AI grid, removed from it, or edited (the
 * role it lacked set, or only its location label changed). What the hub then does is followed
 * after an add, a role set and a remove (clusterProvisionedText, clusterLeftText); a location label
 * changes nothing on the cluster.
 */
export const clusterSavedText = (t: WriteTarget): Text => {
  if (t.op === 'remove') {
    return {
      title: `Cluster ${t.name} removed from AI grid`,
      message: "You'll be notified when the hub no longer includes it in the AI grid.",
      actions: [viewCluster(t)],
    };
  }
  const message = t.role
    ? `The hub is installing what its ${roleLabel(t.role)} role needs. You'll be notified when it's provisioned.`
    : undefined;
  return {
    title: t.op === 'add' ? `Cluster ${t.name} added to AI grid` : `Changes to cluster ${t.name} saved`,
    ...(message ? { message } : {}),
    actions: [viewCluster(t)],
  };
};

/** When the watch of a cluster began, in words: "it was added to AI grid". */
const clusterSince = (t: WriteTarget) =>
  t.op === 'remove'
    ? 'it was removed from the AI grid'
    : t.op === 'add'
      ? 'it was added to the AI grid'
      : 'its role was set';

const OUTSIDE_THE_CHECK =
  "Whether users can reach models through it depends on MaaS, which the hub's check doesn't cover.";

/**
 * A cluster the hub reports provisioned: its ready check passed, which confirms OpenShift AI on the
 * cluster and never MaaS. So an Inference or Combined cluster can serve models (the deploy wizard
 * offers a provisioned one), and for an Ingress or Combined one the words don't claim that users
 * can reach models through it.
 */
export const clusterProvisionedText = (t: WriteTarget): Text => {
  const ready = 'The hub reports OpenShift AI ready on it';
  const message =
    t.role === 'inference'
      ? `${ready}. You can select it when you deploy a model.`
      : t.role === 'combined'
        ? `${ready}, and you can select it when you deploy a model. ${OUTSIDE_THE_CHECK}`
        : t.role === 'ingress'
          ? `${ready}. ${OUTSIDE_THE_CHECK}`
          : `${ready}.`;
  return { title: `Cluster ${t.name} is provisioned`, message, actions: [viewCluster(t)] };
};

/** A cluster still not provisioned after CLUSTER_MINUTES: a warning, as it may still finish. */
export const clusterNotProvisionedText = (t: WriteTarget): Text => ({
  title: `Cluster ${t.name} isn't provisioned yet`,
  message: `It isn't provisioned ${CLUSTER_MINUTES} minutes after ${clusterSince(t)}. Open the cluster to check its status.`,
  actions: [viewCluster(t)],
});

/** What a cluster's watch says when its last read failed: nothing about the status it couldn't read. */
const clusterUnreadStatus = (t: WriteTarget) =>
  `The console couldn't read its status ${CLUSTER_MINUTES} minutes after ${clusterSince(t)}. Open the cluster to check its status.`;

/** A cluster's provisioning watch reached CLUSTER_MINUTES with its last read failed. */
export const clusterProvisionedUnconfirmedText = (t: WriteTarget): Text => ({
  title: `Unable to confirm cluster ${t.name} is provisioned`,
  message: clusterUnreadStatus(t),
  actions: [viewCluster(t)],
});

/** A removed cluster that the hub no longer includes in AI grid. */
export const clusterLeftText = (t: WriteTarget): Text => ({
  title: `Cluster ${t.name} left AI grid`,
  actions: [viewCluster(t)],
});

/** A removed cluster that the hub still includes after CLUSTER_MINUTES: a warning. */
export const clusterNotLeftText = (t: WriteTarget): Text => ({
  title: `Cluster ${t.name} hasn't left AI grid yet`,
  message: `The hub still includes it in the AI grid ${CLUSTER_MINUTES} minutes after it was removed. Open the cluster to check its status.`,
  actions: [viewCluster(t)],
});

/** A removed cluster's watch reached CLUSTER_MINUTES with its last read failed. */
export const clusterLeftUnconfirmedText = (t: WriteTarget): Text => ({
  title: `Unable to confirm cluster ${t.name} left AI grid`,
  message: clusterUnreadStatus(t),
  actions: [viewCluster(t)],
});

/**
 * An organization saved or deleted. The backend writes it to Keycloak and answers once the write
 * is complete (or rolled back), so there is nothing to follow, and a refusal stays on the form or
 * in the dialog. `name` is the one the backend answered with; for a delete, the dialog's.
 */
export const organizationSavedText = (
  op: 'create' | 'update' | 'delete',
  { id, name }: { id: string; name: string },
): Text => {
  if (op === 'delete') return { title: `Organization ${name} deleted` };
  return {
    title: op === 'create' ? `Organization ${name} created` : `Changes to organization ${name} saved`,
    actions: [{ title: 'View organization', to: `/organizations/${encodeURIComponent(id)}` }],
  };
};
