// The notification center when the signed-in user changes in the same tab: the previous user's
// notifications and watches go, and the new user's are restored.
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { useQuery } from '@connectrpc/connect-query';
import { BackendProvider } from '../api/connect/BackendProvider';
import { fakeClients } from '../api/connect/testing';
import {
  ModelClusterStatusSchema,
  ModelDeploymentState,
  ModelIngressStatusSchema,
  ModelMaasState,
  ModelPhase,
  ModelSchema,
  ModelState,
  ModelSyncState,
} from '../gen/ai_grid/v1/model_type_pb';
import { get as getCluster, list as listClusters } from '../gen/ai_grid/v1/clusters_service-Clusters_connectquery';
import { ManagedClusterSchema } from '../gen/ai_grid/v1/managed_cluster_type_pb';
import { list as listModels } from '../gen/ai_grid/v1/models_service-Models_connectquery';
import { ConditionStatus } from '../gen/ai_grid/v1/condition_type_pb';
import { AuthPolicySchema, SubscriptionSchema } from '../gen/ai_grid/v1/subscription_type_pb';
import {
  get as getSubscription,
  list as listSubscriptions,
} from '../gen/ai_grid/v1/subscriptions_service-Subscriptions_connectquery';
import { memoryStorage } from '../__tests__/memoryStorage';
import { deferred } from '../__tests__/render';
import { BackgroundWritesProvider } from './BackgroundWritesProvider';
import { NotificationsProvider } from './NotificationsProvider';
import { notificationsKey, watchesKey } from './storageKeys';
import { NotificationWatcherProvider } from './NotificationWatcherProvider';
import { useBackgroundWrites, type BackgroundWritesValue } from './useBackgroundWrites';
import { useNotifications } from './useNotifications';
import { CLUSTER_MS, CLUSTER_POLL_MS, READY_MS, READY_POLL_MS } from './writeWatches';

const Titles: React.FC = () => {
  const { notifications } = useNotifications();
  return (
    <ul aria-label="Titles">
      {notifications.map((n) => (
        <li key={n.id}>{n.title}</li>
      ))}
    </ul>
  );
};

const entry = (id: string, title: string) => ({ id, variant: 'info', title, timestamp: Date.now(), read: true });
const watch = (id: string) => ({
  key: `w-${id}`,
  subject: 'model',
  op: 'create',
  id,
  name: id,
  stage: 'readback',
  since: Date.now(),
});

it("drops the previous user's notifications and watches, and restores the new user's", async () => {
  const storage = memoryStorage({
    [notificationsKey('alice')]: JSON.stringify([entry('a1', "Alice's notification")]),
    [watchesKey('alice')]: JSON.stringify([watch('alice-model')]),
    [notificationsKey('bob')]: JSON.stringify([entry('b1', "Bob's notification")]),
  });
  const gets: string[] = [];
  const { transport } = fakeClients({
    models: {
      get: ({ id }) => {
        gets.push(id);
        throw new ConnectError(`Model "${id}" not found`, Code.NotFound);
      },
    },
  });
  const tree = (owner: string) => (
    <BackendProvider transport={transport} checkSession={() => undefined}>
      <NotificationsProvider storage={storage.get} owner={owner}>
        <NotificationWatcherProvider>
          <BackgroundWritesProvider storage={storage.get} owner={owner}>
            <Titles />
          </BackgroundWritesProvider>
        </NotificationWatcherProvider>
      </NotificationsProvider>
    </BackendProvider>
  );
  const { rerender } = render(tree('alice'));
  expect(await screen.findByText("Alice's notification")).toBeVisible();
  // Alice's watch resumed: its read-back asked for her model.
  await waitFor(() => expect(gets).toContain('alice-model'));

  rerender(tree('bob'));
  expect(await screen.findByText("Bob's notification")).toBeVisible();
  expect(screen.queryByText("Alice's notification")).not.toBeInTheDocument();
  // Alice's records leave the tab, so nobody else sees or resumes them.
  expect(storage.values.has(notificationsKey('alice'))).toBe(false);
  expect(storage.values.has(watchesKey('alice'))).toBe(false);
});

let submitWrite: BackgroundWritesValue['submitWrite'] = async () => 'done';
let followWrite: BackgroundWritesValue['followWrite'] = () => undefined;
const capture = (value: BackgroundWritesValue) => {
  submitWrite = value.submitWrite;
  followWrite = value.followWrite;
};

const Writes: React.FC = () => {
  const value = useBackgroundWrites();
  useEffect(() => capture(value), [value]);
  return null;
};

it("publishes nothing of a write into the next user's notifications or storage when the user changes during the form's wait", async () => {
  const storage = memoryStorage();
  const { transport } = fakeClients({});
  const waits: (() => void)[] = [];
  const formWait = () => new Promise<void>((resolve) => waits.push(resolve));
  const answer = deferred<void>();
  const tree = (owner: string) => (
    <BackendProvider transport={transport} checkSession={() => undefined}>
      <NotificationsProvider storage={storage.get} owner={owner}>
        <NotificationWatcherProvider>
          <BackgroundWritesProvider storage={storage.get} owner={owner} formWait={formWait}>
            <Titles />
            <Writes />
          </BackgroundWritesProvider>
        </NotificationWatcherProvider>
      </NotificationsProvider>
    </BackendProvider>
  );
  const { rerender } = render(tree('alice'));
  let outcome: Promise<string> = Promise.resolve('');
  act(() => {
    outcome = submitWrite({ subject: 'model', op: 'create', id: 'widget', name: 'Widget' }, () => answer.promise);
  });
  // Bob signs in while Alice's write is out, then the form's wait ends, then the answer comes.
  rerender(tree('bob'));
  await act(async () => waits.shift()?.());
  expect(await outcome).toBe('pending');
  await act(async () => answer.resolve());
  expect(screen.queryByText('Saving model Widget')).not.toBeInTheDocument();
  expect(screen.queryByText('Model Widget saved to Git')).not.toBeInTheDocument();
  expect(storage.values.get(watchesKey('bob'))).toBeUndefined();
  expect(storage.values.get(notificationsKey('bob'))).toBeUndefined();
});

/** site-b's report once the model's deployment runs there. */
const runningOnSiteB = () =>
  create(ModelClusterStatusSchema, {
    cluster: 'site-b',
    phase: ModelPhase.READY,
    reason: 'Ready',
    deployment: ModelDeploymentState.RUNNING,
    state: ModelState.READY,
  });

/** A model placed on site-b, which hasn't reported it ready. */
const pendingOnSiteB = () =>
  create(ModelSchema, {
    id: 'widget',
    metadata: { name: 'widget', version: 1 },
    spec: { placement: { labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: ['site-b'] }] } } },
    status: {
      phase: ModelPhase.PENDING,
      placement: { selectedClusters: ['site-b'] },
      clusters: [{ cluster: 'site-b', phase: ModelPhase.PENDING, reason: 'NotReady' }],
    },
  });

const readyRecord = (since: number) => ({
  key: 'r1',
  subject: 'model',
  op: 'create',
  id: 'widget',
  name: 'Widget',
  stage: 'ready',
  since,
});

const signedIn = (storage: ReturnType<typeof memoryStorage>) => {
  const { transport } = fakeClients({ models: { get: () => ({ object: pendingOnSiteB() }) } });
  return render(
    <BackendProvider transport={transport} checkSession={() => undefined}>
      <NotificationsProvider storage={storage.get} owner="dev-user">
        <NotificationWatcherProvider>
          <BackgroundWritesProvider storage={storage.get} owner="dev-user">
            <Titles />
            <Writes />
          </BackgroundWritesProvider>
        </NotificationWatcherProvider>
      </NotificationsProvider>
    </BackendProvider>,
  );
};

it("warns that a deployed model isn't ready yet when its 30 minutes run out, instead of stopping silently", async () => {
  vi.useFakeTimers();
  try {
    // The watch has one check left inside its 30 minutes.
    const storage = memoryStorage({
      [watchesKey('dev-user')]: JSON.stringify([readyRecord(Date.now() - READY_MS + READY_POLL_MS / 2)]),
    });
    signedIn(storage);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText("Model Widget isn't ready yet")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READY_POLL_MS);
    });
    expect(screen.getByText("Model Widget isn't ready yet")).toBeInTheDocument();
    expect(storage.values.get(watchesKey('dev-user'))).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('watches a deployed model once, whatever earlier watch of the same id still runs', async () => {
  // A watch from a deploy of the same id (deleted and deployed again within its 30 minutes).
  const storage = memoryStorage({ [watchesKey('dev-user')]: JSON.stringify([readyRecord(Date.now())]) });
  signedIn(storage);
  await waitFor(() => expect(submitWrite).toBeDefined());
  await act(async () => {
    await submitWrite({ subject: 'model', op: 'create', id: 'widget', name: 'Widget' }, async () => undefined);
  });
  const ready = (
    JSON.parse(storage.values.get(watchesKey('dev-user')) ?? '[]') as { id: string; stage: string }[]
  ).filter((r) => r.stage === 'ready' && r.id === 'widget');
  expect(ready).toHaveLength(1);
});

/** The Models list as a page shows it, without a poll of its own: it refetches only when told to. */
const SiteBStatus: React.FC = () => {
  const { data } = useQuery(listModels, {});
  const widget = data?.items.find((m) => m.id === 'widget');
  const siteB = widget?.status?.clusters.find((c) => c.cluster === 'site-b');
  return <p>{`site-b ${siteB?.phase === ModelPhase.READY ? 'ready' : 'pending'}`}</p>;
};

it('refreshes the lists when a readiness watch sees the status change, and not on a poll that sees none', async () => {
  vi.useFakeTimers();
  try {
    let model = pendingOnSiteB();
    let listCalls = 0;
    const { transport } = fakeClients({
      models: {
        get: () => ({ object: model }),
        list: () => {
          listCalls += 1;
          return { items: [model], size: 1, total: 1 };
        },
      },
    });
    const storage = memoryStorage({ [watchesKey('dev-user')]: JSON.stringify([readyRecord(Date.now())]) });
    render(
      <BackendProvider transport={transport} checkSession={() => undefined}>
        <NotificationsProvider storage={storage.get} owner="dev-user">
          <NotificationWatcherProvider>
            <BackgroundWritesProvider storage={storage.get} owner="dev-user">
              <SiteBStatus />
              <Titles />
            </BackgroundWritesProvider>
          </NotificationWatcherProvider>
        </NotificationsProvider>
      </BackendProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('site-b pending')).toBeInTheDocument();
    expect(listCalls).toBe(1);

    // A poll that sees the same status leaves the list alone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READY_POLL_MS);
    });
    expect(listCalls).toBe(1);

    // site-b becomes ready (the whole model stays Pending, as an ingress cluster keeps it): the
    // watch says so, and the list shows it at once.
    model = pendingOnSiteB();
    model.status!.clusters = [runningOnSiteB()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READY_POLL_MS);
    });
    expect(screen.getByText('Model Widget is ready on site-b')).toBeInTheDocument();
    // The refetch the watch asked for settles (the watch has ended: no poll of its own is left).
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(screen.getByText('site-b ready')).toBeInTheDocument();
    expect(listCalls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

/** The console with a Models list that polls nothing itself, around a model the test changes. */
const editing = (stored: object[] = []) => {
  // `failing`: Get fails (Unavailable) while set.
  const state = { model: pendingOnSiteB(), listCalls: 0, failing: false };
  const { transport } = fakeClients({
    models: {
      get: () => {
        if (state.failing) throw new ConnectError('the Git catalog is unreachable', Code.Unavailable);
        return { object: state.model };
      },
      list: () => {
        state.listCalls += 1;
        return { items: [state.model], size: 1, total: 1 };
      },
    },
  });
  const storage = memoryStorage({ [watchesKey('dev-user')]: JSON.stringify(stored) });
  render(
    <BackendProvider transport={transport} checkSession={() => undefined}>
      <NotificationsProvider storage={storage.get} owner="dev-user">
        <NotificationWatcherProvider>
          <BackgroundWritesProvider storage={storage.get} owner="dev-user">
            <SiteBStatus />
            <Titles />
            <Writes />
          </BackgroundWritesProvider>
        </NotificationWatcherProvider>
      </NotificationsProvider>
    </BackendProvider>,
  );
  return { state, storage };
};

const edit = { subject: 'model', op: 'update', id: 'widget', name: 'Widget', version: 1 } as const;

/** Lets every timer due within `ms` run, and what they start settle. */
const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** The watches that follow the model's status, as the tab keeps them. */
const modelWatches = (storage: ReturnType<typeof memoryStorage>) =>
  (
    JSON.parse(storage.values.get(watchesKey('dev-user')) ?? '[]') as { key: string; id: string; stage: string }[]
  ).filter((r) => r.id === 'widget' && (r.stage === 'ready' || r.stage === 'changes'));

it("refreshes the lists when an edited model's status changes, not on a poll that sees none, and never says ready", async () => {
  vi.useFakeTimers();
  try {
    const { state, storage } = editing();
    await pass(0);
    await act(async () => {
      expect(await submitWrite(edit, async () => undefined)).toBe('done');
    });
    await pass(0);
    expect(screen.getByText('Changes to model Widget saved to Git')).toBeInTheDocument();
    expect(modelWatches(storage)).toMatchObject([{ stage: 'changes' }]);
    const afterLanding = state.listCalls;

    // A poll that sees the same status leaves the list alone.
    await pass(READY_POLL_MS);
    expect(state.listCalls).toBe(afterLanding);

    // site-b runs the new revision: the list shows it at once, and nothing says "ready".
    state.model = pendingOnSiteB();
    state.model.status!.clusters = [runningOnSiteB()];
    await pass(READY_POLL_MS);
    expect(state.listCalls).toBe(afterLanding + 1);
    // The refetch's answer reaches the page: the query cache tells it with a setTimeout(0), which
    // fake timers run 1 ms on when it is set during an advance.
    await pass(1);
    expect(screen.getByText('site-b ready')).toBeInTheDocument();
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();

    // After 30 minutes the watch ends without a word.
    await pass(READY_MS);
    expect(modelWatches(storage)).toEqual([]);
    expect(screen.getByRole('list', { name: 'Titles' }).children).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('says once that an edited model failed to roll out its changes', async () => {
  vi.useFakeTimers();
  try {
    const { state, storage } = editing();
    await pass(0);
    await act(async () => {
      await submitWrite(edit, async () => undefined);
    });
    await pass(READY_POLL_MS);

    state.model = pendingOnSiteB();
    state.model.status!.phase = ModelPhase.FAILED;
    state.model.status!.reason = 'Failed';
    state.model.status!.clusters = [
      create(ModelClusterStatusSchema, {
        cluster: 'site-b',
        phase: ModelPhase.FAILED,
        reason: 'Failed',
        deployment: ModelDeploymentState.FAILED,
        deploymentMessage: 'OOMKilled',
        state: ModelState.FAILED,
      }),
    ];
    await pass(READY_POLL_MS);
    expect(screen.getAllByText('Unable to roll out changes to model Widget')).toHaveLength(1);
    expect(modelWatches(storage)).toEqual([]);

    await pass(READY_MS);
    expect(screen.getAllByText('Unable to roll out changes to model Widget')).toHaveLength(1);
    expect(screen.queryByText('Unable to deploy model Widget')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

/** The notifications the tab keeps for the user, with their messages. */
const storedNotifications = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.values.get(notificationsKey('dev-user')) ?? '[]') as { title: string; message?: string }[];

it("says a deployed model couldn't be deployed as soon as Argo CD gives up its sync on a placed cluster", async () => {
  vi.useFakeTimers();
  try {
    const { state, storage } = editing([readyRecord(Date.now())]);
    // The LLMInferenceService never lands on site-b: its deployment has no report.
    state.model.status!.phase = ModelPhase.FAILED;
    state.model.status!.reason = 'Failed';
    state.model.status!.clusters = [
      create(ModelClusterStatusSchema, {
        cluster: 'site-b',
        phase: ModelPhase.FAILED,
        reason: 'Failed',
        message: 'Sync failed',
        sync: ModelSyncState.FAILED,
        syncMessage: 'admission webhook "validating.kserve.io" denied the request',
        state: ModelState.FAILED,
      }),
    ];
    await pass(0);
    expect(screen.getAllByText('Unable to deploy model Widget')).toHaveLength(1);
    expect(storedNotifications(storage)).toContainEqual(
      expect.objectContaining({
        title: 'Unable to deploy model Widget',
        message: 'site-b: admission webhook "validating.kserve.io" denied the request',
      }),
    );
    expect(modelWatches(storage)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("adds no watch to an edited model whose deploy's readiness watch still runs", async () => {
  const { storage } = editing([readyRecord(Date.now())]);
  await waitFor(() => expect(modelWatches(storage)).toHaveLength(1));
  await act(async () => {
    await submitWrite(edit, async () => undefined);
  });
  expect(modelWatches(storage)).toMatchObject([{ key: 'r1', stage: 'ready' }]);
});

it("follows a model edited at 29 minutes of its deploy's watch until 59 minutes, after the deploy's warning", async () => {
  vi.useFakeTimers();
  try {
    const { state, storage } = editing([readyRecord(Date.now())]);
    await pass(0);
    await pass(29 * 60_000);
    await act(async () => {
      await submitWrite(edit, async () => undefined);
    });
    // The deploy's 30 minutes run out: its warning, once, and the edit's watch goes on.
    await pass(3 * READY_POLL_MS);
    expect(screen.getAllByText("Model Widget isn't ready yet")).toHaveLength(1);
    expect(modelWatches(storage)).toMatchObject([{ stage: 'changes' }]);

    // At about 45 minutes site-b runs it: the list refetches.
    await pass(14 * 60_000);
    const lists = state.listCalls;
    state.model = pendingOnSiteB();
    state.model.status!.clusters = [runningOnSiteB()];
    await pass(READY_POLL_MS);
    expect(state.listCalls).toBe(lists + 1);

    // Past 59 minutes it ends without a word.
    await pass(15 * 60_000);
    expect(modelWatches(storage)).toEqual([]);
    expect(screen.getAllByText("Model Widget isn't ready yet")).toHaveLength(1);
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('names a model renamed while its deploy is watched by the new name when it is ready', async () => {
  vi.useFakeTimers();
  try {
    const { state, storage } = editing([readyRecord(Date.now())]);
    await pass(0);
    await act(async () => {
      await submitWrite({ ...edit, name: 'Widget Pro' }, async () => undefined);
    });
    expect(screen.getByText('Changes to model Widget Pro saved to Git')).toBeInTheDocument();
    expect(modelWatches(storage)).toMatchObject([{ key: 'r1', stage: 'ready' }]);

    state.model = pendingOnSiteB();
    state.model.status!.clusters = [runningOnSiteB()];
    await pass(READY_POLL_MS);
    expect(screen.getByText('Model Widget Pro is ready on site-b')).toBeInTheDocument();
    expect(screen.queryByText(/^Model Widget is/)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('warns, by its new name, that a model renamed during its deploy runs but MaaS failed to publish it', async () => {
  vi.useFakeTimers();
  try {
    const { state } = editing([readyRecord(Date.now())]);
    await pass(0);
    await act(async () => {
      await submitWrite({ ...edit, name: 'Widget Pro' }, async () => undefined);
    });

    // The backend calls the whole model Failed: it runs on site-b, but MaaS failed on site-a.
    state.model = pendingOnSiteB();
    state.model.status!.phase = ModelPhase.FAILED;
    state.model.status!.reason = 'Failed';
    state.model.status!.maas = ModelMaasState.FAILED;
    state.model.status!.ingress = [
      create(ModelIngressStatusSchema, {
        cluster: 'site-a',
        state: ModelMaasState.FAILED,
        message: 'HTTPRoute rejected by the gateway',
      }),
    ];
    state.model.status!.clusters = [runningOnSiteB()];
    await pass(READY_POLL_MS);
    expect(screen.getByText("Model Widget Pro is running but isn't available to users")).toBeInTheDocument();
    expect(screen.queryByText(/Unable to deploy|is ready|^Model Widget is/)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['not ready', false, "Model Widget Pro isn't ready yet"],
  ['unknown, its last read failed', true, 'Unable to confirm model Widget Pro is ready'],
])(
  'names a model renamed while its deploy is watched by the new name when its 30 minutes run out (%s), after a reload',
  async (_, failing, title) => {
    vi.useFakeTimers();
    try {
      // Resumed after a reload with one check left, the rename recorded on the watch.
      const renamed = {
        ...readyRecord(Date.now() - READY_MS + READY_POLL_MS / 2),
        edit: { name: 'Widget Pro', since: Date.now() - 60_000 },
      };
      const { state } = editing([renamed]);
      state.failing = failing;
      await pass(0);
      await pass(READY_POLL_MS);
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.queryByText(/model Widget is|Model Widget isn't/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("replaces an edited model's watch on the next edit, and stops it when the model is deleted", async () => {
  const { storage } = editing();
  await waitFor(() => expect(submitWrite).toBeDefined());
  await act(async () => {
    await submitWrite(edit, async () => undefined);
  });
  const [first] = modelWatches(storage);
  expect(first).toMatchObject({ stage: 'changes' });
  await act(async () => {
    await submitWrite({ ...edit, version: 2 }, async () => undefined);
  });
  const watches = modelWatches(storage);
  expect(watches).toMatchObject([{ stage: 'changes' }]);
  expect(watches[0].key).not.toBe(first.key);

  await act(async () => {
    await submitWrite({ ...edit, op: 'delete' }, async () => undefined);
  });
  expect(modelWatches(storage)).toEqual([]);
});

it('resumes the watches an earlier console kept, and drops a record of a shape it never writes', async () => {
  vi.useFakeTimers();
  try {
    // As the console before subscription watches kept them: a deploy's readiness watch with its
    // last seen status, and a subscription create being read back (no history, no edit, matched by
    // id alone back then); and a record without a kind, which no console writes.
    const since = Date.now();
    const deploy = { ...readyRecord(since), key: 'old-model', id: 'team-a', status: '["Pending"]' };
    const readback = {
      key: 'old-sub',
      subject: 'subscription',
      op: 'create',
      id: 'team-a',
      name: 'Team A',
      stage: 'readback',
      since,
    };
    const kindless = { key: 'odd', op: 'create', id: 'team-a', name: 'Team A', stage: 'ready', since };
    const storage = memoryStorage({ [watchesKey('dev-user')]: JSON.stringify([deploy, readback, kindless]) });
    const { transport } = fakeClients({
      models: { get: () => ({ object: pendingOnSiteB() }) },
      subscriptions: { get: () => teamA('Pending') },
    });
    render(
      <BackendProvider transport={transport} checkSession={() => undefined}>
        <NotificationsProvider storage={storage.get} owner="dev-user">
          <NotificationWatcherProvider>
            <BackgroundWritesProvider storage={storage.get} owner="dev-user">
              <Titles />
            </BackgroundWritesProvider>
          </NotificationWatcherProvider>
        </NotificationsProvider>
      </BackendProvider>,
    );
    await pass(0);
    await pass(1);
    // The read-back confirms the create, which starts the subscription's readiness watch; the
    // deploy's watch of the model with the same id goes on beside it.
    expect(screen.getByText('Subscription Team A saved to Git')).toBeInTheDocument();
    const kept = JSON.parse(storage.values.get(watchesKey('dev-user')) ?? '[]') as {
      key: string;
      subject: string;
      stage: string;
    }[];
    expect(kept.map((r) => [r.subject, r.stage])).toEqual([
      ['model', 'ready'],
      ['subscription', 'ready'],
    ]);
    expect(kept[0].key).toBe('old-model');
    expect(kept.some((r) => r.key === 'odd')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * Subscription team-a as Subscriptions/Get answers it: its phase, from the clusters' reports in the
 * catalog's Argo CD Applications, and its authorization policy's (maasPhase and
 * withAuthPolicyStatus in the backend's internal/servers/subscriptions_git.go).
 */
const teamA = (phase: string, policyPhase = phase) => ({
  object: create(SubscriptionSchema, {
    id: 'team-a',
    metadata: { name: 'team-a', version: 1 },
    spec: { organization: { id: 'acme' }, owner: { groups: ['admins'] } },
    status: { phase },
  }),
  authPolicies: [create(AuthPolicySchema, { id: 'team-a-policy', phase: policyPhase })],
});

/** The Subscriptions list and a subscription's page as the pages show them, neither polling on its own. */
const SubscriptionPages: React.FC = () => {
  const { data: listed } = useQuery(listSubscriptions, {});
  const { data: viewed } = useQuery(getSubscription, { id: 'team-a' }, { refetchInterval: false });
  const phase = listed?.items.find((s) => s.id === 'team-a')?.status?.phase;
  return (
    <>
      <p>{`list ${phase || 'none'}`}</p>
      <p>{`page ${viewed?.object?.status?.phase || 'none'}`}</p>
    </>
  );
};

type SubscriptionState = {
  answer: ReturnType<typeof teamA>;
  gone: boolean;
  gets: number;
  lists: number;
  /** Get fails (Unavailable) while set. */
  failing?: boolean;
};

/**
 * The console around subscription team-a, whose status the test changes, or deletes. Given the
 * storage and state of an earlier one (unmounted), it is that console after a reload.
 */
const subscribing = (
  stored: object[] = [],
  reload?: { storage: ReturnType<typeof memoryStorage>; state: SubscriptionState },
) => {
  const state: SubscriptionState = reload?.state ?? { answer: teamA('Pending'), gone: false, gets: 0, lists: 0 };
  const { transport } = fakeClients({
    subscriptions: {
      get: () => {
        state.gets += 1;
        if (state.gone) throw new ConnectError('Subscription "team-a" not found', Code.NotFound);
        if (state.failing) throw new ConnectError('the Git catalog is unreachable', Code.Unavailable);
        return state.answer;
      },
      list: () => {
        state.lists += 1;
        return state.gone ? { items: [], size: 0, total: 0 } : { items: [state.answer.object], size: 1, total: 1 };
      },
    },
  });
  const storage = reload?.storage ?? memoryStorage({ [watchesKey('dev-user')]: JSON.stringify(stored) });
  const { unmount } = render(
    <BackendProvider transport={transport} checkSession={() => undefined}>
      <NotificationsProvider storage={storage.get} owner="dev-user">
        <NotificationWatcherProvider>
          <BackgroundWritesProvider storage={storage.get} owner="dev-user">
            <SubscriptionPages />
            <Titles />
            <Writes />
          </BackgroundWritesProvider>
        </NotificationWatcherProvider>
      </NotificationsProvider>
    </BackendProvider>,
  );
  return { state, storage, unmount };
};

const createTeamA = {
  subject: 'subscription',
  op: 'create',
  id: 'team-a',
  name: 'Team A',
  organization: 'Acme Robotics',
} as const;
const editTeamA = { subject: 'subscription', op: 'update', id: 'team-a', name: 'Team A', version: 1 } as const;

/** The watches that follow a subscription's status, as the tab keeps them. */
const subscriptionWatches = (storage: ReturnType<typeof memoryStorage>) =>
  (
    JSON.parse(storage.values.get(watchesKey('dev-user')) ?? '[]') as {
      key: string;
      subject: string;
      id: string;
      stage: string;
    }[]
  ).filter((r) => r.subject === 'subscription' && (r.stage === 'ready' || r.stage === 'changes'));

/** A created subscription's readiness watch, as the tab keeps it across a reload. */
const activeRecord = (since: number) => ({
  key: 's1',
  subject: 'subscription',
  op: 'create',
  id: 'team-a',
  name: 'Team A',
  organization: 'Acme Robotics',
  stage: 'ready',
  since,
});

describe('a subscription watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a created subscription from Pending to Active: says so once, refreshes the pages, and stops polling', async () => {
    const { state, storage } = subscribing();
    await pass(0);
    await act(async () => {
      expect(await submitWrite(createTeamA, async () => undefined)).toBe('done');
    });
    await pass(0);
    expect(screen.getByText('Subscription Team A saved to Git')).toBeInTheDocument();
    expect(subscriptionWatches(storage)).toMatchObject([{ stage: 'ready' }]);
    await pass(1);
    expect(screen.getByText('list Pending')).toBeInTheDocument();
    const lists = state.lists;

    // A poll that sees the same status leaves the pages alone.
    await pass(READY_POLL_MS);
    expect(state.lists).toBe(lists);

    // The ingress clusters apply the subscription and its policy.
    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(screen.getAllByText('Subscription Team A is active')).toHaveLength(1);
    await pass(1);
    expect(state.lists).toBe(lists + 1);
    expect(screen.getByText('list Active')).toBeInTheDocument();
    expect(screen.getByText('page Active')).toBeInTheDocument();
    expect(subscriptionWatches(storage)).toEqual([]);

    // Nothing polls any more.
    const gets = state.gets;
    await pass(READY_MS);
    expect(state.gets).toBe(gets);
    expect(screen.getAllByText('Subscription Team A is active')).toHaveLength(1);
  });

  it("refreshes the pages when a created subscription's policy turns Active before the subscription does", async () => {
    const { state } = subscribing();
    await pass(0);
    await act(async () => {
      await submitWrite(createTeamA, async () => undefined);
    });
    await pass(1);
    const lists = state.lists;
    state.answer = teamA('Pending', 'Active');
    await pass(READY_POLL_MS);
    expect(state.lists).toBe(lists + 1);
    expect(screen.queryByText('Subscription Team A is active')).not.toBeInTheDocument();
  });

  it("judges by the policy's phase from Subscriptions/Get, which List doesn't carry", async () => {
    const { state } = subscribing([activeRecord(Date.now())]);
    // The list shows the subscription Active; only Get says its policy isn't yet.
    state.answer = teamA('Active', 'Pending');
    await pass(0);
    await pass(READY_POLL_MS);
    expect(screen.getByText('list Active')).toBeInTheDocument();
    expect(screen.queryByText('Subscription Team A is active')).not.toBeInTheDocument();
    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(screen.getByText('Subscription Team A is active')).toBeInTheDocument();
  });

  it("warns that a created subscription isn't active yet when its 30 minutes run out", async () => {
    // Resumed after a reload with one check left inside its 30 minutes.
    const { storage } = subscribing([activeRecord(Date.now() - READY_MS + READY_POLL_MS / 2)]);
    await pass(0);
    expect(screen.queryByText("Subscription Team A isn't active yet")).not.toBeInTheDocument();
    await pass(READY_POLL_MS);
    expect(screen.getByText("Subscription Team A isn't active yet")).toBeInTheDocument();
    expect(subscriptionWatches(storage)).toEqual([]);
  });

  it("says at the deadline, after a reload, that an ingress cluster reports its policy failed, in the policy's words", async () => {
    const first = subscribing([activeRecord(Date.now())]);
    // Subscriptions/Get: the policy's Ready condition says where it failed (withAuthPolicyStatus).
    first.state.answer = {
      ...teamA('Active'),
      authPolicies: [
        create(AuthPolicySchema, {
          id: 'team-a-policy',
          phase: 'Degraded',
          conditions: [
            {
              type: 'Ready',
              status: ConditionStatus.FALSE,
              reason: 'Failed',
              message: 'Failed on site-a; ready on site-b',
            },
          ],
        }),
      ],
    };
    await pass(0);
    expect(subscriptionWatches(first.storage)).toMatchObject([
      { key: 's1', lastVerdict: 'policyDegraded', lastMessage: 'Failed on site-a; ready on site-b' },
    ]);
    first.unmount();

    // After the reload the backend can't read the clusters' reports: the kept status is what it says.
    first.state.answer = teamA('');
    const second = subscribing([], first);
    await pass(READY_MS);
    expect(screen.getAllByText("Subscription Team A isn't active")).toHaveLength(1);
    expect(storedNotifications(second.storage)).toContainEqual(
      expect.objectContaining({
        title: "Subscription Team A isn't active",
        message:
          "An ingress cluster reports its authorization policy failed: Failed on site-a; ready on site-b. Open the subscription to check the policy's status.",
      }),
    );
    expect(subscriptionWatches(second.storage)).toEqual([]);
  });

  it("resumes a created subscription's watch after a reload", async () => {
    const { state, storage } = subscribing([activeRecord(Date.now())]);
    await pass(0);
    expect(state.gets).toBeGreaterThan(0);
    expect(subscriptionWatches(storage)).toMatchObject([{ key: 's1', stage: 'ready' }]);
    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(screen.getByText('Subscription Team A is active')).toBeInTheDocument();
    expect(subscriptionWatches(storage)).toEqual([]);
  });

  it('stops silently when no ingress cluster reports a status, without claiming anything', async () => {
    const { state, storage } = subscribing();
    state.answer = teamA('');
    await pass(0);
    await act(async () => {
      await submitWrite(createTeamA, async () => undefined);
    });
    // The read as the write lands, then two more.
    await pass(0);
    await pass(READY_POLL_MS);
    expect(subscriptionWatches(storage)).toHaveLength(1);
    await pass(READY_POLL_MS);
    expect(subscriptionWatches(storage)).toEqual([]);
    const gets = state.gets;
    await pass(READY_MS);
    expect(state.gets).toBe(gets);
    expect(screen.getByRole('list', { name: 'Titles' }).children).toHaveLength(1);
    expect(screen.getByText('Subscription Team A saved to Git')).toBeInTheDocument();
  });

  it('counts empty reads across a reload, and stops on the third in a row', async () => {
    const first = subscribing([activeRecord(Date.now())]);
    first.state.answer = teamA('');
    // Two empty reads: as the console starts, and one poll later.
    await pass(0);
    await pass(READY_POLL_MS);
    expect(subscriptionWatches(first.storage)).toMatchObject([{ key: 's1', empties: 2 }]);
    first.unmount();

    // The reload's first read is the third empty one in a row.
    const second = subscribing([], first);
    await pass(0);
    expect(subscriptionWatches(second.storage)).toEqual([]);
    const gets = second.state.gets;
    await pass(READY_MS);
    expect(second.state.gets).toBe(gets);
    expect(screen.getByRole('list', { name: 'Titles' }).children).toHaveLength(0);
  });

  it("takes a failed read for the end of a run of empty reads, across a reload, and says it can't confirm at the deadline", async () => {
    const first = subscribing([activeRecord(Date.now())]);
    first.state.answer = teamA('');
    // Two empty reads, then a failed one: the run of empty reads starts again, in storage too.
    await pass(0);
    await pass(READY_POLL_MS);
    expect(subscriptionWatches(first.storage)).toMatchObject([{ key: 's1', empties: 2 }]);
    first.state.failing = true;
    await pass(READY_POLL_MS);
    expect(subscriptionWatches(first.storage)).toMatchObject([{ key: 's1', empties: 0 }]);
    first.unmount();

    // After the reload: two empty reads go on, not stop, then empty and failed reads take turns.
    first.state.failing = false;
    const second = subscribing([], first);
    await pass(0);
    await pass(READY_POLL_MS);
    expect(subscriptionWatches(second.storage)).toMatchObject([{ key: 's1', empties: 2 }]);
    for (let poll = 0; poll < READY_MS / READY_POLL_MS; poll += 1) {
      second.state.failing = !second.state.failing;
      await pass(READY_POLL_MS);
    }
    expect(subscriptionWatches(second.storage)).toEqual([]);
    expect(screen.getAllByText('Unable to confirm subscription Team A is active')).toHaveLength(1);
  });

  it('goes on through empty reads once it has found a status: Pending, then empty, then Active', async () => {
    const { state, storage } = subscribing([activeRecord(Date.now())]);
    await pass(0);
    // The backend can't read the clusters' reports for a while (more than three polls).
    state.answer = teamA('');
    await pass(4 * READY_POLL_MS);
    expect(subscriptionWatches(storage)).toMatchObject([{ key: 's1', lastVerdict: 'subscription' }]);
    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(screen.getAllByText('Subscription Team A is active')).toHaveLength(1);
    expect(subscriptionWatches(storage)).toEqual([]);
  });

  it('keeps its outcome through a reload at any point of its last step, and says it once', async () => {
    // A storage that copies itself after every write while armed: each copy is what a reload
    // right after that write would find.
    const base = memoryStorage({ [watchesKey('dev-user')]: JSON.stringify([activeRecord(Date.now())]) });
    const snapshots: Record<string, string>[] = [];
    let armed = false;
    const inner = base.get();
    const recorded = (write: () => void) => {
      write();
      if (armed) snapshots.push(Object.fromEntries(base.values));
    };
    const storage: Storage = {
      get length() {
        return inner.length;
      },
      clear: () => inner.clear(),
      getItem: (key) => inner.getItem(key),
      key: (index) => inner.key(index),
      removeItem: (key) => recorded(() => inner.removeItem(key)),
      setItem: (key, value) => recorded(() => inner.setItem(key, value)),
    };
    const first = subscribing([], {
      storage: { get: () => storage, values: base.values },
      state: { answer: teamA('Pending'), gone: false, gets: 0, lists: 0 },
    });
    await pass(0);
    armed = true;
    first.state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    await pass(1);
    armed = false;
    expect(screen.getAllByText('Subscription Team A is active')).toHaveLength(1);
    first.unmount();
    expect(snapshots.length).toBeGreaterThan(1);

    for (const snapshot of snapshots) {
      const reloaded = subscribing([], {
        storage: memoryStorage(snapshot),
        state: { answer: teamA('Active'), gone: false, gets: 0, lists: 0 },
      });
      await pass(0);
      await pass(READY_POLL_MS);
      expect(screen.getAllByText('Subscription Team A is active')).toHaveLength(1);
      expect(subscriptionWatches(reloaded.storage)).toEqual([]);
      reloaded.unmount();
    }
  });

  it('watches a subscription once, whatever earlier watch of the id still runs, apart from a model of the same id', async () => {
    const modelOfTheSameId = { ...readyRecord(Date.now()), key: 'm1', id: 'team-a' };
    const { storage } = subscribing([activeRecord(Date.now()), modelOfTheSameId]);
    await pass(0);
    await act(async () => {
      await submitWrite(createTeamA, async () => undefined);
    });
    const watches = subscriptionWatches(storage);
    expect(watches).toMatchObject([{ stage: 'ready', id: 'team-a' }]);
    expect(watches[0].key).not.toBe('s1');
    const kept = JSON.parse(storage.values.get(watchesKey('dev-user')) ?? '[]') as { key: string }[];
    expect(kept.map((r) => r.key)).toContain('m1');
  });

  it('follows an edited subscription silently: refreshes the pages on a phase change, never says it is active', async () => {
    const { state, storage } = subscribing();
    await pass(0);
    await act(async () => {
      expect(await submitWrite(editTeamA, async () => undefined)).toBe('done');
    });
    await pass(1);
    expect(screen.getByText('Changes to subscription Team A saved to Git')).toBeInTheDocument();
    expect(subscriptionWatches(storage)).toMatchObject([{ stage: 'changes' }]);
    const lists = state.lists;

    await pass(READY_POLL_MS);
    expect(state.lists).toBe(lists);

    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(state.lists).toBe(lists + 1);
    await pass(1);
    expect(screen.getByText('list Active')).toBeInTheDocument();
    expect(screen.getByText('page Active')).toBeInTheDocument();
    expect(screen.queryByText(/is active/)).not.toBeInTheDocument();

    // After 30 minutes the watch ends without a word.
    await pass(READY_MS);
    expect(subscriptionWatches(storage)).toEqual([]);
    expect(screen.getByRole('list', { name: 'Titles' }).children).toHaveLength(1);
  });

  it('follows an edit made at 29 minutes until 59 minutes, after saying once that the subscription is active', async () => {
    const { state, storage } = subscribing([activeRecord(Date.now())]);
    await pass(0);
    await pass(29 * 60_000);
    await act(async () => {
      await submitWrite(editTeamA, async () => undefined);
    });
    expect(subscriptionWatches(storage)).toMatchObject([{ key: 's1', stage: 'ready', edit: { name: 'Team A' } }]);

    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(screen.getAllByText('Subscription Team A is active')).toHaveLength(1);
    expect(subscriptionWatches(storage)).toMatchObject([{ stage: 'changes' }]);

    // At about 45 minutes the phase changes: the pages refetch.
    await pass(15 * 60_000);
    let lists = state.lists;
    state.answer = teamA('Pending');
    await pass(READY_POLL_MS);
    expect(state.lists).toBe(lists + 1);
    // At about 58 minutes, again.
    await pass(13 * 60_000);
    lists = state.lists;
    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(state.lists).toBe(lists + 1);

    // Past 59 minutes, 30 after the edit, it ends without a word.
    await pass(2 * 60_000);
    expect(subscriptionWatches(storage)).toEqual([]);
    expect(screen.getAllByText('Subscription Team A is active')).toHaveLength(1);
    expect(screen.queryByText(/isn't active/)).not.toBeInTheDocument();
  });

  it('names a subscription renamed while its create is watched by the new name when it is active', async () => {
    const { state, storage } = subscribing([activeRecord(Date.now())]);
    await pass(0);
    await act(async () => {
      await submitWrite({ ...editTeamA, name: 'Team Alpha' }, async () => undefined);
    });
    expect(screen.getByText('Changes to subscription Team Alpha saved to Git')).toBeInTheDocument();
    expect(subscriptionWatches(storage)).toMatchObject([{ key: 's1', stage: 'ready' }]);

    state.answer = teamA('Active');
    await pass(READY_POLL_MS);
    expect(screen.getByText('Subscription Team Alpha is active')).toBeInTheDocument();
    expect(screen.queryByText(/^Subscription Team A /)).not.toBeInTheDocument();
  });

  it.each([
    ['not active', false, "Subscription Team Alpha isn't active yet"],
    ['unknown, its last read failed', true, 'Unable to confirm subscription Team Alpha is active'],
  ])(
    'names a subscription renamed while its create is watched by the new name when its 30 minutes run out (%s), after a reload',
    async (_, failing, title) => {
      // Resumed after a reload with one check left, the rename recorded on the watch.
      const renamed = {
        ...activeRecord(Date.now() - READY_MS + READY_POLL_MS / 2),
        edit: { name: 'Team Alpha', since: Date.now() - 60_000 },
      };
      const { state } = subscribing([renamed]);
      state.failing = failing;
      await pass(0);
      // A failed read takes longer: the watch's Get shares the subscription page's, which the
      // query cache retries (1 s, 2 s, 4 s) before it fails, so the last poll comes a poll later.
      await pass(2 * READY_POLL_MS);
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.queryByText(/subscription Team A |Subscription Team A /)).not.toBeInTheDocument();
    },
  );

  it("adds no watch to an edited subscription whose create's readiness watch still runs", async () => {
    const { storage } = subscribing([activeRecord(Date.now())]);
    await pass(0);
    await act(async () => {
      await submitWrite(editTeamA, async () => undefined);
    });
    expect(subscriptionWatches(storage)).toMatchObject([{ key: 's1', stage: 'ready' }]);
  });

  it("stops a subscription's watch at once when the console deletes it", async () => {
    const { state, storage } = subscribing([activeRecord(Date.now())]);
    await pass(0);
    await act(async () => {
      await submitWrite({ ...editTeamA, op: 'delete' }, async () => undefined);
    });
    expect(subscriptionWatches(storage)).toEqual([]);
    state.gone = true;
    const gets = state.gets;
    await pass(READY_MS);
    // The pages' refetch after the delete, and no read of the watch's.
    expect(state.gets).toBeLessThanOrEqual(gets + 1);
    expect(screen.queryByText(/active/)).not.toBeInTheDocument();
  });

  it('ends quietly when someone else deletes the subscription it follows', async () => {
    const { state, storage } = subscribing([activeRecord(Date.now())]);
    await pass(0);
    state.gone = true;
    await pass(READY_POLL_MS);
    expect(subscriptionWatches(storage)).toEqual([]);
    await pass(READY_MS);
    expect(screen.getByRole('list', { name: 'Titles' }).children).toHaveLength(0);
  });
});

/** Cluster site-b as Clusters/Get answers it: its membership and the ready Policy's compliance. */
const siteB = (member: boolean, provisioning: string) =>
  create(ManagedClusterSchema, {
    id: 'site-b',
    metadata: { name: 'site-b', version: 7, labels: member ? { 'ai-grid/enabled': 'true' } : {} },
    status: { aiGridMember: member, provisioning },
  });

/** The Clusters list as its page shows it, without a poll of its own: it refetches only when told to. */
const ClusterList: React.FC = () => {
  const { data } = useQuery(listClusters, {});
  const cluster = data?.items.find((c) => c.id === 'site-b');
  return <p>{`list ${cluster?.status?.provisioning || 'none'}`}</p>;
};

/** The cluster's page, without a poll of its own: its reload is the test's to start (reloadCluster). */
let reloadCluster: () => void = () => undefined;
const ClusterPage: React.FC = () => {
  const { refetch } = useQuery(getCluster, { id: 'site-b' }, { refetchInterval: false });
  useEffect(() => {
    reloadCluster = () => void refetch();
  }, [refetch]);
  return null;
};

/** Each notification's message, to read the bodies by. */
const Messages: React.FC = () => {
  const { notifications } = useNotifications();
  return (
    <ul aria-label="Messages">
      {notifications.map((n) => (
        <li key={n.id}>{n.message ?? ''}</li>
      ))}
    </ul>
  );
};

type ClusterState = {
  cluster: ReturnType<typeof siteB>;
  gone: boolean;
  /** Get fails (Unavailable) while set. */
  failing: boolean;
  gets: number;
  lists: number;
};

/**
 * The console around cluster site-b, whose status the test changes. Given the storage and state of
 * an earlier one (unmounted), it is that console after a reload.
 */
const clustering = (
  stored: object[] = [],
  reload?: { storage: ReturnType<typeof memoryStorage>; state: ClusterState },
) => {
  const state: ClusterState = reload?.state ?? {
    cluster: siteB(true, 'Pending'),
    gone: false,
    failing: false,
    gets: 0,
    lists: 0,
  };
  const { transport } = fakeClients({
    clusters: {
      get: () => {
        state.gets += 1;
        if (state.gone) throw new ConnectError('cluster "site-b" not found', Code.NotFound);
        if (state.failing) throw new ConnectError('the hub is unreachable', Code.Unavailable);
        return { object: state.cluster };
      },
      list: () => {
        state.lists += 1;
        return { items: state.gone ? [] : [state.cluster], size: 1, total: 1 };
      },
    },
  });
  const storage = reload?.storage ?? memoryStorage({ [watchesKey('dev-user')]: JSON.stringify(stored) });
  const { unmount } = render(
    <BackendProvider transport={transport} checkSession={() => undefined}>
      <NotificationsProvider storage={storage.get} owner="dev-user">
        <NotificationWatcherProvider>
          <BackgroundWritesProvider storage={storage.get} owner="dev-user">
            <ClusterList />
            <ClusterPage />
            <Titles />
            <Messages />
            <Writes />
          </BackgroundWritesProvider>
        </NotificationWatcherProvider>
      </NotificationsProvider>
    </BackendProvider>,
  );
  return { state, storage, unmount };
};

const addSiteB = { subject: 'cluster', op: 'add', id: 'site-b', name: 'site-b', role: 'inference' } as const;
const removeSiteB = { subject: 'cluster', op: 'remove', id: 'site-b', name: 'site-b' } as const;

/** The cluster watches the tab keeps. */
const clusterWatches = (storage: ReturnType<typeof memoryStorage>) =>
  (
    JSON.parse(storage.values.get(watchesKey('dev-user')) ?? '[]') as {
      key: string;
      subject: string;
      op: string;
      stage: string;
    }[]
  ).filter((r) => r.subject === 'cluster');

/** A cluster's provisioning watch as the tab keeps it across a reload. */
const provisioningRecord = (since: number) => ({ ...addSiteB, key: 'c1', stage: 'ready', since });

describe('a cluster watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a cluster added to AI grid until it is provisioned: says so once, refreshes the list, and stops polling', async () => {
    const { state, storage } = clustering();
    await pass(0);
    act(() => followWrite(addSiteB));
    await pass(0);
    expect(screen.getByText('Cluster site-b added to AI grid')).toBeInTheDocument();
    expect(
      screen.getByText(
        "The hub is installing what its Inference role needs. You'll be notified when it's provisioned.",
      ),
    ).toBeInTheDocument();
    expect(clusterWatches(storage)).toMatchObject([{ op: 'add', stage: 'ready' }]);
    await pass(1);
    expect(screen.getByText('list Pending')).toBeInTheDocument();
    const lists = state.lists;

    // A poll that sees the same status leaves the list alone.
    await pass(CLUSTER_POLL_MS);
    expect(state.lists).toBe(lists);

    // The hub's ready check runs and finds OpenShift AI still installing: the list shows it at once.
    state.cluster = siteB(true, 'NonCompliant');
    await pass(CLUSTER_POLL_MS);
    await pass(1);
    expect(state.lists).toBe(lists + 1);
    expect(screen.getByText('list NonCompliant')).toBeInTheDocument();
    expect(screen.queryByText('Cluster site-b is provisioned')).not.toBeInTheDocument();

    state.cluster = siteB(true, 'Compliant');
    await pass(CLUSTER_POLL_MS);
    expect(screen.getAllByText('Cluster site-b is provisioned')).toHaveLength(1);
    await pass(1);
    expect(state.lists).toBe(lists + 2);
    expect(screen.getByText('list Compliant')).toBeInTheDocument();
    expect(clusterWatches(storage)).toEqual([]);

    // Nothing polls any more.
    const gets = state.gets;
    await pass(CLUSTER_MS);
    expect(state.gets).toBe(gets);
    expect(screen.getAllByText('Cluster site-b is provisioned')).toHaveLength(1);
  });

  it.each([
    ['inference', 'The hub reports OpenShift AI ready on it. You can select it when you deploy a model.'],
    [
      'ingress',
      "The hub reports OpenShift AI ready on it. Whether users can reach models through it depends on MaaS, which the hub's check doesn't cover.",
    ],
    [
      'combined',
      "The hub reports OpenShift AI ready on it, and you can select it when you deploy a model. Whether users can reach models through it depends on MaaS, which the hub's check doesn't cover.",
    ],
  ] as const)('says what a provisioned %s cluster can do, and no more', async (role, body) => {
    const { state } = clustering();
    await pass(0);
    act(() => followWrite({ ...addSiteB, role }));
    await pass(0);
    state.cluster = siteB(true, 'Compliant');
    await pass(CLUSTER_POLL_MS);
    expect(screen.getByText('Cluster site-b is provisioned')).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
  });

  it('follows an edit that sets the role a cluster lacked until it is provisioned', async () => {
    const { state, storage } = clustering();
    await pass(0);
    act(() => followWrite({ subject: 'cluster', op: 'update', id: 'site-b', name: 'site-b', role: 'combined' }));
    await pass(0);
    expect(screen.getByText('Changes to cluster site-b saved')).toBeInTheDocument();
    expect(
      screen.getByText(
        "The hub is installing what its Ingress and inference role needs. You'll be notified when it's provisioned.",
      ),
    ).toBeInTheDocument();
    expect(clusterWatches(storage)).toMatchObject([{ op: 'update', stage: 'ready' }]);
    state.cluster = siteB(true, 'Compliant');
    await pass(CLUSTER_POLL_MS);
    expect(screen.getByText('Cluster site-b is provisioned')).toBeInTheDocument();
  });

  it('adds no watch for an edit of the location label alone, and leaves a running one alone', async () => {
    const { state, storage } = clustering([provisioningRecord(Date.now())]);
    await pass(0);
    act(() => followWrite({ subject: 'cluster', op: 'update', id: 'site-b', name: 'site-b' }));
    await pass(0);
    expect(screen.getByText('Changes to cluster site-b saved')).toBeInTheDocument();
    // Nothing installs, so nothing is promised.
    expect(screen.getByRole('list', { name: 'Messages' }).textContent).toBe('');
    expect(clusterWatches(storage)).toMatchObject([{ key: 'c1', op: 'add' }]);
    state.cluster = siteB(true, 'Compliant');
    await pass(CLUSTER_POLL_MS);
    expect(screen.getByText('Cluster site-b is provisioned')).toBeInTheDocument();
  });

  it('starts no watch for a location-only edit of a cluster nobody watches', async () => {
    const { state, storage } = clustering();
    await pass(0);
    act(() => followWrite({ subject: 'cluster', op: 'update', id: 'site-b', name: 'site-b' }));
    await pass(0);
    expect(clusterWatches(storage)).toEqual([]);
    const gets = state.gets;
    state.cluster = siteB(true, 'Compliant');
    await pass(CLUSTER_MS);
    expect(state.gets).toBe(gets);
    expect(screen.queryByText('Cluster site-b is provisioned')).not.toBeInTheDocument();
  });

  it("warns that a cluster isn't provisioned yet when its 60 minutes run out, pointing to its page", async () => {
    // Resumed after a reload with one check left inside its 60 minutes.
    const { state, storage } = clustering([provisioningRecord(Date.now() - CLUSTER_MS + CLUSTER_POLL_MS / 2)]);
    state.cluster = siteB(true, 'NonCompliant');
    await pass(0);
    expect(screen.queryByText("Cluster site-b isn't provisioned yet")).not.toBeInTheDocument();
    await pass(CLUSTER_POLL_MS);
    expect(screen.getByText("Cluster site-b isn't provisioned yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "It isn't provisioned 60 minutes after it was added to the AI grid. Open the cluster to check its status.",
      ),
    ).toBeInTheDocument();
    expect(clusterWatches(storage)).toEqual([]);
  });

  it("says it can't confirm a cluster is provisioned when its last read at the deadline fails", async () => {
    const { state } = clustering([provisioningRecord(Date.now() - CLUSTER_MS + CLUSTER_POLL_MS / 2)]);
    state.cluster = siteB(true, 'NonCompliant');
    await pass(0);
    state.failing = true;
    await pass(CLUSTER_POLL_MS);
    expect(screen.getByText('Unable to confirm cluster site-b is provisioned')).toBeInTheDocument();
    expect(screen.queryByText("Cluster site-b isn't provisioned yet")).not.toBeInTheDocument();
  });

  it("stops silently when the hub's ready check never lists the cluster, without claiming anything", async () => {
    const { state, storage } = clustering();
    state.cluster = siteB(true, '');
    await pass(0);
    act(() => followWrite(addSiteB));
    // The read as the write lands, then two more.
    await pass(0);
    await pass(CLUSTER_POLL_MS);
    expect(clusterWatches(storage)).toHaveLength(1);
    await pass(CLUSTER_POLL_MS);
    expect(clusterWatches(storage)).toEqual([]);
    const gets = state.gets;
    await pass(CLUSTER_MS);
    expect(state.gets).toBe(gets);
    expect(screen.getByRole('list', { name: 'Titles' }).children).toHaveLength(1);
  });

  it("resumes a cluster's watch after a reload, and says it is provisioned once", async () => {
    const first = clustering();
    await pass(0);
    act(() => followWrite(addSiteB));
    await pass(0);
    first.unmount();

    // The page reloads; the hub finishes meanwhile.
    first.state.cluster = siteB(true, 'Compliant');
    const second = clustering([], first);
    await pass(0);
    expect(screen.getAllByText('Cluster site-b is provisioned')).toHaveLength(1);
    expect(clusterWatches(second.storage)).toEqual([]);
    await pass(CLUSTER_MS);
    expect(screen.getAllByText('Cluster site-b is provisioned')).toHaveLength(1);
  });

  it('follows a removed cluster until the hub no longer includes it, then says it left', async () => {
    const { state, storage } = clustering();
    // Membership is the label the remove dropped; the ready check still lists the cluster.
    state.cluster = siteB(false, 'Compliant');
    await pass(0);
    act(() => followWrite(removeSiteB));
    await pass(0);
    expect(screen.getByText('Cluster site-b removed from AI grid')).toBeInTheDocument();
    expect(
      screen.getByText("You'll be notified when the hub no longer includes it in the AI grid."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Cluster site-b left AI grid')).not.toBeInTheDocument();
    expect(clusterWatches(storage)).toMatchObject([{ op: 'remove', stage: 'ready' }]);
    await pass(1);
    const lists = state.lists;

    state.cluster = siteB(false, '');
    await pass(CLUSTER_POLL_MS);
    expect(screen.getAllByText('Cluster site-b left AI grid')).toHaveLength(1);
    await pass(1);
    expect(state.lists).toBe(lists + 1);
    expect(screen.getByText('list none')).toBeInTheDocument();
    expect(clusterWatches(storage)).toEqual([]);
  });

  it("reads the cluster at once though the page's own reload cancels the fetch the watch joined", async () => {
    const { state } = clustering();
    state.cluster = siteB(false, '');
    await pass(0);
    // The page hands the write over, then reloads the cluster, as ClusterDetailsPage does.
    act(() => {
      followWrite(removeSiteB);
      reloadCluster();
    });
    await pass(1);
    expect(screen.getByText('Cluster site-b left AI grid')).toBeInTheDocument();
  });

  it("warns that a removed cluster hasn't left when its 60 minutes run out", async () => {
    const { state } = clustering([{ ...removeSiteB, key: 'c2', stage: 'ready', since: Date.now() - CLUSTER_MS + 1 }]);
    state.cluster = siteB(false, 'Compliant');
    await pass(0);
    await pass(CLUSTER_POLL_MS);
    expect(screen.getByText("Cluster site-b hasn't left AI grid yet")).toBeInTheDocument();
  });

  it('keeps one watch per cluster: a remove replaces the provisioning watch, and nothing more is said of it', async () => {
    const { state, storage } = clustering([provisioningRecord(Date.now())]);
    await pass(0);
    state.cluster = siteB(false, 'Compliant');
    act(() => followWrite(removeSiteB));
    await pass(0);
    expect(clusterWatches(storage)).toMatchObject([{ op: 'remove' }]);
    state.cluster = siteB(false, '');
    await pass(CLUSTER_POLL_MS);
    expect(screen.getByText('Cluster site-b left AI grid')).toBeInTheDocument();
    expect(screen.queryByText(/provisioned/)).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't provisioned/)).not.toBeInTheDocument();
  });

  it('ends quietly when someone else removes the cluster it follows, or the hub detaches it', async () => {
    const { state, storage } = clustering([provisioningRecord(Date.now())]);
    await pass(0);
    state.cluster = siteB(false, '');
    await pass(CLUSTER_POLL_MS);
    expect(clusterWatches(storage)).toEqual([]);
    await pass(CLUSTER_MS);
    expect(screen.getByRole('list', { name: 'Titles' }).children).toHaveLength(0);
  });
});
