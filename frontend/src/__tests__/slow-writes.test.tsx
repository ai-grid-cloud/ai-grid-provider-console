// Writes that outlast their form: the form waits briefly (FORM_WAIT_MS), then leaves as on success
// and the notification center reports how the write ended. The wait is the test's own (formWait),
// ended by hand, and a slow backend is a promise the test settles: nothing here waits on a clock.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Code, ConnectError } from '@connectrpc/connect';
import { MockConsoleService } from '../api/MockConsoleService';
import { create as create_ } from '@bufbuild/protobuf';
import {
  ModelClusterStatusSchema,
  ModelDeploymentState,
  ModelPhase,
  ModelState,
} from '../gen/ai_grid/v1/model_type_pb';
import type { Subscription } from '../gen/ai_grid/v1/subscription_type_pb';
import { watchesKey } from '../notifications/storageKeys';

/** The tab's storage key of the signed-in user's watches, MockConsoleService's dev-user. */
const WATCHES = watchesKey('dev-user');
import { modelObject, modelsOf } from './connectModels';
import { seedSubscriptionsOf, subscriptionsOf } from './connectSubscriptions';
import { blockedStorage, memoryStorage } from './memoryStorage';
import { transportFor } from './connectClusters';
import { deferred } from './render';
import { TestApp } from './TestApp';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/models/ModelDetailsPage';
import '../pages/models/ModelEditPage';
import '../pages/models/ModelWizard';
import '../pages/models/ModelsPage';
import '../pages/subscriptions/CreateSubscriptionPage';
import '../pages/subscriptions/EditSubscriptionPage';
import '../pages/subscriptions/SubscriptionsPage';
import '../pages/subscriptions/ViewSubscriptionPage';

type User = ReturnType<typeof userEvent.setup>;

/** The form's wait, which the test ends with `endWait`, as FORM_WAIT_MS would. */
const formWaits = () => {
  const waiting: (() => void)[] = [];
  return {
    formWait: () => new Promise<void>((resolve) => waiting.push(resolve)),
    endWait: () => act(async () => waiting.shift()?.()),
  };
};

/**
 * A form wait that's already over: every answer, a lost one included, arrives after the hand-off,
 * as one that takes longer than FORM_WAIT_MS does.
 */
const waitOver = () => Promise.resolve();

const renderConsole = (
  path: string,
  service: MockConsoleService,
  formWait: (signal: AbortSignal) => Promise<void>,
  storage = memoryStorage(),
) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TestApp service={service} formWait={formWait} storage={storage.get} />
    </MemoryRouter>,
  );
  return storage;
};

/** The deploy wizard filled for "Widget" on site1, up to its Review step. */
const fillWizard = async (user: User) => {
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const name = await screen.findByTestId('model-name-desc-name');
  await user.clear(name);
  await user.paste('Widget');
  await user.click(screen.getByRole('radio', { name: 'CPU only' }));
  const image = screen.getByRole('textbox', { name: /Runtime image/ });
  await user.clear(image);
  await user.paste('registry.example/runtime:test');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('combobox', { name: 'Clusters' }));
  await user.click(screen.getByRole('option', { name: /^site1( |$)/ }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByTestId('model-review');
};

/** A model "widget" the backend has, at version 1, on site1. */
const widget = (service: MockConsoleService) => {
  const models = modelsOf(service);
  models.models.push(
    modelObject({
      id: 'widget',
      metadata: { name: 'widget', version: 1, annotations: { 'openshift.io/display-name': 'Widget' } },
      spec: {
        model: { uri: 'hf://org/widget', name: '' },
        replicas: 1,
        main: { image: 'registry.example/runtime:test', requests: { cpu: '2', memory: '4Gi' } },
        placement: { labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: ['site1'] }] } },
      },
      status: { reason: 'SavedToGit', placement: { selectedClusters: ['site1'] } },
    }),
  );
  return models;
};

const lostAnswer = () =>
  new ConnectError('The AI grid backend did not respond in time. Try again.', Code.DeadlineExceeded);

/** A toast by its title: PatternFly's toast group is a live region of alerts. */
const toast = (title: string) => screen.findByRole('heading', { name: new RegExp(`alert: ${title}$`) });

describe('deploying a model', () => {
  it('shows progress at once, leaves after the wait, and reports the deploy when the backend answers', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const answer = deferred<void>();
    const create = models.create;
    vi.spyOn(models, 'create').mockImplementation(async (request, context) => {
      await answer.promise;
      return create(request, context);
    });
    const { formWait, endWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, formWait);
    await fillWizard(user);
    const deploy = screen.getByRole('button', { name: 'Deploy' });
    await user.click(deploy);
    // PatternFly's isLoading: a spinner in the button, at once.
    expect(within(deploy).getByRole('progressbar')).toBeVisible();

    await endWait();
    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
    expect(await toast('Saving model Widget')).toBeVisible();
    expect(screen.getByText("You'll be notified when it's saved to Git.")).toBeVisible();
    expect(screen.queryByText('Model deployed')).not.toBeInTheDocument();

    await act(async () => answer.resolve());
    expect(await toast('Model Widget saved to Git')).toBeVisible();
    expect(await screen.findByTestId('model-cluster-names-widget')).toBeVisible();
    // The answer arrived after the user had moved on: unread.
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
    // One entry for the write: the outcome replaced the in-progress entry, and is unread.
    await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    const items = within(screen.getByRole('list', { name: 'Notifications' })).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Model Widget saved to Git');
    expect(items[0]).not.toHaveClass('pf-m-read');
  });

  it("reports the backend's refusal after the wait, with a way back to the wizard", async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const answer = deferred<void>();
    vi.spyOn(models, 'create').mockImplementation(async () => {
      await answer.promise;
      throw new ConnectError('Model "widget" already exists', Code.AlreadyExists);
    });
    const { formWait, endWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, formWait);
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    await endWait();
    await toast('Saving model Widget');
    await act(async () => answer.resolve());
    const alert = (await toast('Unable to save model Widget')).closest('.pf-v6-c-alert') as HTMLElement;
    expect(alert).toHaveTextContent('Model "widget" already exists');
    await user.click(within(alert).getByRole('button', { name: 'Deploy model' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Deploy model' })).toBeVisible();
    // The wizard opens on Review with what was submitted, and the backend's refusal as its error.
    const review = await screen.findByTestId('model-review');
    expect(review).toHaveTextContent('hf://org/widget');
    expect(review).toHaveTextContent('registry.example/runtime:test');
    expect(review).toHaveTextContent('site1');
    expect(screen.getByText('Model "widget" already exists')).toBeVisible();
    // The name can be changed: the taken one is the problem.
    await user.click(screen.getByRole('button', { name: /^Deployment$/ }));
    expect(screen.getByTestId('model-name-desc-name')).toHaveValue('Widget');
    await user.click(screen.getByRole('button', { name: 'Edit resource name' }));
    expect(screen.getByRole('textbox', { name: /^Resource name/ })).toHaveValue('widget');
  });

  it('keeps a refusal that comes back within the wait on the form, as before', async () => {
    const service = new MockConsoleService();
    vi.spyOn(modelsOf(service), 'create').mockRejectedValue(
      new ConnectError('spec.model.uri: unsupported scheme', Code.InvalidArgument),
    );
    const { formWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, formWait);
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await screen.findByText('spec.model.uri: unsupported scheme')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Deploy model' })).toBeVisible();
    expect(screen.queryByText(/Deploying model/)).not.toBeInTheDocument();
  });

  it('keeps an answer that comes back within the wait with the form, Unavailable included: nothing is handed over', async () => {
    const service = new MockConsoleService();
    vi.spyOn(modelsOf(service), 'create').mockRejectedValue(new ConnectError('connection refused', Code.Unavailable));
    const storage = memoryStorage();
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, formWaits().formWait, storage);
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await screen.findByText('The AI grid backend is unavailable. Try again.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Deploy model' })).toBeVisible();
    expect(screen.queryByText(/Saving model/)).not.toBeInTheDocument();
    expect(storage.values.get(WATCHES)).toBeUndefined();
  });

  it('reads the model back when the answer is lost, and confirms the deploy that landed', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const create = models.create;
    // The commit lands; the answer, after the form's wait, never reaches the browser.
    vi.spyOn(models, 'create').mockImplementation(async (request, context) => {
      await create(request, context);
      throw lostAnswer();
    });
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, waitOver);
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
    // The read-back finds it at once: its outcome replaces the in-progress entry.
    expect(await toast('Model Widget saved to Git')).toBeVisible();
    expect(screen.queryByText(/Unable to deploy/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    expect(within(screen.getByRole('list', { name: 'Notifications' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('watches a deployed model until it runs on its clusters, and says on which', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const create = models.create;
    vi.spyOn(models, 'create').mockImplementation(async (request, context) => {
      const answer = await create(request, context);
      // site1 runs the model, while an ingress cluster, where MaaS still sets up its route, keeps
      // the whole model Pending.
      const stored = models.find('widget');
      stored.status!.phase = ModelPhase.PENDING;
      stored.status!.message = 'Not ready on site-a; ready on site1';
      stored.status!.clusters = [
        create_(ModelClusterStatusSchema, {
          cluster: 'site1',
          phase: ModelPhase.READY,
          reason: 'Ready',
          deployment: ModelDeploymentState.RUNNING,
          state: ModelState.READY,
        }),
      ];
      return answer;
    });
    const { formWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, formWait);
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await toast('Model Widget saved to Git')).toBeVisible();
    expect(await toast('Model Widget is ready on site1')).toBeVisible();
  });
});

describe('editing and deleting a model', () => {
  it('confirms an edit whose answer was lost by the version it moved to', async () => {
    const service = new MockConsoleService();
    const models = widget(service);
    const update = models.update;
    vi.spyOn(models, 'update').mockImplementation(async (request, context) => {
      await update(request, context);
      throw lostAnswer();
    });
    const user = userEvent.setup();
    renderConsole('/models/widget/edit', service, waitOver);
    await user.click(await screen.findByRole('button', { name: /^Deployment$/ }));
    const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.type(replicas, '2');
    await user.click(screen.getByRole('button', { name: /^Review$/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await toast('Changes to model Widget saved to Git')).toBeVisible();
    expect(await screen.findByRole('heading', { level: 1, name: 'Widget' })).toBeVisible();
    expect(screen.queryByText('Model updated')).not.toBeInTheDocument();
  });

  it("says an edit refused after the wait wasn't saved, and that the changes weren't kept", async () => {
    const service = new MockConsoleService();
    const models = widget(service);
    const answer = deferred<void>();
    vi.spyOn(models, 'update').mockImplementation(async () => {
      await answer.promise;
      throw new ConnectError(
        'update Model "widget": the model changed since it was read; reload and retry',
        Code.Aborted,
      );
    });
    const { formWait, endWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/models/widget/edit', service, formWait);
    await user.click(await screen.findByRole('button', { name: /^Deployment$/ }));
    const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.type(replicas, '2');
    await user.click(screen.getByRole('button', { name: /^Review$/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await endWait();
    await act(async () => answer.resolve());
    const alert = (await toast('Unable to save changes to model Widget')).closest('.pf-v6-c-alert') as HTMLElement;
    expect(alert).toHaveTextContent(
      'update Model "widget": the model changed since it was read; reload and retry Your changes weren\'t saved. Edit the model again to make them.',
    );
    expect(within(alert).getByRole('button', { name: 'Edit model' })).toBeVisible();
  });

  it('closes the delete dialog after the wait and reports the delete when it lands', async () => {
    const service = new MockConsoleService();
    const models = widget(service);
    const answer = deferred<void>();
    const remove = models.delete;
    vi.spyOn(models, 'delete').mockImplementation(async (request, context) => {
      await answer.promise;
      return remove(request, context);
    });
    const { formWait, endWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/models', service, formWait);
    await user.click(await screen.findByTestId('model-actions-widget'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByTestId('delete-deployment-modal');
    await user.click(within(dialog).getByTestId('delete-modal-input'));
    await user.paste('Widget');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await endWait();
    expect(screen.queryByTestId('delete-deployment-modal')).not.toBeInTheDocument();
    expect(await toast('Deleting model Widget')).toBeVisible();
    await act(async () => answer.resolve());
    expect(await toast('Model Widget deleted from Git')).toBeVisible();
    expect(screen.getByText("It's being removed from site1.")).toBeVisible();
    expect(screen.queryByText('Model deleted')).not.toBeInTheDocument();
  });
});

describe('subscriptions', () => {
  it('leaves the create form after the wait and reports the subscription when it is created', async () => {
    const service = new MockConsoleService();
    const subscriptions = seedSubscriptionsOf(service);
    const answer = deferred<void>();
    subscriptions.before.create = () => answer.promise;
    const { formWait, endWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/subscriptions/create', service, formWait);
    await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
    await user.click(screen.getByRole('option', { name: 'acme-robotics' }));
    await user.click(screen.getByTestId('subscription-name-desc-name'));
    await user.paste('Test team');
    await user.click(screen.getByRole('combobox', { name: 'Groups' }));
    await user.paste('engineering');
    const option = await screen.findByRole('option', { name: 'Add group "engineering"' });
    await user.click(option.querySelector('button') ?? option);
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('add-models-button'));
    await user.click(screen.getByTestId('toggle-model-granite-3-8b'));
    await user.click(screen.getByTestId('confirm-add-models'));
    await user.click(screen.getByTestId('add-token-limit-0'));
    await user.click(screen.getByTestId('save-rate-limits'));
    await user.click(screen.getByTestId('create-subscription-button'));
    await endWait();
    expect(await screen.findByTestId('subscriptions-table')).toBeVisible();
    expect(await toast('Saving subscription Test team')).toBeVisible();
    await act(async () => answer.resolve());
    expect(await toast('Subscription Test team saved to Git')).toBeVisible();
    expect(screen.getByText('It takes effect once the ingress clusters apply it.')).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Test team' })).toBeVisible();
  });

  it('reopens the create form with what was submitted when the backend refuses it after the wait', async () => {
    const service = new MockConsoleService();
    const subscriptions = seedSubscriptionsOf(service);
    const answer = deferred<void>();
    subscriptions.before.create = async () => {
      await answer.promise;
      throw new ConnectError('Subscription "test-team" already exists', Code.AlreadyExists);
    };
    const { formWait, endWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/subscriptions/create', service, formWait);
    await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
    await user.click(screen.getByRole('option', { name: 'acme-robotics' }));
    await user.click(screen.getByTestId('subscription-name-desc-name'));
    await user.paste('Test team');
    await user.click(screen.getByRole('combobox', { name: 'Groups' }));
    await user.paste('engineering');
    const option = await screen.findByRole('option', { name: 'Add group "engineering"' });
    await user.click(option.querySelector('button') ?? option);
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('add-models-button'));
    await user.click(screen.getByTestId('toggle-model-granite-3-8b'));
    await user.click(screen.getByTestId('confirm-add-models'));
    await user.click(screen.getByTestId('add-token-limit-0'));
    await user.click(screen.getByTestId('save-rate-limits'));
    await user.click(screen.getByTestId('create-subscription-button'));
    await endWait();
    await act(async () => answer.resolve());
    const alert = (await toast('Unable to save subscription Test team')).closest('.pf-v6-c-alert') as HTMLElement;
    await user.click(within(alert).getByRole('button', { name: 'Create subscription' }));
    // The form holds what was submitted, and the refusal as its error.
    expect(await screen.findByTestId('subscription-name-desc-name')).toHaveValue('Test team');
    expect(screen.getByText('Subscription "test-team" already exists')).toBeVisible();
    expect(screen.getByText('engineering')).toBeVisible();
    expect(screen.getByTestId('subscription-models-table')).toHaveTextContent('granite-3-8b');
  });

  /** Renames engineering to Platform on its edit page and saves. */
  const renameEngineering = async (service: MockConsoleService) => {
    const user = userEvent.setup();
    renderConsole('/subscriptions/edit/engineering', service, waitOver);
    const name = await screen.findByTestId('subscription-name-desc-name');
    await user.clear(name);
    await user.paste('Platform');
    await user.click(screen.getByTestId('update-subscription-button'));
  };

  it('confirms an edit whose answer was lost when the subscription read back is what it sent', async () => {
    const service = new MockConsoleService();
    const subscriptions = seedSubscriptionsOf(service);
    // The backend saves this edit, then the answer is lost.
    subscriptions.before.update = (request) => {
      delete subscriptions.before.update;
      const { object } = request as { object: Subscription };
      const stored = subscriptions.subscriptions.find((s) => s.id === 'engineering')!;
      stored.metadata!.annotations = { ...object.metadata!.annotations };
      stored.metadata!.version += 1;
      throw lostAnswer();
    };
    await renameEngineering(service);
    expect(await toast('Changes to subscription Platform saved to Git')).toBeVisible();
  });

  it("doesn't confirm an edit when the version moved on with someone else's change", async () => {
    const service = new MockConsoleService();
    const subscriptions = seedSubscriptionsOf(service);
    // Someone else renames it meanwhile; this edit's answer is lost and it never lands.
    subscriptions.before.update = () => {
      delete subscriptions.before.update;
      const stored = subscriptions.subscriptions.find((s) => s.id === 'engineering')!;
      stored.metadata!.annotations = { ...stored.metadata!.annotations, 'openshift.io/display-name': 'Data team' };
      stored.metadata!.version += 1;
      throw lostAnswer();
    };
    await renameEngineering(service);
    const alert = (await toast('Unable to confirm subscription Platform')).closest('.pf-v6-c-alert') as HTMLElement;
    expect(alert).toHaveClass('pf-m-warning');
    expect(alert).toHaveTextContent(
      'The subscription was changed in Git, but not as you submitted. Someone else may have edited it. Open the subscription to check your changes.',
    );
    expect(within(alert).getByRole('button', { name: 'View subscription' })).toBeVisible();
    expect(screen.queryByText('Changes to subscription Platform saved to Git')).not.toBeInTheDocument();
  });

  it("reports a delete the backend refused after the wait, with the backend's message", async () => {
    const service = new MockConsoleService();
    const subscriptions = seedSubscriptionsOf(service);
    const answer = deferred<void>();
    subscriptions.before.delete = async () => {
      await answer.promise;
      throw new ConnectError('Subscription "engineering" is being reconciled', Code.FailedPrecondition);
    };
    const { formWait, endWait } = formWaits();
    const user = userEvent.setup();
    renderConsole('/subscriptions/view/engineering', service, formWait);
    await screen.findByTestId('subscription-details-section');
    await user.click(screen.getByTestId('subscription-actions-toggle'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByTestId('delete-modal-input'));
    await user.paste('Engineering');
    await user.click(within(screen.getByTestId('delete-subscription-modal')).getByRole('button', { name: 'Delete' }));
    await endWait();
    expect(await toast('Deleting subscription Engineering')).toBeVisible();
    await act(async () => answer.resolve());
    const alert = (await toast('Unable to delete subscription Engineering')).closest('.pf-v6-c-alert') as HTMLElement;
    expect(alert).toHaveTextContent('Subscription "engineering" is being reconciled');
    expect(within(alert).getByRole('button', { name: 'View subscription' })).toBeVisible();
    expect(subscriptionsOf(service).subscriptions.some((s) => s.id === 'engineering')).toBe(true);
  });
});

describe('a write still running', () => {
  it('keeps its own answer when the transport changes, instead of being read back as well', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const answer = deferred<void>();
    const create = models.create;
    vi.spyOn(models, 'create').mockImplementation(async (request, context) => {
      await answer.promise;
      return create(request, context);
    });
    const { formWait, endWait } = formWaits();
    const storage = memoryStorage();
    const user = userEvent.setup();
    const { rerender } = render(
      <MemoryRouter initialEntries={['/models/deploy']}>
        <TestApp service={service} formWait={formWait} storage={storage.get} />
      </MemoryRouter>,
    );
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    await endWait();
    await toast('Saving model Widget');
    const sent = () => JSON.parse(storage.values.get(WATCHES) ?? '[]') as { stage: string }[];
    expect(sent().map((r) => r.stage)).toEqual(['sent']);

    // A new transport (the session's check changed) runs the resume again in the same page.
    rerender(
      <MemoryRouter initialEntries={['/models/deploy']}>
        <TestApp service={service} formWait={formWait} storage={storage.get} transport={transportFor(service)} />
      </MemoryRouter>,
    );
    expect(sent().map((r) => r.stage)).toEqual(['sent']);

    await act(async () => answer.resolve());
    expect(await toast('Model Widget saved to Git')).toBeVisible();
    expect(sent().map((r) => r.stage)).toEqual(['ready']);
  });
});

describe('session storage', () => {
  it('follows a write without session storage: only a reload forgets it', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const create = models.create;
    vi.spyOn(models, 'create').mockImplementation(async (request, context) => {
      await create(request, context);
      throw lostAnswer();
    });
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, waitOver, { get: blockedStorage, values: new Map() });
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await toast('Model Widget saved to Git')).toBeVisible();
  });

  it('reads back a write whose page was reloaded before it answered', async () => {
    const service = new MockConsoleService();
    widget(service);
    const storage = memoryStorage({
      [WATCHES]: JSON.stringify([
        { key: 'w1', subject: 'model', op: 'create', id: 'widget', name: 'Widget', stage: 'sent', since: Date.now() },
      ]),
    });
    renderConsole('/clusters', service, formWaits().formWait, storage);
    expect(await toast('Model Widget saved to Git')).toBeVisible();
  });

  it('says a write was not done once its two minutes have passed without it', async () => {
    const service = new MockConsoleService();
    const storage = memoryStorage({
      [WATCHES]: JSON.stringify([
        {
          key: 'w1',
          subject: 'model',
          op: 'create',
          id: 'ghost',
          name: 'Ghost',
          stage: 'readback',
          since: Date.now() - 3 * 60_000,
        },
      ]),
    });
    renderConsole('/clusters', service, formWaits().formWait, storage);
    expect(await toast('Unable to save model Ghost')).toBeVisible();
    expect(
      screen.getByText(
        "The model wasn't found in Git 2 minutes after it was submitted, and the reason is unknown. If it isn't in the Models list, deploy it again.",
      ),
    ).toBeVisible();
    // A final answer drops the watch from storage.
    expect(storage.values.get(WATCHES)).toBeUndefined();
  });

  it("reads back a write whose page reloaded during the form's wait", async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const answer = deferred<void>();
    const create = models.create;
    vi.spyOn(models, 'create').mockImplementation(async (request, context) => {
      await answer.promise;
      return create(request, context);
    });
    const storage = memoryStorage();
    const user = userEvent.setup();
    const page = render(
      <MemoryRouter initialEntries={['/models/deploy']}>
        <TestApp service={service} formWait={formWaits().formWait} storage={storage.get} />
      </MemoryRouter>,
    );
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    // The page reloads while the form still waits; the write lands meanwhile, its answer lost.
    page.unmount();
    await act(async () => answer.resolve());
    renderConsole('/clusters', service, formWaits().formWait, storage);
    expect(await toast('Model Widget saved to Git')).toBeVisible();
  });
});

describe('review findings', () => {
  it("doesn't confirm a deploy whose name is taken by a model that isn't the one sent", async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    // Someone else's widget lands first; this deploy's answer is lost.
    vi.spyOn(models, 'create').mockImplementation(async () => {
      widget(service);
      throw lostAnswer();
    });
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, waitOver);
    await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
    await user.paste('hf://other-org/widget');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const name = await screen.findByTestId('model-name-desc-name');
    await user.clear(name);
    await user.paste('Widget');
    await user.click(screen.getByRole('radio', { name: 'CPU only' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('combobox', { name: 'Clusters' }));
    await user.click(screen.getByRole('option', { name: /^site1( |$)/ }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Deploy' }));
    const alert = (await toast('Unable to confirm model Widget')).closest('.pf-v6-c-alert') as HTMLElement;
    expect(alert).toHaveTextContent(
      "A model with this name is in Git, but it doesn't match what you submitted. Someone else may have created it. Open the model to check it.",
    );
    expect(screen.queryByText('Model Widget saved to Git')).not.toBeInTheDocument();
  });

  it('confirms an edit and follows its changes, never saying ready, which the status cannot tell for a new revision', async () => {
    const service = new MockConsoleService();
    const models = widget(service);
    const update = models.update;
    vi.spyOn(models, 'update').mockImplementation(async (request, context) => {
      const answer = await update(request, context);
      // site1 still reports Ready: the previous revision's pod, as far as anyone can tell.
      const stored = models.find('widget');
      stored.status!.phase = ModelPhase.READY;
      stored.status!.clusters = [
        create_(ModelClusterStatusSchema, {
          cluster: 'site1',
          phase: ModelPhase.READY,
          reason: 'Ready',
          deployment: ModelDeploymentState.RUNNING,
          state: ModelState.READY,
        }),
      ];
      return answer;
    });
    const storage = memoryStorage();
    const user = userEvent.setup();
    renderConsole('/models/widget/edit', service, formWaits().formWait, storage);
    await user.click(await screen.findByRole('button', { name: /^Deployment$/ }));
    const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.type(replicas, '2');
    await user.click(screen.getByRole('button', { name: /^Review$/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await toast('Changes to model Widget saved to Git')).toBeVisible();
    // The change watch has read the model ready on site1, and says nothing of it.
    await waitFor(() =>
      expect(JSON.parse(storage.values.get(WATCHES) ?? '[]')).toMatchObject([
        { id: 'widget', stage: 'changes', status: expect.stringContaining('"site1"') },
      ]),
    );
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();
  });

  it('says a deploy answered within the wait is saved to Git, not deployed, and where it goes next', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderConsole('/models/deploy', service, formWaits().formWait);
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await toast('Model Widget saved to Git')).toBeVisible();
    expect(screen.getByText("It's being deployed to site1. You'll be notified when it's ready.")).toBeVisible();
    expect(screen.queryByText(/deployed$/)).not.toBeInTheDocument();
  });

  it('registers its watches again from memory when the transport changes, without session storage', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const create = models.create;
    let landLater: () => Promise<unknown> = async () => undefined;
    // The answer is lost before the write lands; it lands later.
    vi.spyOn(models, 'create').mockImplementation(async (request, context) => {
      landLater = async () => create(request, context);
      throw lostAnswer();
    });
    const user = userEvent.setup();
    const formWait = waitOver;
    const { rerender } = render(
      <MemoryRouter initialEntries={['/models/deploy']}>
        <TestApp service={service} formWait={formWait} storage={blockedStorage} />
      </MemoryRouter>,
    );
    await fillWizard(user);
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await toast('Saving model Widget')).toBeVisible();
    await act(async () => {
      await landLater();
    });
    // A new transport registers the read-back again, which checks at once.
    rerender(
      <MemoryRouter initialEntries={['/models/deploy']}>
        <TestApp service={service} formWait={formWait} storage={blockedStorage} transport={transportFor(service)} />
      </MemoryRouter>,
    );
    expect(await toast('Model Widget saved to Git')).toBeVisible();
  });
});
