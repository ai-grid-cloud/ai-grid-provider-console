import type { ModelClusterView, ModelView } from '../pages/models/modelView';
import { NotificationResponseStatus } from './useNotificationWatcher';
import {
  CLUSTER_MS,
  NO_HISTORY,
  NO_STATUS_READS,
  READBACK_MS,
  READY_MS,
  nextHistory,
  readBack,
  statusOf,
  watchActive,
  watchChanges,
  watchCluster,
  watchReady,
  watchSubscriptionChanges,
  type ReadAnswer,
  type ReadObject,
  type StatusHistory,
} from './writeWatches';
import type { WriteTarget } from './writeText';

const SENT = 1_000_000;
const before = () => SENT + READBACK_MS - 1;
const after = () => SENT + READBACK_MS;

const reads =
  (answer: ReadAnswer | undefined | Error): ReadObject =>
  async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };

const model = (op: WriteTarget['op'], version?: number): WriteTarget => ({
  subject: 'model',
  op,
  id: 'widget',
  name: 'Widget',
  ...(version === undefined ? {} : { version }),
});

const subscription = (op: WriteTarget['op'], version?: number): WriteTarget => ({
  subject: 'subscription',
  op,
  id: 'team-a',
  name: 'Team A',
  ...(version === undefined ? {} : { version }),
});

describe('readBack', () => {
  it.each<[string, WriteTarget, ReadAnswer | undefined, string]>([
    ['a create is confirmed by the object', model('create'), { version: 1 }, 'Model Widget saved to Git'],
    [
      'an update by a version past the one sent',
      model('update', 3),
      { version: 4 },
      'Changes to model Widget saved to Git',
    ],
    ['a delete by NotFound', model('delete'), undefined, 'Model Widget deleted from Git'],
    ['a subscription create', subscription('create'), { version: 1 }, 'Subscription Team A saved to Git'],
    ['a subscription update', subscription('update', 1), { version: 2 }, 'Changes to subscription Team A saved to Git'],
    ['a subscription delete', subscription('delete'), undefined, 'Subscription Team A deleted from Git'],
  ])('confirms: %s', async (_name, target, answer, title) => {
    const response = await readBack(target, SENT, reads(answer), before);
    expect(response).toMatchObject({ status: NotificationResponseStatus.SUCCESS, title });
  });

  it.each<[string, WriteTarget, ReadAnswer | undefined]>([
    ['a create while the object is missing', model('create'), undefined],
    ['an update while the version is the one sent', model('update', 3), { version: 3 }],
    ['a delete while the object is still there', model('delete'), { version: 1 }],
  ])('checks again before the deadline: %s', async (_name, target, answer) => {
    expect(await readBack(target, SENT, reads(answer), before)).toEqual({ status: NotificationResponseStatus.REPOLL });
  });

  it.each<[string, WriteTarget, ReadAnswer | undefined, string, RegExp]>([
    [
      'a create never found',
      model('create'),
      undefined,
      'Unable to save model Widget',
      /wasn't found in Git 2 minutes after it was submitted, and the reason is unknown/,
    ],
    [
      'an update never seen',
      model('update', 3),
      { version: 3 },
      'Unable to save changes to model Widget',
      /changes weren't found in Git 2 minutes after/,
    ],
    [
      'a delete that left the object',
      subscription('delete'),
      { version: 1 },
      'Unable to delete subscription Team A',
      /is still in Git 2 minutes after it was deleted/,
    ],
  ])('says it was not done after the deadline: %s', async (_name, target, answer, title, message) => {
    const response = await readBack(target, SENT, reads(answer), after);
    expect(response).toMatchObject({ status: NotificationResponseStatus.ERROR, title });
    expect(response).toHaveProperty('message', expect.stringMatching(message));
  });

  describe('confirms only what this write sent', () => {
    const sent = { displayName: 'Widget', uri: 'hf://org/widget', replicas: '1' };
    const withFields = (target: WriteTarget): WriteTarget => ({ ...target, expected: sent });

    it('confirms a create, or an update past its version, whose fields read back as sent', async () => {
      const answer = { version: 4, fields: { ...sent, image: 'quay.io/x' } };
      expect(await readBack(withFields(model('create')), SENT, reads(answer), before)).toMatchObject({
        status: NotificationResponseStatus.SUCCESS,
        title: 'Model Widget saved to Git',
      });
      expect(await readBack(withFields(model('update', 3)), SENT, reads(answer), before)).toMatchObject({
        status: NotificationResponseStatus.SUCCESS,
        title: 'Changes to model Widget saved to Git',
      });
    });

    it("doesn't confirm a create whose id holds something else: a warning, not an error", async () => {
      const answer = { version: 1, fields: { ...sent, uri: 'hf://someone-else/widget' } };
      expect(await readBack(withFields(model('create')), SENT, reads(answer), before)).toEqual({
        status: NotificationResponseStatus.WARNING,
        title: 'Unable to confirm model Widget',
        message:
          "A model with this name is in Git, but it doesn't match what you submitted. Someone else may have created it. Open the model to check it.",
        actions: [{ title: 'View model', to: '/models/widget' }],
      });
    });

    it("doesn't confirm an update whose version moved on with other content", async () => {
      const answer = { version: 4, fields: { ...sent, replicas: '5' } };
      expect(await readBack(withFields(model('update', 3)), SENT, reads(answer), before)).toEqual({
        status: NotificationResponseStatus.WARNING,
        title: 'Unable to confirm model Widget',
        message:
          'The model was changed in Git, but not as you submitted. Someone else may have edited it. Open the model to check your changes.',
        actions: [{ title: 'View model', to: '/models/widget' }],
      });
    });
  });

  describe('a subscription create, which the backend may name with a suffix only its answer carries', () => {
    const sent = { displayName: 'Team A' };
    const created = { ...subscription('create'), expected: sent };
    const unknown = {
      status: NotificationResponseStatus.WARNING,
      title: 'Unable to confirm subscription Team A',
      message:
        "The AI grid backend's answer was lost, and the backend may have added a suffix to the subscription's name, so it's unknown whether the subscription was saved to Git. Check the Subscriptions list before you create it again.",
      actions: [{ title: 'Go to Subscriptions', to: '/subscriptions' }],
    };

    it('is unknown, not "not done", when the requested id never shows', async () => {
      expect(await readBack(created, SENT, reads(undefined), before)).toEqual({
        status: NotificationResponseStatus.REPOLL,
      });
      expect(await readBack(created, SENT, reads(undefined), after)).toEqual(unknown);
      expect(await readBack(created, SENT, reads(new Error('unavailable')), after)).toEqual(unknown);
    });

    it("is unknown, not someone else's, when the requested id holds something else", async () => {
      const answer = { version: 1, fields: { displayName: 'Other team' } };
      expect(await readBack(created, SENT, reads(answer), before)).toEqual(unknown);
    });
  });

  it('says an update failed when its object is gone', async () => {
    expect(await readBack(model('update', 3), SENT, reads(undefined), before)).toMatchObject({
      status: NotificationResponseStatus.ERROR,
      title: 'Unable to save changes to model Widget',
      message: 'The model no longer exists.',
    });
  });

  it('retries a failed read, then says the outcome is unknown, not that the write failed', async () => {
    const failing = reads(new Error('unavailable'));
    expect(await readBack(model('create'), SENT, failing, before)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    // A warning, not an error: nobody knows whether the write landed.
    expect(await readBack(model('create'), SENT, failing, after)).toMatchObject({
      status: NotificationResponseStatus.WARNING,
      title: 'Unable to confirm model Widget',
      actions: [{ title: 'Go to Models', to: '/models' }],
    });
  });
});

describe('watchReady', () => {
  const SINCE = 5_000_000;
  const running: ModelClusterView = { cluster: 'site-b', phase: 'Ready', reason: 'Ready', deployment: 'Running' };
  const view = (phase: ModelView['phase'], extra: Partial<ModelView> = {}): ReadAnswer => ({
    version: 2,
    model: {
      phase,
      clusters: [
        running,
        {
          cluster: 'site-c',
          phase: phase === 'Ready' ? 'Ready' : 'Pending',
          reason: phase === 'Ready' ? 'Ready' : 'NotReady',
          deployment: phase === 'Ready' ? 'Running' : 'Starting',
        },
      ],
      selectedClusters: ['site-b', 'site-c'],
      maasFailed: false,
      ingress: [],
      ...extra,
    } as ModelView,
  });
  /** Runs on site-b; MaaS failed to publish it on site-a, an ingress cluster (status.ingress). */
  const maasFailed = view('Failed', {
    reason: 'Failed',
    statusMessage: 'Ready on site-b; failed to publish on site-a. MaaSModelRef on site-a: HTTPRoute rejected',
    selectedClusters: ['site-b'],
    clusters: [running],
    maasFailed: true,
    ingress: [{ cluster: 'site-a', failed: true, message: 'HTTPRoute rejected by the gateway.' }],
  });
  const during = () => SINCE + READY_MS - 1;
  const past = () => SINCE + READY_MS;

  it('says a model is ready when every cluster it is placed on runs it', async () => {
    expect(await watchReady(model('create'), SINCE, reads(view('Ready')), during)).toEqual({
      status: NotificationResponseStatus.SUCCESS,
      title: 'Model Widget is ready on site-b and site-c',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it('names no cluster for a model on the hub alone', async () => {
    const hub = view('Ready', { clusters: [], selectedClusters: [] });
    expect(await watchReady(model('create'), SINCE, reads(hub), during)).toMatchObject({
      title: 'Model Widget is ready',
    });
  });

  it("says the model couldn't be deployed when a placed cluster's deployment failed, in KServe's words", async () => {
    const failing = view('Failed', {
      reason: 'Failed',
      clusters: [
        running,
        {
          cluster: 'site-c',
          phase: 'Failed',
          reason: 'Failed',
          message: 'LLMInferenceService failed',
          deployment: 'Failed',
          deploymentMessage: 'ns/widget: Accepted=False (reason NoMatchingParent)',
        },
      ],
    });
    expect(await watchReady(model('create'), SINCE, reads(failing), during)).toEqual({
      status: NotificationResponseStatus.ERROR,
      title: 'Unable to deploy model Widget',
      message: 'site-c: ns/widget: Accepted=False (reason NoMatchingParent)',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it("says the model couldn't be deployed when Argo CD gave up its sync on a placed cluster, in Argo CD's words", async () => {
    // The LLMInferenceService never lands on site-c, so its deployment stays Unknown.
    const refused = view('Failed', {
      reason: 'Failed',
      clusters: [
        running,
        {
          cluster: 'site-c',
          phase: 'Failed',
          reason: 'Failed',
          message: 'Sync failed',
          deployment: 'Unknown',
          syncFailed: true,
          syncMessage: 'admission webhook "validating.kserve.io" denied the request: invalid model URI',
        },
      ],
    });
    expect(await watchReady(model('create'), SINCE, reads(refused), during)).toEqual({
      status: NotificationResponseStatus.ERROR,
      title: 'Unable to deploy model Widget',
      message: 'site-c: admission webhook "validating.kserve.io" denied the request: invalid model URI',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it("says the model couldn't be deployed when it has no placed cluster and its phase is Failed, in the model's words", async () => {
    const failed = view('Failed', {
      reason: 'Failed',
      statusMessage: 'MaaSModelRef on site-a: HTTPRoute rejected',
      clusters: [],
      selectedClusters: [],
    });
    expect(await watchReady(model('create'), SINCE, reads(failed), during)).toEqual({
      status: NotificationResponseStatus.ERROR,
      title: 'Unable to deploy model Widget',
      message: 'MaaSModelRef on site-a: HTTPRoute rejected',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it('says it runs but users cannot reach it when MaaS failed to publish it, not that it failed to deploy', async () => {
    // The backend calls the whole model Failed, but its deployment runs on every placed cluster.
    expect(await watchReady(model('create'), SINCE, reads(maasFailed), during)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: "Model Widget is running but isn't available to users",
      message:
        "It runs on site-b. MaaS couldn't publish it on site-a: HTTPRoute rejected by the gateway. Open the model to check its status.",
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it('names every ingress cluster MaaS failed on, with its message when it has one', async () => {
    const twice = view('Failed', {
      selectedClusters: ['site-b'],
      clusters: [running],
      maasFailed: true,
      ingress: [
        { cluster: 'site-a', failed: true, message: 'HTTPRoute rejected.' },
        { cluster: 'site-d', failed: false, message: 'Awaiting governance pairing' },
        { cluster: 'site-e', failed: true },
      ],
    });
    expect(await watchReady(model('create'), SINCE, reads(twice), during)).toMatchObject({
      status: NotificationResponseStatus.WARNING,
      message:
        "It runs on site-b. MaaS couldn't publish it on site-a: HTTPRoute rejected; on site-e. Open the model to check its status.",
    });
  });

  it('waits for the deployments while MaaS has failed, and only then warns that users cannot reach it', async () => {
    const starting = view('Failed', {
      maasFailed: true,
      ingress: [{ cluster: 'site-a', failed: true, message: 'HTTPRoute rejected.' }],
    });
    expect(await watchReady(model('create'), SINCE, reads(starting), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });

  it('is ready while MaaS still sets up its route or waits for a subscription', async () => {
    // A model waiting only for a subscription reads Ready in the backend (status.maas
    // AWAITING_SUBSCRIPTION); one still routing reads Pending. Neither is a failure.
    const waiting = view('Pending', {
      selectedClusters: ['site-b'],
      clusters: [running],
      ingress: [
        { cluster: 'site-a', failed: false, message: 'Awaiting governance pairing' },
        { cluster: 'site-d', failed: false, message: 'Waiting for HTTPRoute to be created' },
      ],
    });
    expect(await watchReady(model('create'), SINCE, reads(waiting), during)).toEqual({
      status: NotificationResponseStatus.SUCCESS,
      title: 'Model Widget is ready on site-b',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it.each<ModelView['phase']>(['Pending', 'Partially ready', 'Saved to Git', 'Unknown'])(
    'keeps watching a model that is %s while site-c runs no copy, and warns after 30 minutes',
    async (phase) => {
      expect(await watchReady(model('create'), SINCE, reads(view(phase)), during)).toEqual({
        status: NotificationResponseStatus.REPOLL,
      });
      expect(await watchReady(model('create'), SINCE, reads(view(phase)), past)).toEqual({
        status: NotificationResponseStatus.WARNING,
        title: "Model Widget isn't ready yet",
        message:
          "It isn't ready on site-c 30 minutes after it was saved to Git. Open the model to check each cluster's status.",
        actions: [{ title: 'View model', to: '/models/widget' }],
      });
    },
  );

  it('waits for a placed cluster that has no report yet', async () => {
    const unreported = view('Pending', { selectedClusters: ['site-b', 'site-c'], clusters: [running] });
    expect(await watchReady(model('create'), SINCE, reads(unreported), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });

  it('is ready on a combined cluster that runs it while MaaS there still sets up its route', async () => {
    // A combined cluster's phase also counts its MaaSModelRef and ExternalModel, which stay
    // pending while MaaS configures the route; its deployment runs (ModelClusterStatus.deployment).
    const routing = view('Pending', {
      selectedClusters: ['site-a'],
      clusters: [
        {
          cluster: 'site-a',
          phase: 'Pending',
          reason: 'NotReady',
          message: 'LLMInferenceService ready; MaaSModelRef not ready; ExternalModel ready',
          deployment: 'Running',
        },
      ],
    });
    expect(await watchReady(model('create'), SINCE, reads(routing), during)).toEqual({
      status: NotificationResponseStatus.SUCCESS,
      title: 'Model Widget is ready on site-a',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it("isn't ready on a cluster where it is stopped, and names it after 30 minutes", async () => {
    const stopped = view('Pending', {
      reason: 'NotReady',
      clusters: [
        running,
        {
          cluster: 'site-c',
          phase: 'Pending',
          reason: 'Stopped',
          message: 'LLMInferenceService stopped',
          deployment: 'Stopped',
        },
      ],
    });
    expect(await watchReady(model('create'), SINCE, reads(stopped), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchReady(model('create'), SINCE, reads(stopped), past)).toMatchObject({
      status: NotificationResponseStatus.WARNING,
      title: "Model Widget isn't ready yet",
      message:
        "It isn't ready on site-c 30 minutes after it was saved to Git. Open the model to check each cluster's status.",
    });
  });

  it("doesn't call a model not ready when its last read failed: it says it can't confirm", async () => {
    expect(await watchReady(model('create'), SINCE, reads(new Error('unavailable')), past)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: 'Unable to confirm model Widget is ready',
      message:
        "The console couldn't read its status 30 minutes after it was saved to Git. Open the model to check its status.",
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it('stops for a model that is gone, and keeps watching through a failed read', async () => {
    expect(await watchReady(model('create'), SINCE, reads(undefined), during)).toEqual({
      status: NotificationResponseStatus.STOP,
    });
    expect(await watchReady(model('create'), SINCE, reads(new Error('x')), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });
});

describe('watchChanges', () => {
  const SINCE = 5_000_000;
  const view = (
    phase: ModelView['phase'],
    deployment: ModelClusterView['deployment'] = 'Running',
    extra: Partial<ModelView> = {},
  ): ReadAnswer => ({
    version: 3,
    model: {
      phase,
      clusters: [
        {
          cluster: 'site-b',
          phase: deployment === 'Running' ? 'Ready' : deployment === 'Failed' ? 'Failed' : 'Pending',
          reason: deployment === 'Running' ? 'Ready' : deployment === 'Failed' ? 'Failed' : 'NotReady',
          deployment,
          ...(deployment === 'Failed' ? { deploymentMessage: 'Back-off pulling image "quay.io/example/vllm:v2"' } : {}),
        },
      ],
      selectedClusters: ['site-b'],
      maasFailed: false,
      ingress: [],
      ...extra,
    } as ModelView,
  });
  const during = () => SINCE + READY_MS - 1;
  const past = () => SINCE + READY_MS;
  const ready = view('Ready');

  it('never says ready: it keeps following a ready model, and ends silently after 30 minutes', async () => {
    expect(await watchChanges(model('update'), SINCE, reads(ready), during, undefined)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchChanges(model('update'), SINCE, reads(ready), during, statusOf(ready))).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchChanges(model('update'), SINCE, reads(ready), past, statusOf(ready))).toEqual({
      status: NotificationResponseStatus.STOP,
    });
  });

  it("says the changes failed when a placed cluster's deployment turns failed, in KServe's words", async () => {
    const failing = view('Failed', 'Failed');
    expect(await watchChanges(model('update'), SINCE, reads(failing), during, statusOf(ready))).toEqual({
      status: NotificationResponseStatus.ERROR,
      title: 'Unable to roll out changes to model Widget',
      message: 'site-b: Back-off pulling image "quay.io/example/vllm:v2"',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it('says the changes failed when Argo CD gives up their sync on a placed cluster, while the previous revision runs', async () => {
    const refused = view('Failed', 'Running', {
      clusters: [
        {
          cluster: 'site-b',
          phase: 'Failed',
          reason: 'Failed',
          deployment: 'Running',
          syncFailed: true,
          syncMessage: 'one or more objects failed to apply',
        },
      ],
    });
    expect(await watchChanges(model('update'), SINCE, reads(refused), during, statusOf(ready))).toEqual({
      status: NotificationResponseStatus.ERROR,
      title: 'Unable to roll out changes to model Widget',
      message: 'site-b: one or more objects failed to apply',
      actions: [{ title: 'View model', to: '/models/widget' }],
    });
  });

  it('says nothing when only MaaS fails after the edit: the deployment runs', async () => {
    const maasFailed = view('Failed', 'Running', {
      reason: 'Failed',
      maasFailed: true,
      ingress: [{ cluster: 'site-a', failed: true, message: 'HTTPRoute rejected.' }],
    });
    expect(await watchChanges(model('update'), SINCE, reads(maasFailed), during, statusOf(ready))).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });

  it("doesn't blame the edit for a deployment failure it found when it started, until that failure changes", async () => {
    const failedBefore = view('Failed', 'Failed');
    // The first read, as the edit lands: the previous revision's failure.
    expect(await watchChanges(model('update'), SINCE, reads(failedBefore), during, undefined)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchChanges(model('update'), SINCE, reads(failedBefore), during, statusOf(failedBefore))).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    // It started again and failed again: a status the watch hadn't seen, so the edit's failure.
    const starting = view('Pending', 'Starting');
    expect(await watchChanges(model('update'), SINCE, reads(failedBefore), during, statusOf(starting))).toMatchObject({
      status: NotificationResponseStatus.ERROR,
      title: 'Unable to roll out changes to model Widget',
    });
  });

  it('sees a deployment fail on a combined cluster whose phase MaaS had already failed', async () => {
    // The cluster's phase was Failed for MaaS's objects; the deployment failing changes no phase.
    const maasOnly = view('Failed', 'Running', {
      clusters: [{ cluster: 'site-b', phase: 'Failed', reason: 'Failed', deployment: 'Running' }],
    });
    const both = view('Failed', 'Running', {
      clusters: [
        { cluster: 'site-b', phase: 'Failed', reason: 'Failed', deployment: 'Failed', deploymentMessage: 'OOMKilled' },
      ],
    });
    expect(await watchChanges(model('update'), SINCE, reads(both), during, statusOf(maasOnly))).toMatchObject({
      status: NotificationResponseStatus.ERROR,
      message: 'site-b: OOMKilled',
    });
  });

  it('stops for a model that is gone, and keeps watching through a failed read', async () => {
    expect(await watchChanges(model('update'), SINCE, reads(undefined), during, statusOf(ready))).toEqual({
      status: NotificationResponseStatus.STOP,
    });
    expect(await watchChanges(model('update'), SINCE, reads(new Error('x')), during, statusOf(ready))).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });
});

describe('watchActive', () => {
  const SINCE = 5_000_000;
  const created = (organization?: string): WriteTarget => ({
    ...subscription('create'),
    ...(organization === undefined ? {} : { organization }),
  });
  const status = (phase: string, policy = phase): ReadAnswer => ({
    version: 1,
    subscription: { phase, policies: [{ id: 'team-a-policy', phase: policy }] },
  });
  const during = () => SINCE + READY_MS - 1;
  const past = () => SINCE + READY_MS;

  it('says a subscription is active once it and its authorization policy are, naming the organization', async () => {
    expect(await watchActive(created('Acme Robotics'), SINCE, reads(status('Active')), during)).toEqual({
      status: NotificationResponseStatus.SUCCESS,
      title: 'Subscription Team A is active',
      message: 'Users in its groups in the Acme Robotics organization can use its models.',
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
  });

  it("leaves the organization out when the form didn't know its name", async () => {
    expect(await watchActive(created(), SINCE, reads(status('Active')), during)).toMatchObject({
      status: NotificationResponseStatus.SUCCESS,
      message: 'Users in its groups can use its models.',
    });
  });

  it("isn't active while Get lists no authorization policy: it waits, then warns about the policy", async () => {
    // Without the policy its users can't call its models; the backend creates it with the
    // subscription, so none listed is a policy not there yet, not one the subscription can do without.
    const alone: ReadAnswer = { version: 1, subscription: { phase: 'Active', policies: [] } };
    expect(await watchActive(created(), SINCE, reads(alone), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchActive(created(), SINCE, reads(alone), past)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: "Subscription Team A isn't active yet",
      message:
        "Its authorization policy isn't active on every ingress cluster 30 minutes after it was saved to Git, so users in its groups might not be able to use its models. Open the subscription to check the policy's status.",
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
  });

  it('keeps watching a pending subscription, and warns after 30 minutes', async () => {
    expect(await watchActive(created('Acme Robotics'), SINCE, reads(status('Pending')), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchActive(created('Acme Robotics'), SINCE, reads(status('Pending')), past)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: "Subscription Team A isn't active yet",
      message:
        "It isn't active on every ingress cluster 30 minutes after it was saved to Git, so users in its groups in the Acme Robotics organization might not be able to use its models. Open the subscription to check its status and its models' status.",
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
  });

  it("waits for its authorization policy, without which users can't call its models", async () => {
    // MaaS needs both: the policy grants access to the models, the subscription the quota.
    const policyPending = status('Active', 'Pending');
    expect(await watchActive(created(), SINCE, reads(policyPending), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchActive(created(), SINCE, reads(policyPending), past)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: "Subscription Team A isn't active yet",
      message:
        "Its authorization policy isn't active on every ingress cluster 30 minutes after it was saved to Git, so users in its groups might not be able to use its models. Open the subscription to check the policy's status.",
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
  });

  it('keeps watching a degraded subscription, which turns active once its model is published', async () => {
    // Degraded isn't an end: a subscription created with its model reads so until the model is
    // published (watchActive).
    const degraded = status('Degraded', 'Pending');
    expect(await watchActive(created(), SINCE, reads(degraded), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    const history = nextHistory(NO_HISTORY, degraded);
    expect(await watchActive(created(), SINCE, reads(status('Active')), during, history)).toMatchObject({
      status: NotificationResponseStatus.SUCCESS,
      title: 'Subscription Team A is active',
    });
    expect(await watchActive(created(), SINCE, reads(degraded), past, history)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: "Subscription Team A isn't active",
      message:
        "An ingress cluster reports it failed. Open the subscription to check its status and its models' status.",
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
  });

  it("says at the deadline that an ingress cluster reports the subscription failed, in the backend's words", async () => {
    const degraded: ReadAnswer = {
      version: 1,
      subscription: {
        phase: 'Degraded',
        message: 'MaaSModelRef granite not found.',
        policies: [{ id: 'team-a-policy', phase: 'Pending' }],
      },
    };
    expect(await watchActive(created(), SINCE, reads(degraded), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchActive(created(), SINCE, reads(degraded), past)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: "Subscription Team A isn't active",
      message:
        "An ingress cluster reports it failed: MaaSModelRef granite not found. Open the subscription to check its status and its models' status.",
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
  });

  it("says at the deadline that an ingress cluster reports its policy failed, with the policy's message", async () => {
    const policyDegraded: ReadAnswer = {
      version: 1,
      subscription: {
        phase: 'Active',
        policies: [{ id: 'team-a-policy', phase: 'Degraded', message: 'Failed on site-a; ready on site-b' }],
      },
    };
    expect(await watchActive(created(), SINCE, reads(policyDegraded), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchActive(created(), SINCE, reads(policyDegraded), past)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: "Subscription Team A isn't active",
      message:
        "An ingress cluster reports its authorization policy failed: Failed on site-a; ready on site-b. Open the subscription to check the policy's status.",
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
    // A pending subscription with a failed policy: the reported failure is what the warning says.
    expect(await watchActive(created(), SINCE, reads(status('Pending', 'Degraded')), past)).toMatchObject({
      title: "Subscription Team A isn't active",
      message: expect.stringMatching(/^An ingress cluster reports its authorization policy failed\. /),
    });
  });

  it('says only what the last status says: a Degraded subscription that turned Pending is not active yet', async () => {
    const history = nextHistory(NO_HISTORY, status('Degraded'));
    expect(await watchActive(created(), SINCE, reads(status('Pending')), past, history)).toMatchObject({
      title: "Subscription Team A isn't active yet",
      message: expect.stringMatching(/^It isn't active on every ingress cluster/),
    });
  });

  describe('an empty phase', () => {
    const none = reads(status('', ''));

    it('claims nothing when no ingress cluster ever reports a status: it stops silently on the third empty read in a row', async () => {
      expect(await watchActive(created(), SINCE, none, () => SINCE, NO_HISTORY)).toEqual({
        status: NotificationResponseStatus.REPOLL,
      });
      expect(await watchActive(created(), SINCE, none, () => SINCE, { empties: 1 })).toEqual({
        status: NotificationResponseStatus.REPOLL,
      });
      expect(await watchActive(created(), SINCE, none, () => SINCE, { empties: NO_STATUS_READS - 1 })).toEqual({
        status: NotificationResponseStatus.STOP,
      });
    });

    it("doesn't stop on one empty read that comes late, as after a delayed first read", async () => {
      expect(await watchActive(created(), SINCE, none, () => SINCE + 5 * 60_000, NO_HISTORY)).toEqual({
        status: NotificationResponseStatus.REPOLL,
      });
    });

    it('takes empty reads after a status for a status unavailable for now, and goes on', async () => {
      expect(
        await watchActive(created(), SINCE, none, during, { empties: NO_STATUS_READS + 10, last: 'subscription' }),
      ).toEqual({ status: NotificationResponseStatus.REPOLL });
    });

    it('warns at the deadline from the last read that found a status, when the last one finds none', async () => {
      expect(await watchActive(created(), SINCE, none, past, { empties: 40, last: 'subscription' })).toMatchObject({
        status: NotificationResponseStatus.WARNING,
        title: "Subscription Team A isn't active yet",
        message: expect.stringMatching(/^It isn't active on every ingress cluster/),
      });
      // The policy-only variant: the last status had the subscription Active and its policy Pending.
      expect(await watchActive(created(), SINCE, none, past, { empties: 2, last: 'policy' })).toMatchObject({
        status: NotificationResponseStatus.WARNING,
        title: "Subscription Team A isn't active yet",
        message: expect.stringMatching(/^Its authorization policy isn't active/),
      });
    });

    it('says the failure the last status reported, with its message, when the last read finds none', async () => {
      const history = { empties: 5, last: 'subscriptionDegraded', message: 'MaaSModelRef granite not found' } as const;
      expect(await watchActive(created(), SINCE, none, past, history)).toMatchObject({
        status: NotificationResponseStatus.WARNING,
        title: "Subscription Team A isn't active",
        message:
          "An ingress cluster reports it failed: MaaSModelRef granite not found. Open the subscription to check its status and its models' status.",
      });
    });

    it("says it can't confirm at the deadline when no read found a status", async () => {
      expect(await watchActive(created(), SINCE, none, past, { empties: 1 })).toMatchObject({
        status: NotificationResponseStatus.WARNING,
        title: 'Unable to confirm subscription Team A is active',
      });
    });

    it('is active on the read that finds it so, whatever came before', async () => {
      expect(
        await watchActive(created(), SINCE, reads(status('Active')), during, { empties: 2, last: 'subscription' }),
      ).toMatchObject({ status: NotificationResponseStatus.SUCCESS, title: 'Subscription Team A is active' });
    });
  });

  it("doesn't call a subscription inactive when its last read failed: it says it can't confirm", async () => {
    expect(await watchActive(created(), SINCE, reads(new Error('unavailable')), past)).toEqual({
      status: NotificationResponseStatus.WARNING,
      title: 'Unable to confirm subscription Team A is active',
      message:
        "The console couldn't read its status 30 minutes after it was saved to Git. Open the subscription to check its status.",
      actions: [{ title: 'View subscription', to: '/subscriptions/view/team-a' }],
    });
  });

  it('stops for a subscription that is gone, and keeps watching through a failed read', async () => {
    expect(await watchActive(created(), SINCE, reads(undefined), during)).toEqual({
      status: NotificationResponseStatus.STOP,
    });
    expect(await watchActive(created(), SINCE, reads(new Error('x')), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });
});

describe('watchSubscriptionChanges', () => {
  const SINCE = 5_000_000;
  const status = (phase: string): ReadAnswer => ({
    version: 2,
    subscription: { phase, policies: [{ id: 'team-a-policy', phase }] },
  });
  const during = () => SINCE + READY_MS - 1;
  const past = () => SINCE + READY_MS;

  it.each(['Active', 'Pending'])(
    'says nothing of a subscription that is %s, and ends after 30 minutes',
    async (phase) => {
      expect(await watchSubscriptionChanges(subscription('update'), SINCE, reads(status(phase)), during)).toEqual({
        status: NotificationResponseStatus.REPOLL,
      });
      expect(await watchSubscriptionChanges(subscription('update'), SINCE, reads(status(phase)), past)).toEqual({
        status: NotificationResponseStatus.STOP,
      });
    },
  );

  it('stops on the third empty read in a row when no read found a status, and not after one', async () => {
    const none = reads(status(''));
    const edited = subscription('update');
    expect(await watchSubscriptionChanges(edited, SINCE, none, () => SINCE + 5 * 60_000, NO_HISTORY)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchSubscriptionChanges(edited, SINCE, none, during, { empties: NO_STATUS_READS - 1 })).toEqual({
      status: NotificationResponseStatus.STOP,
    });
    expect(
      await watchSubscriptionChanges(edited, SINCE, none, during, { empties: NO_STATUS_READS - 1, last: 'active' }),
    ).toEqual({ status: NotificationResponseStatus.REPOLL });
  });

  it('stops for a subscription that is gone, and keeps watching through a failed read', async () => {
    expect(await watchSubscriptionChanges(subscription('update'), SINCE, reads(undefined), during)).toEqual({
      status: NotificationResponseStatus.STOP,
    });
    expect(await watchSubscriptionChanges(subscription('update'), SINCE, reads(new Error('x')), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });
});

describe('nextHistory', () => {
  const status = (phase: string): ReadAnswer => ({
    version: 1,
    subscription: { phase, policies: [{ id: 'team-a-policy', phase }] },
  });

  it('counts empty reads in a row, and a failed read ends the run without forgetting the last verdict', () => {
    expect(nextHistory({ empties: 2 }, status(''))).toEqual({ empties: 3 });
    expect(nextHistory({ empties: 2 }, 'failed')).toEqual({ empties: 0 });
    expect(nextHistory({ empties: 2, last: 'policy' }, 'failed')).toEqual({ empties: 0, last: 'policy' });
    expect(nextHistory({ empties: 2 }, status('Pending'))).toEqual({ empties: 0, last: 'subscription' });
    expect(nextHistory({ empties: 2 }, undefined)).toEqual({ empties: 2 });
  });

  it("keeps a Degraded verdict's message through empty and failed reads, and drops it with the next status", () => {
    const degraded: ReadAnswer = {
      version: 1,
      subscription: { phase: 'Degraded', message: 'MaaSModelRef granite not found', policies: [] },
    };
    const failed: StatusHistory = {
      empties: 0,
      last: 'subscriptionDegraded',
      message: 'MaaSModelRef granite not found',
    };
    expect(nextHistory(NO_HISTORY, degraded)).toEqual(failed);
    expect(nextHistory(failed, status(''))).toEqual({ ...failed, empties: 1 });
    expect(nextHistory(failed, 'failed')).toEqual(failed);
    expect(nextHistory(failed, status('Pending'))).toEqual({ empties: 0, last: 'subscription' });
  });

  it('never stops a watch on empty reads with failed reads between them', async () => {
    // empty, failed, empty, failed, empty: no three empty reads in a row.
    let history = NO_HISTORY;
    for (const answer of [status(''), 'failed', status(''), 'failed'] as const) history = nextHistory(history, answer);
    const lastEmpty = await watchActive(subscription('create'), 0, reads(status('')), () => 0, history);
    expect(lastEmpty).toEqual({ status: NotificationResponseStatus.REPOLL });
  });
});

describe('watchCluster', () => {
  const SINCE = 5_000_000;
  const added: WriteTarget = { subject: 'cluster', op: 'add', id: 'site-b', name: 'site-b', role: 'inference' };
  const removed: WriteTarget = { subject: 'cluster', op: 'remove', id: 'site-b', name: 'site-b' };
  const cluster = (member: boolean, provisioning: string): ReadAnswer => ({
    version: 3,
    cluster: { member, provisioning },
  });
  const during = () => SINCE + CLUSTER_MS - 1;
  const late = () => SINCE + CLUSTER_MS;

  it('waits while the hub provisions the cluster, and says so once the ready check passes', async () => {
    for (const provisioning of ['Pending', 'NonCompliant']) {
      expect(await watchCluster(added, SINCE, reads(cluster(true, provisioning)), during)).toEqual({
        status: NotificationResponseStatus.REPOLL,
      });
    }
    expect(await watchCluster(added, SINCE, reads(cluster(true, 'Compliant')), during)).toMatchObject({
      status: NotificationResponseStatus.SUCCESS,
      title: 'Cluster site-b is provisioned',
      actions: [{ title: 'View cluster', to: '/clusters/site-b' }],
    });
  });

  it('stops when the cluster leaves AI grid or the hub, rather than say anything of it', async () => {
    const stop = { status: NotificationResponseStatus.STOP };
    expect(await watchCluster(added, SINCE, reads(cluster(false, 'Compliant')), during)).toEqual(stop);
    expect(await watchCluster(added, SINCE, reads(undefined), during)).toEqual(stop);
    expect(await watchCluster(removed, SINCE, reads(cluster(true, 'Compliant')), during)).toEqual(stop);
    expect(await watchCluster(removed, SINCE, reads(undefined), during)).toEqual(stop);
  });

  it('judges the deadline by the last status found, and says nothing it could not read', async () => {
    expect(await watchCluster(added, SINCE, reads(cluster(true, 'NonCompliant')), late)).toMatchObject({
      status: NotificationResponseStatus.WARNING,
      title: "Cluster site-b isn't provisioned yet",
    });
    // An empty read after a status was found: the ready Policy was unreadable this once.
    const found = nextHistory(NO_HISTORY, cluster(true, 'NonCompliant'));
    expect(await watchCluster(added, SINCE, reads(cluster(true, '')), late, found)).toMatchObject({
      title: "Cluster site-b isn't provisioned yet",
    });
    expect(await watchCluster(added, SINCE, reads(new Error('unavailable')), late, found)).toMatchObject({
      status: NotificationResponseStatus.WARNING,
      title: 'Unable to confirm cluster site-b is provisioned',
    });
  });

  it('stops on the third empty read in a row before any status, and goes on once one was found', async () => {
    const twoEmpty = { empties: NO_STATUS_READS - 1 };
    expect(await watchCluster(added, SINCE, reads(cluster(true, '')), during, twoEmpty)).toEqual({
      status: NotificationResponseStatus.STOP,
    });
    expect(
      await watchCluster(added, SINCE, reads(cluster(true, '')), during, { ...twoEmpty, last: 'provisioning' }),
    ).toEqual({ status: NotificationResponseStatus.REPOLL });
    // A failed read ends a run of empty ones.
    const reset = nextHistory(twoEmpty, 'failed');
    expect(await watchCluster(added, SINCE, reads(cluster(true, '')), during, reset)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
  });

  it('says a removed cluster left once the hub no longer includes it, not on membership alone', async () => {
    // Membership is the label the remove dropped: the write's own answer says it.
    expect(await watchCluster(removed, SINCE, reads(cluster(false, 'Compliant')), during)).toEqual({
      status: NotificationResponseStatus.REPOLL,
    });
    expect(await watchCluster(removed, SINCE, reads(cluster(false, '')), during)).toMatchObject({
      status: NotificationResponseStatus.SUCCESS,
      title: 'Cluster site-b left AI grid',
    });
    expect(await watchCluster(removed, SINCE, reads(cluster(false, 'Compliant')), late)).toMatchObject({
      status: NotificationResponseStatus.WARNING,
      title: "Cluster site-b hasn't left AI grid yet",
    });
    expect(await watchCluster(removed, SINCE, reads(new Error('unavailable')), late)).toMatchObject({
      title: 'Unable to confirm cluster site-b left AI grid',
    });
  });
});

describe('statusOf', () => {
  it("tells a cluster's membership and provisioning apart", () => {
    const of = (member: boolean, provisioning: string) => statusOf({ version: 1, cluster: { member, provisioning } });
    expect(of(true, 'Pending')).not.toBe(of(true, 'NonCompliant'));
    expect(of(true, 'Compliant')).not.toBe(of(false, 'Compliant'));
    expect(of(true, 'Compliant')).toBe(of(true, 'Compliant'));
  });

  it("tells a subscription's phase, and its authorization policy's, apart", () => {
    const of = (phase: string, policy: string) =>
      statusOf({ version: 1, subscription: { phase, policies: [{ id: 'team-a-policy', phase: policy }] } });
    expect(of('Pending', 'Pending')).not.toBe(of('Active', 'Pending'));
    expect(of('Active', 'Pending')).not.toBe(of('Active', 'Active'));
    expect(of('Active', 'Active')).toBe(of('Active', 'Active'));
    expect(statusOf(undefined)).toBe('gone');
  });

  it('tells a cluster whose sync Argo CD gave up on from one still syncing, and reads the same as before otherwise', () => {
    const of = (syncFailed?: boolean) =>
      statusOf({
        version: 1,
        model: {
          phase: 'Failed',
          clusters: [{ cluster: 'site-b', phase: 'Failed', reason: 'Failed', deployment: 'Running', syncFailed }],
        } as ModelView,
      });
    expect(of(true)).not.toBe(of(false));
    expect(of(false)).toBe(of(undefined));
    expect(of(false)).toBe(JSON.stringify(['Failed', null, [['site-b', 'Failed', 'Failed', 'Running']]]));
  });
});
