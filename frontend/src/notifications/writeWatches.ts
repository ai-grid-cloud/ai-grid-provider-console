// The checks the notification center runs for a write that outlasted the form: a read-back that
// confirms an unknown outcome; for a model, a watch until it is ready on its clusters (a deploy)
// or while its changes roll out (an edit); for a subscription, a watch until it is active on the
// ingress clusters (a create) or while its changes are applied (an edit); for a cluster, a watch
// until the hub has provisioned it (added to AI grid, or given a role) or let it go (removed).
// Each is one call of a NotificationWatcherCallback; the provider (BackgroundWritesProvider) polls
// it.
import type { ModelView } from '../pages/models/modelView';
import { NotificationResponseStatus, type NotificationWatcherResponse } from './useNotificationWatcher';
import { holdsSent, type WriteFields } from './writeFields';
import {
  CLUSTER_MINUTES,
  READBACK_MINUTES,
  READY_MINUTES,
  clusterLeftText,
  clusterLeftUnconfirmedText,
  clusterNotLeftText,
  clusterNotProvisionedText,
  clusterProvisionedText,
  clusterProvisionedUnconfirmedText,
  goneText,
  mismatchText,
  modelChangesFailedText,
  modelFailedText,
  modelNotReadyText,
  modelReadyText,
  modelUnavailableText,
  modelUnconfirmedText,
  notConfirmedText,
  subscriptionActiveText,
  subscriptionFailedText,
  subscriptionNotActiveText,
  subscriptionUnconfirmedText,
  succeededText,
  unconfirmedText,
  unknownCreatedNameText,
  type WriteSubject,
  type WriteTarget,
} from './writeText';

/** How long a write whose outcome is unknown is read back, from when it was sent. */
export const READBACK_MS = READBACK_MINUTES * 60_000;
export const READBACK_POLL_MS = 10_000;
/**
 * How long a deployed model is watched until it is ready, a created subscription until it is
 * active, and an edited one of either at all, from when the write landed.
 */
export const READY_MS = READY_MINUTES * 60_000;
/**
 * Each Models/Get and Subscriptions/Get reads the Git catalog (seconds on the demo hub), so the
 * status watches poll slowly.
 */
export const READY_POLL_MS = 20_000;
/**
 * How many reads in a row must find a subscription's phase empty, with no status found before,
 * for its watch to stop silently: three, about 40 s at READY_POLL_MS. A failed read between them
 * ends the run, as it says nothing about the reports (nextHistory). An empty phase means the
 * backend has no report from any cluster: no cluster has an Argo CD Application in the catalog's
 * subscriptions ApplicationSet, or the backend may not list the Applications (both logged once),
 * which no write changes; or the backend's read of them failed this once (readReports logs it and
 * reports nothing; maasPhase in the backend's internal/servers/subscriptions_git.go). Once a status
 * has been found, an empty phase is the latter, a status unavailable for now, and the watch goes
 * on to its deadline.
 */
export const NO_STATUS_READS = 3;

/** How long a cluster is watched, from when its write landed (watchCluster). */
export const CLUSTER_MS = CLUSTER_MINUTES * 60_000;
/**
 * A cluster's watch polls as the Clusters pages do. Clusters/Get reads the hub, not Git, and the
 * hub installs a role's components over many minutes, so nothing is gained by polling faster.
 */
export const CLUSTER_POLL_MS = 30_000;

/**
 * A cluster as its watches read it from Clusters/Get: whether it is an AI grid member
 * (`status.ai_grid_member`, the `ai-grid/enabled` label itself) and its `status.provisioning`, the
 * hub's ready Policy's compliance for it: Compliant, NonCompliant, Pending, or empty when the
 * Policy doesn't list the cluster (its placement no longer selects it, or the Policy can't be
 * read).
 */
export type ClusterStatusView = { member: boolean; provisioning: string };

/**
 * A subscription's status as its watches read it from Subscriptions/Get: its phase, and its
 * authorization policies' (the managed `<id>-policy`, the one Get returns in git mode), each with
 * its Ready condition's message when it has one. Each phase is Active, Pending, Degraded, or empty
 * when no cluster reports. In git mode the subscription has no condition, and the policy's says
 * which cluster reports it how ("Failed on site-a; ready on site-b").
 */
export type SubscriptionStatusView = {
  phase: string;
  message?: string;
  policies: { id: string; phase: string; message?: string }[];
};

/**
 * What a status says for the users: `active` when the subscription and its policies are Active;
 * `subscriptionDegraded` when an ingress cluster reports the subscription failed (Degraded), and
 * `policyDegraded` when one reports a policy failed; `policy` when the subscription is Active but a
 * policy isn't, or Get lists none; `subscription` when the subscription isn't. A subscription
 * without a policy gives its users no access to its models, and the backend creates the policy with
 * it, so none listed is a policy not active yet. Degraded isn't an end: it is also how a
 * subscription reads while a model it names isn't published on a cluster yet (watchActive). For a
 * cluster, `provisioned` when the hub's ready Policy reports it Compliant, `provisioning` for any
 * other compliance it reports.
 */
export type Verdict =
  'active' | 'policy' | 'subscription' | 'policyDegraded' | 'subscriptionDegraded' | 'provisioned' | 'provisioning';

const DEGRADED = 'Degraded';

/** A status's verdict, with the backend's message for a Degraded one. */
const verdictOf = (status: SubscriptionStatusView): { verdict: Verdict; message?: string } => {
  if (status.phase === DEGRADED) return { verdict: 'subscriptionDegraded', message: status.message };
  const degraded = status.policies.find((p) => p.phase === DEGRADED);
  if (degraded) return { verdict: 'policyDegraded', message: degraded.message };
  if (status.phase !== 'Active') return { verdict: 'subscription' };
  const { policies } = status;
  return { verdict: policies.length > 0 && policies.every((p) => p.phase === 'Active') ? 'active' : 'policy' };
};

/**
 * What a subscription or cluster watch learned from its reads so far, kept in its record so a
 * reload goes on from it: how many reads in a row found no status (`empties`), and the verdict of
 * the last read that found one (`last`, none while no read has), with the backend's message when
 * that verdict is a Degraded one (`message`).
 */
export type StatusHistory = { empties: number; last?: Verdict; message?: string };

export const NO_HISTORY: StatusHistory = { empties: 0 };

/**
 * The history after one more read: `answer` is what it found (undefined when no object), or
 * `'failed'` when the read itself failed. A failed read isn't an empty one: it ends a run of empty
 * reads, so only NO_STATUS_READS empty reads with nothing between them stop a watch. A read that
 * found no object leaves the history as it was (the watch stops on it). A status is a
 * subscription's phase, or a cluster's provisioning.
 */
export const nextHistory = (history: StatusHistory, answer: ReadAnswer | undefined | 'failed'): StatusHistory => {
  if (answer === 'failed') return { ...history, empties: 0 };
  const status = answer?.subscription;
  if (status) {
    if (status.phase === '') return { ...history, empties: history.empties + 1 };
    const { verdict, message } = verdictOf(status);
    return { empties: 0, last: verdict, ...(message ? { message } : {}) };
  }
  const cluster = answer?.cluster;
  if (cluster) {
    if (cluster.provisioning === '') return { ...history, empties: history.empties + 1 };
    return { empties: 0, last: cluster.provisioning === 'Compliant' ? 'provisioned' : 'provisioning' };
  }
  return history;
};

/**
 * The object as the backend has it now: its version, the fields a write compares (writeFields.ts),
 * and the model's view for a model, the status for a subscription or a cluster.
 */
export type ReadAnswer = {
  version: number;
  fields?: WriteFields;
  model?: ModelView;
  subscription?: SubscriptionStatusView;
  cluster?: ClusterStatusView;
};

/** Reads one object: undefined when the backend says it doesn't exist; throws on any other failure. */
export type ReadObject = (subject: WriteSubject, id: string) => Promise<ReadAnswer | undefined>;

/**
 * An object's status as the status watches compare it: a model's phase and reason, and each
 * cluster's with its deployment and whether its sync failed; a subscription's phase and its
 * policies'; a cluster's own membership and provisioning (watchCluster); "gone" when the object is.
 * A change is what has the pages refetch, and what a model edit's watch reports a failure on. A
 * cluster's failed sync is added only when it failed, so a status kept before it counted reads the
 * same.
 */
export const statusOf = (answer: ReadAnswer | undefined) => {
  if (answer?.cluster) {
    return JSON.stringify([answer.cluster.member, answer.cluster.provisioning]);
  }
  if (answer?.model) {
    return JSON.stringify([
      answer.model.phase,
      answer.model.reason,
      answer.model.clusters.map((c) => [
        c.cluster,
        c.phase,
        c.reason,
        c.deployment,
        ...(c.syncFailed ? ['SyncFailed'] : []),
      ]),
    ]);
  }
  if (answer?.subscription) {
    return JSON.stringify([answer.subscription.phase, answer.subscription.policies.map((p) => [p.id, p.phase])]);
  }
  return 'gone';
};

type Text = { title: string; message?: string; actions?: { title: string; to: string }[] };
const repoll = { status: NotificationResponseStatus.REPOLL } as const;
const stop = { status: NotificationResponseStatus.STOP } as const;
const success = (text: Text) => ({ status: NotificationResponseStatus.SUCCESS, ...text }) as const;
const error = (text: Text) => ({ status: NotificationResponseStatus.ERROR, ...text }) as const;
const warning = (text: Text) => ({ status: NotificationResponseStatus.WARNING, ...text }) as const;

/**
 * A subscription create, which the backend may name with a suffix that only its answer carries
 * (backend PR 89): a read of the requested id confirms it only when it finds what was sent there
 * (a backend that keeps the id); anything else, another subscription by that name or none, says
 * nothing about whether this one was created, so it ends as unknown (unknownCreatedNameText),
 * never "not done" or someone else's.
 */
const namesMayChange = (target: WriteTarget) => target.subject === 'subscription' && target.op === 'create';

/**
 * Whether a write whose answer never came landed. A create is confirmed when the object exists and
 * holds what it sent; an update when its version moved on from the one sent and the object holds
 * what it sent; a delete when the object is gone. An object that exists, or moved on, with other
 * content is someone else's write as far as anyone can tell: a warning that the write couldn't be
 * confirmed. Until `sentAt` plus READBACK_MS it checks again; then the write is reported as not
 * done, or, when the reads themselves kept failing, as unknown (a warning too).
 */
export const readBack = async (
  target: WriteTarget,
  sentAt: number,
  read: ReadObject,
  now: () => number,
): Promise<NotificationWatcherResponse> => {
  let readFailed = false;
  try {
    const answer = await read(target.subject, target.id);
    switch (target.op) {
      case 'create':
        if (answer) {
          if (holdsSent(target.expected, answer.fields)) return success(succeededText(target));
          return warning(namesMayChange(target) ? unknownCreatedNameText(target) : mismatchText(target));
        }
        break;
      case 'update':
        if (!answer) return error(goneText(target));
        if (answer.version !== target.version) {
          return holdsSent(target.expected, answer.fields)
            ? success(succeededText(target))
            : warning(mismatchText(target));
        }
        break;
      case 'delete':
        if (!answer) return success(succeededText(target));
        break;
    }
  } catch {
    readFailed = true;
  }
  if (now() < sentAt + READBACK_MS) return repoll;
  if (namesMayChange(target)) return warning(unknownCreatedNameText(target));
  return readFailed ? warning(unconfirmedText(target)) : error(notConfirmedText(target));
};

/**
 * Each cluster the model is placed on (placement.selected_clusters), with its report from
 * `status.clusters`: one entry per placed cluster, with what that cluster's LLMInferenceService
 * reports (ModelClusterView.deployment). A cluster that hasn't reported has no entry yet, and isn't
 * running.
 */
const placedClustersOf = (model: ModelView) => {
  const reports = new Map(model.clusters.map((c) => [c.cluster, c]));
  const names = model.selectedClusters.length ? model.selectedClusters : model.clusters.map((c) => c.cluster);
  return names.map((name) => ({ name, report: reports.get(name) }));
};

/**
 * Why a model's deployment failed: the first placed cluster whose LLMInferenceService KServe reports
 * failed (`deployment` FAILED), with KServe's message there, or whose sync Argo CD gave up on
 * (`sync` FAILED: an admission refusal, a bad manifest), with Argo CD's message: that revision never
 * lands on the cluster. Undefined while none has. The model's overall Failed isn't one while a
 * cluster is placed: it also covers MaaS failing to publish the model on an ingress cluster, while
 * the model runs (maasFailureOf).
 */
const failureOf = (model: ModelView): { why: string } | undefined => {
  for (const { name, report } of placedClustersOf(model)) {
    if (report?.deployment === 'Failed') {
      return { why: `${name}: ${report.deploymentMessage ?? report.message ?? report.reason}` };
    }
    if (report?.syncFailed) return { why: `${name}: ${report.syncMessage ?? report.message ?? report.reason}` };
  }
  return undefined;
};

/**
 * The ingress clusters where MaaS failed to publish the model (`status.ingress` FAILED), with its
 * message; undefined while MaaS hasn't failed (`status.maas` isn't FAILED and no entry is). Still
 * routing, or waiting for a subscription, isn't failed: users reach the model once that is done.
 */
const maasFailureOf = (model: ModelView): { cluster: string; message?: string }[] | undefined => {
  const failed = model.ingress.filter((i) => i.failed);
  return failed.length || model.maasFailed ? failed : undefined;
};

/**
 * A deployed model until it runs on every cluster it is placed on. Ready is read per cluster, from
 * the deployment each entry of `status.clusters` reports (`deployment` RUNNING), not from the
 * model's overall phase nor the cluster's: those also count MaaS, the ingress clusters that publish
 * the model and, on a combined cluster, its MaaSModelRef and ExternalModel, which can stay pending
 * while the route is set up, and an Argo CD sync that reads OutOfSync while the model runs. "Ready"
 * here means running on its clusters; users reach it through MaaS once its route is set up and a
 * subscription covers it (a model waiting only for that reads Ready in the backend too).
 *
 * A placed cluster whose deployment failed, or whose sync Argo CD gave up on, is an error, "Unable
 * to deploy", with KServe's or Argo CD's message (failureOf). Every placed cluster running is a
 * success naming them, unless MaaS failed to publish the model on an ingress cluster: then a warning
 * that it runs but isn't available to users, naming where MaaS failed and why. Anything else is
 * checked again until `since` plus READY_MS, then a warning names the clusters it isn't ready on, or,
 * when that last read failed, says the console couldn't confirm it. A model that is gone stops the
 * watch. A model with no placed cluster (on the hub alone) is ready when its phase is Ready, and
 * failed, "Unable to deploy" with the model's message, when its phase is Failed.
 */
export const watchReady = async (
  target: WriteTarget,
  since: number,
  read: ReadObject,
  now: () => number,
): Promise<NotificationWatcherResponse> => {
  let waiting: string[] = [];
  let readFailed = false;
  try {
    const answer = await read('model', target.id);
    const model = answer?.model;
    if (!model) return stop;
    const failure = failureOf(model);
    if (failure) return error(modelFailedText(target.id, target.name, failure.why));
    const placed = placedClustersOf(model);
    if (placed.length === 0) {
      if (model.phase === 'Ready') return success(modelReadyText(target.id, target.name, []));
      if (model.phase === 'Failed') return error(modelFailedText(target.id, target.name, model.statusMessage));
    } else {
      waiting = placed.filter((p) => p.report?.deployment !== 'Running').map((p) => p.name);
      if (waiting.length === 0) {
        const runsOn = placed.map((p) => p.name);
        const maasFailure = maasFailureOf(model);
        if (maasFailure) return warning(modelUnavailableText(target.id, target.name, runsOn, maasFailure));
        return success(modelReadyText(target.id, target.name, runsOn));
      }
    }
  } catch {
    // A failed read is checked again, as a page's poll is.
    readFailed = true;
  }
  if (now() < since + READY_MS) return repoll;
  // A last read that failed says nothing about the clusters: the outcome is unknown.
  return warning(
    readFailed ? modelUnconfirmedText(target.id, target.name) : modelNotReadyText(target.id, target.name, waiting),
  );
};

/**
 * An edited model while its changes roll out, until `since` plus READY_MS; then it ends silently. It
 * never says "ready": the status doesn't say which revision it describes, and during a rolling update
 * the previous pod keeps its cluster Ready. It reports one thing, a placed cluster's deployment
 * failed or its sync was given up on (failureOf; MaaS failing to publish the model isn't one), and
 * only one it saw happen:
 * `before` is the status the watch saw last (statusOf), none on its first read, which comes as the
 * edit lands, before Argo CD can have applied it. A deployment already failed then is the previous
 * revision's failure, reported only once its status changes (a new failure). A model that is gone
 * stops the watch.
 */
export const watchChanges = async (
  target: WriteTarget,
  since: number,
  read: ReadObject,
  now: () => number,
  before: string | undefined,
): Promise<NotificationWatcherResponse> => {
  try {
    const answer = await read('model', target.id);
    const model = answer?.model;
    if (!model) return stop;
    const failure = failureOf(model);
    if (failure && before !== undefined && statusOf(answer) !== before) {
      return error(modelChangesFailedText(target.id, target.name, failure.why));
    }
  } catch {
    // A failed read is checked again, as a page's poll is.
  }
  return now() < since + READY_MS ? repoll : stop;
};

/**
 * Whether a subscription or cluster watch has found nothing to go on: NO_STATUS_READS reads in a row without
 * a status, no failed read between them, and none with one before.
 */
const noStatusAvailable = (history: StatusHistory) => history.last === undefined && history.empties >= NO_STATUS_READS;

/**
 * A created subscription until it is active on every ingress cluster. The backend reads both
 * phases from the health the catalog's Argo CD Applications record for each cluster (maasPhase and
 * withAuthPolicyStatus, its internal/servers/subscriptions_git.go): Active when every cluster
 * reports the object ready, Degraded when any reports it failed, Pending while any reports it
 * pending or doesn't list it yet. Degraded doesn't end the watch: MaaS calls a subscription Failed or
 * Degraded while a model it names has no MaaSModelRef or route on the cluster yet
 * (deriveFinalPhase, models-as-a-service's maassubscription_controller.go), and the Applications'
 * health check reads both as Degraded, so a subscription created with its model reads Degraded
 * until the model is published there, then Active. Get's model registrations say when a model is
 * published, but nothing says how long MaaS and Argo CD take to turn the subscription Active after
 * that, so a Degraded that persists is told only at the deadline.
 *
 * Active needs the authorization policy Active too: in MaaS the policy gives the users access to
 * the models and the subscription their quota, and a user needs both. Both active is a success; a
 * subscription Get lists no policy for isn't active, as its policy isn't there yet (verdictOf);
 * anything else is checked again until `since` plus READY_MS, then a warning from the last read
 * that found a status (the last one may find none, while the backend can't read the reports): that
 * an ingress cluster reports the subscription, or its policy, failed, with the backend's message,
 * when that read had either Degraded; else which of the two isn't active; or, when the last read
 * failed or no read found a status, that the console couldn't confirm it. An empty phase claims
 * nothing either way: with no status found before, NO_STATUS_READS of them in a row stop the watch
 * silently. `history` is what the earlier
 * reads found (nextHistory). A subscription that is gone stops the watch.
 */
export const watchActive = async (
  target: WriteTarget,
  since: number,
  read: ReadObject,
  now: () => number,
  history: StatusHistory = NO_HISTORY,
): Promise<NotificationWatcherResponse> => {
  // The verdict to judge by: this read's, or, when it found no status, the last read's that did;
  // none when this read failed.
  let judged: StatusHistory | undefined;
  try {
    const answer = await read('subscription', target.id);
    if (!answer?.subscription) return stop;
    const next = nextHistory(history, answer);
    if (noStatusAvailable(next)) return stop;
    judged = next;
    if (answer.subscription.phase !== '' && next.last === 'active') return success(subscriptionActiveText(target));
  } catch {
    // A failed read is checked again, as a page's poll is.
  }
  if (now() < since + READY_MS) return repoll;
  switch (judged?.last) {
    case 'subscriptionDegraded':
      return warning(subscriptionFailedText(target, 'subscription', judged.message));
    case 'policyDegraded':
      return warning(subscriptionFailedText(target, 'policy', judged.message));
    case 'subscription':
    case 'policy':
      return warning(subscriptionNotActiveText(target, judged.last));
    default:
      // Without a status to judge by, the outcome is unknown: never "isn't active".
      return warning(subscriptionUnconfirmedText(target));
  }
};

/**
 * An edited subscription while the ingress clusters apply its changes, until `since` plus READY_MS;
 * then it ends silently. It says nothing: Active doesn't say which version it describes (the
 * clusters' reports name objects, not versions, and the previous version stays active while the
 * new one is applied), and Degraded may be a model not published yet (watchActive). It is there so
 * the pages refetch when the phase changes. Empty phases stop it as they stop watchActive; a
 * subscription that is gone stops it.
 */
export const watchSubscriptionChanges = async (
  target: WriteTarget,
  since: number,
  read: ReadObject,
  now: () => number,
  history: StatusHistory = NO_HISTORY,
): Promise<NotificationWatcherResponse> => {
  try {
    const answer = await read('subscription', target.id);
    if (!answer?.subscription) return stop;
    if (noStatusAvailable(nextHistory(history, answer))) return stop;
  } catch {
    // A failed read is checked again, as a page's poll is.
  }
  return now() < since + READY_MS ? repoll : stop;
};

/**
 * A cluster after its write landed, until the hub has done what the write asked, read from
 * Clusters/Get:
 *
 * - Added to AI grid, or given the role it lacked (`op` add, or update with a role): until it is
 *   provisioned, a member whose `status.provisioning` is Compliant (as toClusterView in
 *   clusterView.ts reads Provisioned). The ready check behind it confirms OpenShift AI, never MaaS
 *   (clusterProvisionedText). Anything else is checked again until `since` plus CLUSTER_MS; then a
 *   warning that it isn't provisioned or, when the last read failed or no read found a status, that
 *   the console couldn't confirm it. An empty provisioning (the ready Policy doesn't list the
 *   cluster) claims nothing: with no status found before, NO_STATUS_READS of them in a row stop the
 *   watch silently, as they stop a subscription's (watchActive): a hub without the ready Policy, or
 *   one the backend can't read, which no write changes. A cluster that is no longer a member
 *   (someone removed it) stops the watch.
 * - Removed from AI grid (`op` remove): until it has left, no longer a member and no longer listed
 *   by the ready Policy (`status.provisioning` empty), which happens once the hub's placement lets
 *   it go. Membership alone is the label the write removed, so the write's own answer already says
 *   it. After CLUSTER_MS, a warning that it hasn't left, or that the console couldn't confirm it.
 *   A member again (someone added it back) stops the watch.
 *
 * A cluster that is gone from the hub stops either.
 */
export const watchCluster = async (
  target: WriteTarget,
  since: number,
  read: ReadObject,
  now: () => number,
  history: StatusHistory = NO_HISTORY,
): Promise<NotificationWatcherResponse> => {
  const removing = target.op === 'remove';
  // The verdict to judge by at the deadline: this read's, or the last read's that found a status;
  // none when this read failed.
  let verdict: Verdict | undefined;
  let readFailed = false;
  try {
    const answer = await read('cluster', target.id);
    const cluster = answer?.cluster;
    if (!cluster) return stop;
    if (removing) {
      if (cluster.member) return stop;
      if (cluster.provisioning === '') return success(clusterLeftText(target));
    } else {
      if (!cluster.member) return stop;
      const next = nextHistory(history, answer);
      if (noStatusAvailable(next)) return stop;
      verdict = next.last;
      if (cluster.provisioning === 'Compliant') return success(clusterProvisionedText(target));
    }
  } catch {
    // A failed read is checked again, as a page's poll is.
    readFailed = true;
  }
  if (now() < since + CLUSTER_MS) return repoll;
  if (removing) return warning(readFailed ? clusterLeftUnconfirmedText(target) : clusterNotLeftText(target));
  // Without a status to judge by, the outcome is unknown: never "isn't provisioned".
  return warning(
    verdict === 'provisioning' ? clusterNotProvisionedText(target) : clusterProvisionedUnconfirmedText(target),
  );
};
