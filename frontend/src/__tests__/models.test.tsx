// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/deployments.test.tsx at 62319b8.
// The pages read and write the backend's Models API over Connect; here it is the in-memory fake in
// connectModels.ts (modelsOf), in the generated messages, with the backend's rules the pages show.
// The backend's own rules are its tests' (internal/servers in ai-grid-provider-backend).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { Code, ConnectError } from '@connectrpc/connect';
import { focusManager } from '@tanstack/react-query';
import { ServiceError } from '../api/ConsoleService';
import { MockConsoleService, seedClusters } from '../api/MockConsoleService';
import configExample from '../../../mock/examples/get-config.json';
import { create } from '@bufbuild/protobuf';
import {
  ModelClusterStatusSchema,
  ModelDeploymentState,
  ModelIngressStatusSchema,
  ModelMaasState,
  ModelPhase,
  ModelState,
  ModelSyncState,
  ModelViewTarget,
} from '../gen/ai_grid/v1/model_type_pb';
import { modelObject, modelsOf, subscriptionUsing } from './connectModels';
import { viewHref } from '../pages/models/modelUtils';
import { deferred, renderAt, findVisible } from './render';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/models/ModelDetailsPage';
import '../pages/models/ModelEditPage';
import '../pages/models/ModelWizard';
import '../pages/models/ModelsPage';
import { TestApp } from './TestApp';

/** A user the console couldn't load: the pages show, but without write actions. A viewer
 * (isProviderAdmin false) sees no pages at all (App.test.tsx). */
const unknownUser = () => {
  const service = new MockConsoleService();
  service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
  return service;
};

const unavailable = () => {
  throw new ConnectError('Service unavailable.', Code.Unavailable);
};

type User = ReturnType<typeof userEvent.setup>;

/** Names the deployment, replacing the name the wizard starts from the model's. */
const nameDeployment = async (user: User, name: string) => {
  const field = await screen.findByTestId('model-name-desc-name');
  await user.clear(field);
  await user.paste(name);
};

/** Selects the Deployment step's hardware, NVIDIA GPU until another is selected. */
const selectHardware = async (user: User, label: string) => user.click(screen.getByRole('radio', { name: label }));

/** Replaces the runtime image, which CPU only fills in. */
const setImage = async (user: User, image: string) => {
  const field = screen.getByRole('textbox', { name: /Runtime image/ });
  await user.clear(field);
  if (image) await user.paste(image);
};

/** Fills the source and deployment steps, on CPU only with an image of its own, and moves on to Clusters. */
const fillModel = async (user: User) => {
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await nameDeployment(user, 'Widget');
  await selectHardware(user, 'CPU only');
  await user.click(screen.getByRole('textbox', { name: /Runtime image/ }));
  await setImage(user, 'registry.example/runtime:test');
  await user.click(screen.getByRole('button', { name: 'Next' }));
};

/** Picks these clusters on the Clusters step, opens Review and, unless told not to, deploys. */
const pickAndDeploy = async (user: User, names: string[], { submit = true } = {}) => {
  await user.click(await screen.findByRole('combobox', { name: 'Clusters' }));
  for (const name of names) await user.click(screen.getByRole('option', { name: optionName(name) }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const review = await screen.findByTestId('model-review');
  if (submit) await user.click(screen.getByRole('button', { name: 'Deploy' }));
  return review;
};

/** The same clusters as the Deploy wizard offers them: by cluster name. */
const cluster1 = 'site1';
const cluster2 = 'site2';
const cluster3 = 'site3';
/** A Clusters option by its cluster name: its accessible name goes on with the site and region. */
const optionName = (cluster: string) => new RegExp(`^${cluster}( |$)`);

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

const rowOf = async (id: string) =>
  (await screen.findByTestId(`model-cluster-names-${id}`)).closest('tr') as HTMLElement;

/** The data rows of a table, found by its accessible name (the first row is its header). */
const tableRows = async (name: string, container: HTMLElement = document.body) =>
  within(await within(container).findByRole('grid', { name }))
    .getAllByRole('row')
    .slice(1);

/** A row's cell under the column header named `column`. */
const cellIn = (row: HTMLElement, column: string) => {
  const headers = within(row.closest('table')!).getAllByRole('columnheader');
  return within(row).getAllByRole('cell')[headers.findIndex((h) => h.textContent === column)];
};

it('walks the deployment wizard, selects clusters and creates the model', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const create = vi.spyOn(models, 'create');
  const user = userEvent.setup();
  renderAt('/models', service);
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Deploy model' }));
  expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
  await fillModel(user);
  const reviewNav = within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', {
    name: /Review/,
  });
  expect(reviewNav).toBeDisabled();
  const review = await pickAndDeploy(user, [cluster1, cluster2], { submit: false });
  expect(review).toHaveTextContent(`${cluster1}, ${cluster2}`);
  // Empty optional fields are left out of the review, and the served name is the resource name.
  expect(review).not.toHaveTextContent('Additional runtime arguments');
  expect(review).toHaveTextContent('Model nameWidget');
  expect(review).toHaveTextContent('Model name in requestswidget');
  expect(within(review).getAllByText('Model name in requests')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Deploy' }));

  expect(await screen.findByText('Model Widget saved to Git')).toBeVisible();
  // The confirmation comes with the answer; the list shows the model once its refetch is in.
  expect(within(await screen.findByTestId('model-cluster-names-widget')).getByText('site1')).toBeVisible();
  expect(screen.getByTestId('model-deployments-table')).toHaveTextContent('Widget');
  // What Models/Create took: the wizard's fields, CPU only's resources and environment, no presets,
  // and the inference scheduler with a managed route, which the backend's defaults leave off.
  const [request] = create.mock.calls[0];
  expect(request.object).toMatchObject({
    id: 'widget',
    metadata: { name: 'widget', annotations: { 'openshift.io/display-name': 'Widget' } },
    spec: {
      model: { uri: 'hf://org/widget', name: '' },
      replicas: 1,
      baseRefs: [],
      main: {
        image: 'registry.example/runtime:test',
        requests: { cpu: '4', memory: '8Gi' },
        limits: {},
        env: [
          { name: 'OMP_NUM_THREADS', value: '4' },
          { name: 'VLLM_CPU_KVCACHE_SPACE', value: '4' },
        ],
      },
      placement: { labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: ['site1', 'site2'] }] } },
    },
  });
  expect(request.object?.spec?.router).toMatchObject({ scheduler: true, managedRoute: true, gatewayRefs: [] });
  expect(request.object?.spec?.rollout).toBeUndefined();
});

it('removes a model after its name is typed', async () => {
  const service = new MockConsoleService();
  const models = widget(service);
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  expect(dialog).toHaveTextContent('Delete model?');
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Widget');
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Model Widget deleted from Git')).toBeVisible();
  await waitFor(() => expect(screen.queryByTestId('model-actions-widget')).not.toBeInTheDocument());
  expect(models.models.some((m) => m.id === 'widget')).toBe(false);
});

it('leaves the deploy form out of history once the model is deployed, so Back skips it', async () => {
  let navigate: NavigateFunction = () => undefined;
  const CaptureNavigate = () => {
    navigate = useNavigate();
    return null;
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/clusters', '/models/deploy']} initialIndex={1}>
      <CaptureNavigate />
      <TestApp service={new MockConsoleService()} />
    </MemoryRouter>,
  );
  await fillModel(user);
  await pickAndDeploy(user, [cluster1]);
  expect(await screen.findByText('Model Widget saved to Git')).toBeVisible();
  await act(async () => navigate(-1));
  expect(await screen.findByRole('heading', { level: 1, name: 'Clusters' })).toBeVisible();
});

it('names the subscriptions that use the model and disables Delete, joined by model_id', async () => {
  const service = new MockConsoleService();
  const models = widget(service);
  models.subscriptions = [
    subscriptionUsing('widget-users', ['widget'], 'Widget users'),
    subscriptionUsing('others', ['granite-3-8b']),
  ];
  const listSubscriptions = vi.spyOn(models, 'listSubscriptions');
  const remove = vi.spyOn(models, 'delete');
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const references = await screen.findByTestId('model-references');
  expect(
    within(references)
      .getAllByRole('link')
      .map((l) => l.textContent),
  ).toEqual(['Widget users']);
  expect(within(references).getByRole('link', { name: 'Widget users' })).toHaveAttribute(
    'href',
    '/subscriptions/view/widget-users',
  );
  // The backend evaluates the join (SubscriptionModelRef.model_id) and the filter.
  expect(listSubscriptions.mock.calls[0][0].filter).toBe('this.spec.model_refs.exists(r, r.model_id == "widget")');
  // Nothing to type while subscriptions use the model: Delete can't go ahead.
  expect(screen.queryByTestId('delete-modal-input')).not.toBeInTheDocument();
  expect(screen.queryByText(/to confirm deletion:/)).not.toBeInTheDocument();
  const button = within(screen.getByTestId('delete-deployment-modal')).getByRole('button', { name: 'Delete' });
  expect(button).toHaveAttribute('aria-disabled', 'true');
  await user.click(button);
  await user.hover(button);
  expect(await screen.findByText('Remove this model from its subscriptions first.')).toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();
});

it('leaves Delete to the backend when the subscriptions fail to load, and keeps the dialog when it refuses', async () => {
  const service = new MockConsoleService();
  const models = widget(service);
  models.subscriptions = [subscriptionUsing('widget-users', ['widget'])];
  vi.spyOn(models, 'listSubscriptions').mockImplementation(unavailable);
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.click(await screen.findByTestId('delete-modal-input'));
  await user.paste('Widget');
  await user.click(within(screen.getByTestId('delete-deployment-modal')).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByTestId('delete-model-error-message-alert')).toHaveTextContent(
    'Model "widget" is referenced by Subscription "widget-users"',
  );
  expect(screen.getByTestId('delete-deployment-modal')).toBeVisible();
  expect(models.models.some((m) => m.id === 'widget')).toBe(true);
});

it('keeps the wizard usable after a cluster-list failure and retries', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const list = models.placementClusters;
  // Fails when the wizard opens and again when the Locations step reloads; Retry succeeds.
  let failures = 2;
  models.placementClusters = async () => {
    if (failures-- > 0) throw new ConnectError('Location catalog unavailable.', Code.FailedPrecondition);
    return list();
  };
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  expect(await screen.findByText('Location catalog unavailable.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await pickAndDeploy(user, [cluster1], { submit: false });
  expect(screen.getByText('hf://org/widget')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();
});

it('loads the placement clusters again when the Clusters step opens', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const list = models.placementClusters;
  // When the wizard opens only site1 is offered; by the Clusters step all three are.
  let calls = 0;
  models.placementClusters = async () => (calls++ === 0 ? ['site1'] : list());
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Clusters' }));
  await findVisible('option', optionName(cluster3));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
    `${cluster1}San Francisco · us-west`,
    `${cluster2}New York · us-east`,
    `${cluster3}Brussels · europe-west`,
  ]);
});

it('keeps a chosen cluster the reload no longer offers, and says to remove it', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const list = models.placementClusters;
  // site2 drops out after the first visit to the Clusters step.
  let calls = 0;
  models.placementClusters = async () => (calls++ < 2 ? list() : ['site1', 'site3']);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await pickAndDeploy(user, [cluster1, cluster2], { submit: false });
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(await screen.findByText(`${cluster2} is no longer available. Remove it to continue.`)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: `Remove ${cluster2}` }));
  expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(within(await screen.findByTestId('model-review')).getByText(cluster1)).toBeVisible();
});

it('keeps Next disabled until the Clusters reload answers', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const list = models.placementClusters;
  const held = deferred<void>();
  let calls = 0;
  // The reload on entering the step waits for the test.
  models.placementClusters = async () => {
    if (calls++ === 1) await held.promise;
    return list();
  };
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Clusters' }));
  await user.click(screen.getByRole('option', { name: optionName(cluster1) }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await act(async () => held.resolve());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
});

it('keeps chosen clusters visible when the reload offers none', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const list = models.placementClusters;
  let calls = 0;
  models.placementClusters = async () => (calls++ < 2 ? list() : []);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await pickAndDeploy(user, [cluster1], { submit: false });
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(await screen.findByText(`${cluster1} is no longer available. Remove it to continue.`)).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Clusters' })).toHaveAttribute('aria-invalid', 'true');
  await user.click(screen.getByRole('button', { name: `Remove ${cluster1}` }));
  expect(await screen.findByText('No clusters available')).toBeVisible();
});

it('names the AI grid members the Clusters step leaves out, and why', async () => {
  const hint = /Not listed:/;
  const clusters = seedClusters();
  // site2 offline and still provisioning; site3 ingress only.
  clusters[1] = { ...clusters[1], status: 'Unavailable', provisioned: false, provisioningStatus: 'Provisioning' };
  clusters[2] = { ...clusters[2], labels: { ...clusters[2].labels, 'ai-grid/role': 'ingress' } };
  const service = new MockConsoleService(undefined, clusters);
  const models = modelsOf(service);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await screen.findByRole('combobox', { name: 'Clusters' });
  expect(await screen.findByText(hint)).toHaveTextContent(
    'Select the AI grid clusters where the model will run. This list includes only clusters that have the Ready cluster status, the Provisioned AI grid status, and the Inference or Ingress and inference role. Not listed: site2 (not Ready, not Provisioned) and site3 (Ingress role).',
  );
  // Once the backend offers every member, there is nothing to explain.
  models.placementClusters = async () => ['site1', 'site2', 'site3'];
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('combobox', { name: 'Clusters' });
  await waitFor(() => expect(screen.queryByText(hint)).not.toBeInTheDocument());
});

it("keeps input when saving fails, with the backend's message", async () => {
  const service = new MockConsoleService();
  widget(service);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await pickAndDeploy(user, [cluster3]);
  expect(await screen.findByText('Model "widget" already exists')).toBeVisible();
  expect(screen.getByText('Unable to deploy model')).toBeVisible();
  expect(screen.getByText('hf://org/widget')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();
});

it('hides write actions until it knows the user is a provider admin', async () => {
  const service = unknownUser();
  renderAt('/models', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('Unable to load user'));
  const table = await screen.findByTestId('model-deployments-table');
  expect(table).toHaveTextContent('Granite 3.3 8B Instruct');
  expect(screen.queryByRole('link', { name: 'Deploy model' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('model-actions-granite-3-8b')).not.toBeInTheDocument();
});

it('shows the not-available state when the backend has no Models/List', async () => {
  const service = new MockConsoleService();
  vi.spyOn(modelsOf(service), 'list').mockImplementation(() => {
    throw new ConnectError('no such method', Code.Unimplemented);
  });
  renderAt('/models', service);
  expect(await screen.findByText('Models are not available on this AI grid backend')).toBeVisible();
  expect(screen.queryByTestId('model-deployments-table')).not.toBeInTheDocument();
});

it('shows one pagination, in the toolbar, for a single page', async () => {
  renderAt('/models', new MockConsoleService());
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(1);
});

describe('the status', () => {
  /** The service with one model per rollout state the backend reports (ModelStatus.state). */
  const phases = () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const at = (id: string, phase: ModelPhase, reason: string, message = '', state = ModelState.UNSPECIFIED) =>
      modelObject({
        id,
        metadata: { name: id, version: 1 },
        spec: { model: { uri: `hf://x/${id}`, name: id } },
        status: { phase, reason, message, state },
      });
    models.models = [
      at('ready', ModelPhase.READY, 'Ready', '', ModelState.READY),
      at('pending', ModelPhase.PENDING, 'NotReady', 'Not ready on site1', ModelState.STARTING),
      at(
        'failed',
        ModelPhase.FAILED,
        'ConfigNotFound',
        'LLMInferenceServiceConfig "v3-6-0-kserve-config-llm-template-tpu" not found',
        ModelState.FAILED,
      ),
      at(
        'partial',
        ModelPhase.PARTIALLY_AVAILABLE,
        'PartiallyAvailable',
        'Not ready on site2; ready on site1',
        ModelState.PARTIALLY_READY,
      ),
      at('saved', ModelPhase.UNSPECIFIED, 'SavedToGit', '', ModelState.SAVED_TO_GIT),
      at('syncing', ModelPhase.PENDING, 'NotReady', '', ModelState.SYNCING),
      at('stopped', ModelPhase.PENDING, 'Stopped', '', ModelState.STOPPED),
      at('unknown', ModelPhase.UNSPECIFIED, 'Something', '', 99 as ModelState),
    ];
    return service;
  };

  it('words each state; Saved to Git, Syncing and Partially ready open a dialog, the rest are outline', async () => {
    const user = userEvent.setup();
    renderAt('/models', phases());
    const status = async (id: string) => within(await rowOf(id)).getByTestId('model-phase');
    expect(await status('ready')).toHaveTextContent(/^Ready for ready$/);
    expect(await status('pending')).toHaveTextContent(/^Starting for pending$/);
    expect(await status('failed')).toHaveTextContent(/^Failed for failed$/);
    expect(await status('partial')).toHaveTextContent(/^Partially ready for partial$/);
    expect(await status('saved')).toHaveTextContent(/^Saved to Git for saved$/);
    expect(await status('syncing')).toHaveTextContent(/^Syncing for syncing$/);
    expect(await status('stopped')).toHaveTextContent(/^Stopped for stopped$/);
    // A state newer than the pin is Unknown: the console doesn't guess.
    expect(await status('unknown')).toHaveTextContent(/^Unknown for unknown$/);
    for (const id of ['ready', 'pending', 'failed', 'stopped']) {
      expect((await status(id)).querySelector('.pf-v6-c-label')).toHaveClass('pf-m-outline');
      expect(within(await status(id)).queryByRole('button')).not.toBeInTheDocument();
    }
    await user.hover(within(await status('failed')).getByText('Failed'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'A runtime template this model needs isn’t installed on the hub. Install the template on the hub, or deploy the model with another runtime.',
    );
    for (const id of ['partial', 'saved', 'syncing']) {
      expect(within(await status(id)).getByRole('button')).toBeInTheDocument();
    }
    await user.click(within(await status('saved')).getByRole('button'));
    const modal = await screen.findByRole('dialog', { name: 'saved status' });
    expect(modal).toHaveTextContent('waiting for Argo CD to synchronize');
    // The design's Sync now waits until after the freeze.
    expect(within(modal).queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('explains the state in the tooltip, never the phase that disagrees with it', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    const at = (id: string, status: Parameters<typeof modelObject>[0]['status']) =>
      modelObject({
        id,
        metadata: { name: id, version: 1 },
        spec: { model: { uri: `hf://x/${id}`, name: id } },
        status,
      });
    const cluster = (name: string, phase: ModelPhase, state: ModelState, deploymentMessage = '') =>
      create(ModelClusterStatusSchema, { cluster: name, phase, state, deploymentMessage });
    modelsOf(service).models = [
      // The phase says one cluster failed; the state, from the same clusters, says Ready.
      at('ready', {
        phase: ModelPhase.PARTIALLY_AVAILABLE,
        reason: 'PartiallyAvailable',
        message: 'Failed on site-b; ready on site-a',
        state: ModelState.READY,
        clusters: [
          cluster('site-a', ModelPhase.READY, ModelState.READY),
          cluster('site-b', ModelPhase.FAILED, ModelState.READY),
        ],
      }),
      at('starting', {
        phase: ModelPhase.FAILED,
        reason: 'Failed',
        message: 'Failed on site-b',
        state: ModelState.STARTING,
        clusters: [
          cluster('site-b', ModelPhase.FAILED, ModelState.STARTING, 'Deployment does not have minimum availability.'),
        ],
      }),
    ];
    renderAt('/models', service);
    const status = async (id: string) => within(await rowOf(id)).getByTestId('model-phase');
    // Ready has nothing to add: no tooltip, so the label takes no focus.
    const ready = within(await status('ready')).getByText('Ready');
    expect(ready.closest('.pf-v6-c-label')).not.toHaveAttribute('tabindex');
    await user.hover(within(await status('starting')).getByText('Starting'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(/^site-b: Starting\. Deployment does not have minimum availability\.$/);
  });

  it('sorts the list by Status, in rollout order', async () => {
    renderAt('/models', phases());
    await rowOf('ready');
    const names = screen
      .getAllByRole('row')
      .map((r) => r.querySelector('[data-testid="model-phase"]')?.textContent?.replace(/ for .*$/, ''))
      .filter(Boolean);
    expect(names).toEqual([
      'Saved to Git',
      'Syncing',
      'Starting',
      'Ready',
      'Partially ready',
      'Failed',
      'Stopped',
      'Unknown',
    ]);
  });

  it("explains a failure on the model's page, the backend's own words folded away", async () => {
    const user = userEvent.setup();
    renderAt('/models/failed', phases());
    const alert = await screen.findByTestId('model-status-alert');
    expect(alert).toHaveTextContent('Unable to deploy model');
    expect(alert).toHaveTextContent('Install the template on the hub, or deploy the model with another runtime.');
    const raw = screen.getByText(/v3-6-0-kserve-config-llm-template-tpu" not found/);
    expect(raw).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(raw).toHaveTextContent(/^ConfigNotFound: /);
  });

  it('shows no alert for Saved to Git: the label says it all', async () => {
    renderAt('/models/saved', phases());
    expect(await screen.findByTestId('model-phase')).toHaveTextContent(/^Saved to Git$/);
    expect(screen.queryByTestId('model-status-alert')).not.toBeInTheDocument();
  });

  it('warns about a partially ready model on its page, naming each cluster that isn’t ready', async () => {
    const service = phases();
    modelsOf(service).find('partial').status!.clusters = [
      create(ModelClusterStatusSchema, { cluster: 'site1', state: ModelState.READY, message: 'ready' }),
      create(ModelClusterStatusSchema, {
        cluster: 'site2',
        state: ModelState.STARTING,
        deployment: ModelDeploymentState.STARTING,
        deploymentMessage: 'Deployment does not have minimum availability.',
      }),
    ];
    renderAt('/models/partial', service);
    const alert = await screen.findByTestId('model-status-alert');
    expect(alert).toHaveClass('pf-m-warning');
    expect(within(alert).getByRole('list', { name: 'Clusters where partial isn’t ready' })).toHaveTextContent(
      /^site2: Starting\. Deployment does not have minimum availability\.$/,
    );
  });
});

it("shows the Model URI rule's message once the user leaves an invalid URI", async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  const uri = await screen.findByRole('textbox', { name: /Model URI/ });
  await user.click(uri);
  await user.paste('https:///123.com');
  expect(screen.queryByText('Enter a model URI using hf, oci, s3 or pvc.')).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByText('Enter a model URI using hf, oci, s3 or pvc.')).toBeVisible();
  expect(uri).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.clear(uri);
  await user.paste('hf://org/widget');
  expect(screen.queryByText('Enter a model URI using hf, oci, s3 or pvc.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
});

it('says a required field is required once the user leaves it empty, and asks for no served name', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  const uri = await screen.findByRole('textbox', { name: /Model URI/ });
  // A model is served as its id, the name users send: there is no name to choose for it.
  expect(screen.queryByRole('textbox', { name: /^Model name/ })).not.toBeInTheDocument();
  await user.click(uri);
  await user.paste('hf://org/widget');
  await user.clear(uri);
  await user.tab();
  expect(uri).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getAllByText('Required')).toHaveLength(1);
});

it('says why the deployment step cannot continue when the CPU is invalid', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const cpu = screen.getByRole('textbox', { name: /^CPU/ });
  await user.clear(cpu);
  await user.paste('2 cores');
  await user.tab();
  expect(screen.getByText('Enter positive CPU cores or millicores, for example 2 or 500m.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('shows the Clusters error only after the user clears a selection', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await fillModel(user);
  const combobox = await screen.findByRole('combobox', { name: 'Clusters' });
  expect(screen.queryByText('Select at least one cluster.')).not.toBeInTheDocument();
  await user.click(combobox);
  await user.click(screen.getByRole('option', { name: optionName(cluster1) }));
  await user.click(screen.getByRole('option', { name: optionName(cluster1) }));
  await user.keyboard('{Escape}');
  expect(screen.getByText('Select at least one cluster.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('sends the URI trimmed and refuses other schemes', async () => {
  const service = new MockConsoleService();
  const create = vi.spyOn(modelsOf(service), 'create');
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  const uri = await screen.findByRole('textbox', { name: /Model URI/ });
  await user.click(uri);
  await user.paste('https://models.example.com/widget');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.clear(uri);
  await user.paste(' hf://org/widget ');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await pickAndDeploy(user, [cluster1]);
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0].object?.spec?.model?.uri).toBe('hf://org/widget');
});

it.each([
  ['/models/granite-research', /Granite research endpoint/],
  ['/models/granite-research/edit', 'Edit model'],
])('offers Retry when a model fails to load: %s', async (path, heading) => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const get = vi.spyOn(models, 'get').mockImplementationOnce(unavailable);
  const user = userEvent.setup();
  renderAt(path, service);
  expect(await screen.findByRole('heading', { name: 'Unable to load model' })).toBeVisible();
  get.mockRestore();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeVisible();
  expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
});

describe('a background poll', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("keeps a model's page under a warning when it fails, so stale data doesn't look current", async () => {
    const service = new MockConsoleService();
    renderAt('/models/granite-research', service);
    expect(await screen.findByRole('heading', { level: 1, name: 'Granite research endpoint' })).toBeVisible();
    vi.spyOn(modelsOf(service), 'get').mockImplementation(unavailable);
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(await screen.findByTestId('stale-data-alert')).toHaveTextContent('Showing the last loaded model');
    expect(screen.getByRole('heading', { level: 1, name: 'Granite research endpoint' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Deployment' })).toBeVisible();
  });

  it('keeps the list and shows the error above it', async () => {
    const service = new MockConsoleService();
    renderAt('/models', service);
    expect(await screen.findByTestId('model-deployments-table')).toHaveTextContent('Granite 3.3 8B Instruct');
    vi.spyOn(modelsOf(service), 'list').mockImplementation(unavailable);
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(await screen.findByText('Showing the last loaded models')).toBeVisible();
    expect(screen.getByTestId('model-deployments-table')).toHaveTextContent('Granite 3.3 8B Instruct');
  });

  it('deletes the version the user confirmed, not one a poll loaded while the dialog was open', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt('/models', service);
    await user.click(await screen.findByTestId('model-actions-granite-research'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByTestId('delete-deployment-modal');
    await user.click(within(dialog).getByTestId('delete-modal-input'));
    await user.paste('Granite research endpoint');
    models.find('granite-research').metadata!.version = 2;
    const poll = vi.spyOn(models, 'list');
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(poll).toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/the model changed since it was read; reload and retry/)).toBeVisible();
    expect(models.models.some((m) => m.id === 'granite-research')).toBe(true);
  });

  it("keeps an open cluster's status current, closes it when the cluster goes, and doesn't reopen it", async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const granite = models.find('granite-3-8b');
    granite.status!.clusters[0].phase = ModelPhase.PENDING;
    granite.status!.clusters[0].reason = 'NotReady';
    granite.status!.clusters[0].deployment = ModelDeploymentState.UNSPECIFIED;
    granite.status!.clusters[0].sync = ModelSyncState.SYNCED;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt('/models', service);
    await user.click(within(await rowOf('granite-3-8b')).getByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Synced on site1' }));
    const modal = await screen.findByRole('dialog', { name: 'Granite 3.3 8B Instruct on site1' });
    const reported = within(modal).getByLabelText('What site1 reported');
    const deployment = () =>
      within(reported).getByText('Model on the cluster').closest('.pf-v6-c-description-list__group');
    expect(deployment()).toHaveTextContent(/^Model on the clusterNot deployed yet$/);
    granite.status!.clusters[0].deployment = ModelDeploymentState.RUNNING;
    await act(() => vi.advanceTimersByTimeAsync(30000));
    await waitFor(() => expect(deployment()).toHaveTextContent(/^Model on the clusterRunning$/));
    const reports = granite.status!.clusters;
    granite.status!.clusters = [];
    await act(() => vi.advanceTimersByTimeAsync(30000));
    await waitFor(() => expect(modal).not.toBeInTheDocument());
    // The report comes back: the dialog stays closed until the user opens it again.
    granite.status!.clusters = reports;
    await act(() => vi.advanceTimersByTimeAsync(30000));
    const again = await screen.findByRole('button', { name: 'Ready on site1' });
    expect(screen.queryByRole('dialog', { name: 'Granite 3.3 8B Instruct on site1' })).not.toBeInTheDocument();
    await user.click(again);
    expect(await screen.findByRole('dialog', { name: 'Granite 3.3 8B Instruct on site1' })).toBeVisible();
  });
});

describe('polling while a model is still changing', () => {
  // Only the polls are faked (refetchInterval's setInterval); user-event, findBy and the tooltips keep real timers.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  /** Sets granite-3-8b's phase, and its one cluster's, as the backend would report them. */
  const setPhase = (service: MockConsoleService, phase: ModelPhase) => {
    const granite = modelsOf(service).find('granite-3-8b');
    granite.status!.phase = phase;
    granite.status!.clusters[0].phase = phase;
    granite.status!.clusters[0].deployment =
      phase === ModelPhase.READY ? ModelDeploymentState.RUNNING : ModelDeploymentState.STARTING;
  };

  it('polls the list every 10 seconds while a model is Pending, and every 30 once none is', async () => {
    const service = new MockConsoleService();
    setPhase(service, ModelPhase.PENDING);
    renderAt('/models', service);
    expect(await rowOf('granite-3-8b')).toHaveTextContent('Starting');
    setPhase(service, ModelPhase.READY);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(async () => expect(await rowOf('granite-3-8b')).toHaveTextContent('Ready'));
    setPhase(service, ModelPhase.PENDING);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(await rowOf('granite-3-8b')).toHaveTextContent('Ready');
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await waitFor(async () => expect(await rowOf('granite-3-8b')).toHaveTextContent('Starting'));
  });

  it('polls sooner while one placed cluster is still Pending', async () => {
    const service = new MockConsoleService();
    modelsOf(service).find('granite-3-8b').status!.clusters[0].phase = ModelPhase.PENDING;
    modelsOf(service).find('granite-3-8b').status!.clusters[0].deployment = ModelDeploymentState.STARTING;
    const list = vi.spyOn(modelsOf(service), 'list');
    renderAt('/models', service);
    await rowOf('granite-3-8b');
    const loaded = list.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(loaded));
  });

  it("polls a model's page every 10 seconds while it is Saved to Git", async () => {
    const service = new MockConsoleService();
    const granite = modelsOf(service).find('granite-3-8b');
    const report = { ...granite.status! };
    granite.status!.phase = ModelPhase.UNSPECIFIED;
    granite.status!.reason = 'SavedToGit';
    granite.status!.clusters = [];
    renderAt('/models/granite-3-8b', service);
    expect(await screen.findByRole('heading', { level: 1, name: 'Granite 3.3 8B Instruct' })).toBeVisible();
    expect(screen.getByTestId('model-phase')).toHaveTextContent('Saved to Git');
    Object.assign(granite.status!, report);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(screen.getByTestId('model-phase')).toHaveTextContent('Ready'));
  });

  it('keeps 30 seconds for a model stopped everywhere, which stays so until someone starts it', async () => {
    const service = new MockConsoleService();
    const granite = modelsOf(service).find('granite-3-8b');
    granite.status!.phase = ModelPhase.PENDING;
    granite.status!.reason = 'Stopped';
    granite.status!.deployment = ModelDeploymentState.STOPPED;
    granite.status!.clusters[0].phase = ModelPhase.PENDING;
    granite.status!.clusters[0].deployment = ModelDeploymentState.STOPPED;
    granite.status!.clusters[0].sync = ModelSyncState.SYNCED;
    const list = vi.spyOn(modelsOf(service), 'list');
    renderAt('/models', service);
    await rowOf('granite-3-8b');
    const loaded = list.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(list.mock.calls.length).toBe(loaded);
  });

  it('polls sooner while a cluster has not applied the change yet', async () => {
    const service = new MockConsoleService();
    const granite = modelsOf(service).find('granite-3-8b');
    // Argo CD applying a new model: nothing on the cluster yet.
    granite.status!.clusters[0].deployment = ModelDeploymentState.UNSPECIFIED;
    granite.status!.clusters[0].sync = ModelSyncState.OUT_OF_SYNC;
    const list = vi.spyOn(modelsOf(service), 'list');
    renderAt('/models', service);
    await rowOf('granite-3-8b');
    const loaded = list.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(loaded));
  });

  it('keeps 30 seconds for a cluster that stays Out of sync while serving, such as drift', async () => {
    const service = new MockConsoleService();
    const granite = modelsOf(service).find('granite-3-8b');
    // As the backend reports drift: the model and the cluster Pending, the old revision serving.
    granite.status!.phase = ModelPhase.PENDING;
    granite.status!.clusters[0].phase = ModelPhase.PENDING;
    granite.status!.clusters[0].deployment = ModelDeploymentState.RUNNING;
    granite.status!.clusters[0].sync = ModelSyncState.OUT_OF_SYNC;
    const list = vi.spyOn(modelsOf(service), 'list');
    renderAt('/models', service);
    await rowOf('granite-3-8b');
    const loaded = list.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(list.mock.calls.length).toBe(loaded);
  });

  it('still polls sooner while one cluster is stopped and another Pending', async () => {
    const service = new MockConsoleService();
    const granite = modelsOf(service).find('granite-3-8b');
    granite.status!.phase = ModelPhase.PENDING;
    granite.status!.clusters[0].phase = ModelPhase.PENDING;
    granite.status!.clusters[0].deployment = ModelDeploymentState.STOPPED;
    granite.status!.clusters.push({
      ...granite.status!.clusters[0],
      cluster: 'site2',
      deployment: ModelDeploymentState.STARTING,
    });
    const list = vi.spyOn(modelsOf(service), 'list');
    renderAt('/models', service);
    await rowOf('granite-3-8b');
    const loaded = list.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(loaded));
  });

  it('keeps 30 seconds for a model stopped everywhere that MaaS therefore never publishes', async () => {
    const service = new MockConsoleService();
    const granite = modelsOf(service).find('granite-3-8b');
    granite.status!.phase = ModelPhase.PENDING;
    granite.status!.clusters[0].phase = ModelPhase.PENDING;
    granite.status!.clusters[0].deployment = ModelDeploymentState.STOPPED;
    granite.status!.clusters[0].sync = ModelSyncState.SYNCED;
    granite.status!.ingress = [
      create(ModelIngressStatusSchema, {
        cluster: 'site1',
        state: ModelMaasState.CONFIGURING_ROUTING,
        message: 'Governed but backend is not ready',
      }),
    ];
    const list = vi.spyOn(modelsOf(service), 'list');
    renderAt('/models', service);
    await rowOf('granite-3-8b');
    const loaded = list.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(list.mock.calls.length).toBe(loaded);
  });

  it.each([ModelSyncState.SYNCED, ModelSyncState.FAILED])(
    'polls sooner while a running model waits for MaaS to publish it, with sync %s',
    async (sync) => {
      const service = new MockConsoleService();
      const granite = modelsOf(service).find('granite-3-8b');
      granite.status!.clusters[0].deployment = ModelDeploymentState.RUNNING;
      granite.status!.clusters[0].sync = sync;
      granite.status!.clusters[0].state = sync === ModelSyncState.FAILED ? ModelState.FAILED : ModelState.READY;
      granite.status!.ingress = [
        create(ModelIngressStatusSchema, {
          cluster: 'site1',
          state: ModelMaasState.CONFIGURING_ROUTING,
          message: 'Governed but backend is not ready',
        }),
      ];
      const list = vi.spyOn(modelsOf(service), 'list');
      renderAt('/models', service);
      await rowOf('granite-3-8b');
      const loaded = list.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(loaded));
    },
  );

  it('keeps 30 seconds for a model without a placement, which changes only when edited', async () => {
    const service = new MockConsoleService();
    const list = vi.spyOn(modelsOf(service), 'list');
    // granite-research is Pending and has no placement; the other seeds are Ready.
    renderAt('/models', service);
    await rowOf('granite-research');
    const loaded = list.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(list.mock.calls.length).toBe(loaded);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(loaded));
  });
});

it('reloads the model after a stale delete, so a retry succeeds', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-granite-research'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Granite research endpoint');
  models.find('granite-research').metadata!.version = 2;
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText(/the model changed since it was read/)).toBeVisible();
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('delete-deployment-modal')).not.toBeInTheDocument());
  expect(models.models.some((m) => m.id === 'granite-research')).toBe(false);
});

it('keeps the delete dialog busy until the reloaded model is in, and says when the reload fails', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-granite-research'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Granite research endpoint');
  models.find('granite-research').metadata!.version = 2;
  const remove = vi.spyOn(models, 'delete');
  const reload = deferred<void>();
  const get = models.get;
  const reloadSpy = vi.spyOn(models, 'get').mockImplementationOnce(async (req, ctx) => {
    await reload.promise;
    return get(req, ctx);
  });
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  // The reload is still out: Delete stays busy, so no retry with the stale version.
  expect(within(dialog).getByRole('button', { name: /Delete/ })).toBeDisabled();
  await user.type(within(dialog).getByTestId('delete-modal-input'), '{Enter}');
  expect(remove).toHaveBeenCalledTimes(1);
  await act(async () => reload.resolve());
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled());

  // A second stale delete whose reload fails says so.
  models.find('granite-research').metadata!.version = 3;
  reloadSpy.mockImplementationOnce(unavailable);
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await within(dialog).findByText(/Unable to reload the latest version/)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
});

it('takes a display name longer than a resource name', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await nameDeployment(user, 'W'.repeat(70));
  expect(screen.getByText('w'.repeat(63))).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
});

it('starts the deployment name from the model URI, and keeps a name the user typed', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  expect(await screen.findByRole('button', { name: 'Back' })).toBeDisabled();
  await user.click(screen.getByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByTestId('model-name-desc-name')).toHaveValue('widget');
  await nameDeployment(user, 'My widget');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByTestId('model-name-desc-name')).toHaveValue('My widget');
});

it('folds the runtime arguments away under Advanced settings, with no dead controls', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const args = await screen.findByTestId('runtime-args-textarea');
  expect(args).not.toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
  expect(args).toBeVisible();
  expect(screen.queryByRole('button', { name: 'View predefined arguments' })).not.toBeInTheDocument();
});

it('asks before Cancel discards the wizard input', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  // Nothing typed yet: Cancel leaves at once.
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Deploy model' }));
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const discard = await screen.findByTestId('discard-changes-modal');
  await user.click(within(discard).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByRole('textbox', { name: /Model URI/ })).toHaveValue('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
});

it("opens a model page with its configuration, its endpoint and each cluster's status", async () => {
  const service = new MockConsoleService();
  const granite = modelsOf(service).find('granite-3-8b');
  granite.status!.url = 'https://granite.example.com/v1';
  granite.status!.clusters[0].deployment = ModelDeploymentState.RUNNING;
  granite.status!.clusters[0].sync = ModelSyncState.SYNCED;
  granite.status!.clusters[0].viewUrl =
    'https://rh-ai.apps.site1.example.com/ai-hub/models/deployments/internal/models';
  granite.status!.clusters[0].viewTarget = ModelViewTarget.OPENSHIFT_AI;
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByRole('link', { name: 'Granite 3.3 8B Instruct' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Granite 3.3 8B Instruct' })).toBeVisible();
  expect(screen.getByText('hf://example-org/granite-3-8b')).toBeVisible();
  expect(screen.getByText('https://granite.example.com/v1')).toBeVisible();
  // Deployed on OpenShift AI's CPU preset, before the console stopped sending presets.
  expect(screen.getByText('v3-6-0-kserve-config-llm-template-cpu')).toBeVisible();
  const section = screen.getByTestId('model-clusters');
  expect(within(section).getByRole('grid', { name: 'Clusters of Granite 3.3 8B Instruct' })).toBeVisible();
  expect(within(section).getByRole('link', { name: 'View on the AI grid map' })).toHaveAttribute(
    'href',
    '/ai-grid?model=granite-3-8b',
  );
  const [row] = await tableRows('Clusters of Granite 3.3 8B Instruct', section);
  expect(row).toHaveTextContent('site1');
  expect(row).toHaveTextContent('us-west');
  expect(within(row).getByRole('link', { name: 'site1' })).toHaveAttribute('href', '/clusters/site1');
  expect(within(row).getByRole('link', { name: 'View on site1 in OpenShift AI' })).toHaveAttribute(
    'href',
    'https://rh-ai.apps.site1.example.com/ai-hub/models/deployments/internal/models',
  );
  await user.click(await within(section).findByRole('button', { name: 'Ready on site1' }));
  const modal = await screen.findByRole('dialog', { name: 'Granite 3.3 8B Instruct on site1' });
  expect(within(modal).getByRole('heading', { name: /Granite 3.3 8B Instruct status/ })).toBeVisible();
  expect(modal).toHaveTextContent('LLMInferenceService ready');
  expect(modal).toHaveTextContent('Git syncSynced');
});

it('says a model without clusters has none', async () => {
  renderAt('/models/llama-3-70b', new MockConsoleService());
  expect(await screen.findByText('To serve this model, select one or more clusters.')).toBeVisible();
});

it('deletes a model from its page and returns to the list', async () => {
  const user = userEvent.setup();
  renderAt('/models/granite-research', new MockConsoleService());
  await user.click(await screen.findByTestId('model-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Granite research endpoint');
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Model Granite research endpoint deleted from Git')).toBeVisible();
  expect(await screen.findByTestId('model-deployments-table')).not.toHaveTextContent('Granite research endpoint');
});

it('says when a model page has no model', async () => {
  renderAt('/models/nope', new MockConsoleService());
  expect(await screen.findByText('Model not found')).toBeVisible();
});

it('loads only the one model on its page and its edit page', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const list = vi.spyOn(models, 'list');
  const get = vi.spyOn(models, 'get');
  const page = renderAt('/models/granite-3-8b', service);
  expect(await screen.findByRole('heading', { level: 1, name: 'Granite 3.3 8B Instruct' })).toBeVisible();
  page.unmount();
  renderAt('/models/granite-3-8b/edit', service);
  expect(await screen.findByRole('navigation', { name: 'Wizard steps' })).toBeVisible();
  expect(get.mock.calls.map(([req]) => req.id)).toEqual(['granite-3-8b', 'granite-3-8b']);
  expect(list).not.toHaveBeenCalled();
});

it('takes only whole numbers in the number fields, so the shown and sent counts agree', async () => {
  const service = new MockConsoleService();
  const create = vi.spyOn(modelsOf(service), 'create');
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
  // 1e1 and 1.5 would show as 1 but parse as 10 and 1.5: they're refused.
  fireEvent.change(replicas, { target: { value: '1e1' } });
  expect(replicas).toHaveValue(1);
  fireEvent.change(replicas, { target: { value: '1.5' } });
  expect(replicas).toHaveValue(1);
  fireEvent.change(replicas, { target: { value: '3' } });
  expect(replicas).toHaveValue(3);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const review = await pickAndDeploy(user, [cluster1], { submit: false });
  expect(review).toHaveTextContent('Replicas3');
  await user.click(screen.getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0].object?.spec?.replicas).toBe(3);
});

it('keeps an emptied Replicas or GPUs field empty and says it is required', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  for (const name of ['Replicas', 'GPUs']) {
    const field = screen.getByRole('spinbutton', { name });
    await user.clear(field);
    await user.tab();
    expect(field).toHaveValue(null);
    expect(field).toHaveAccessibleDescription(/^Required : error status;$/);
  }
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

describe('the hardware', () => {
  const cpuImage =
    'registry.redhat.io/rhaii/vllm-cpu-rhel9@sha256:0ec0f5ff9a5ff263f58db0cfb19e3d7eef24b94c2d8629fe5145f5a8747e28c9';
  const cpuImageName = 'vLLM CPU 0.18.0 (OpenShift AI 3.6)';
  const defaultImageHelp = "Leave empty to use the cluster's default vLLM image for NVIDIA GPUs.";

  /** Fills the source step, opens Deployment, and returns the Models/Create spy. */
  const openDeployment = async (user: User, service = new MockConsoleService()) => {
    const create = vi.spyOn(modelsOf(service), 'create');
    renderAt('/models/deploy', service);
    await user.type(await screen.findByRole('textbox', { name: /Model URI/ }), 'hf://org/widget');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    return create;
  };

  const toReview = async (user: User, submit = true) => {
    await user.click(screen.getByRole('button', { name: 'Next' }));
    return pickAndDeploy(user, [cluster1], { submit });
  };

  const field = (name: string | RegExp) => screen.getByRole('textbox', { name });

  it('is the BFF’s built-in list when the chart sets none', () => {
    expect(new MockConsoleService().config.models).toEqual(configExample.body.data.models);
  });

  it('starts on NVIDIA GPU and deploys it with no image, no presets, and one GPU', async () => {
    const user = userEvent.setup();
    const create = await openDeployment(user);
    expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'CPU only' })).not.toBeChecked();
    expect(screen.getByText('For x86_64 clusters without GPUs.')).toBeVisible();
    expect(field(/Runtime image/)).toHaveValue('');
    expect(field(/Runtime image/)).toHaveAccessibleDescription(defaultImageHelp);
    expect(field(/^CPU/)).toHaveValue('2');
    expect(field(/^Memory/)).toHaveValue('16Gi');
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(1);
    const review = await toReview(user, false);
    expect(review).toHaveTextContent('HardwareNVIDIA GPU');
    expect(review).toHaveTextContent("Runtime imageDefault (the cluster's vLLM image for NVIDIA GPUs)");
    expect(review).toHaveTextContent('GPUs1');
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const spec = create.mock.calls[0][0].object?.spec;
    expect(spec?.baseRefs).toEqual([]);
    expect(spec?.main?.image).toBe('');
    // The request only: the backend saves it as the limit too (ModelContainer.requests).
    expect(spec?.main?.requests).toEqual({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' });
    expect(spec?.main?.limits).toEqual({});
    expect(spec?.main?.env).toEqual([]);
  });

  it('keeps naming CPU only’s image when the field only gains surrounding spaces', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    await selectHardware(user, 'CPU only');
    await user.type(field(/Runtime image/), ' ');
    expect(field(/Runtime image/)).toHaveAccessibleDescription(
      `Set by CPU only: ${cpuImageName}. Replace it to use another vLLM image.`,
    );
  });

  it('fills in CPU only’s image and resources, and sends its environment with the runtime arguments', async () => {
    const user = userEvent.setup();
    const create = await openDeployment(user);
    await selectHardware(user, 'CPU only');
    expect(screen.queryByRole('spinbutton', { name: 'GPUs' })).not.toBeInTheDocument();
    expect(field(/Runtime image/)).toHaveValue(cpuImage);
    expect(field(/Runtime image/)).toHaveAccessibleDescription(
      `Set by CPU only: ${cpuImageName}. Replace it to use another vLLM image.`,
    );
    expect(field(/^CPU/)).toHaveValue('4');
    expect(field(/^Memory/)).toHaveValue('8Gi');
    await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
    await user.click(screen.getByRole('textbox', { name: 'Additional runtime arguments' }));
    await user.paste('--max-model-len 4096');
    const review = await toReview(user, false);
    expect(review).toHaveTextContent('HardwareCPU only');
    expect(review).toHaveTextContent(`Runtime image${cpuImageName}${cpuImage}`);
    expect(within(review).queryByText('GPUs')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const spec = create.mock.calls[0][0].object?.spec;
    expect(spec?.baseRefs).toEqual([]);
    expect(spec?.main?.image).toBe(cpuImage);
    expect(spec?.main?.requests).toEqual({ cpu: '4', memory: '8Gi' });
    expect(spec?.main?.env.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'OMP_NUM_THREADS', value: '4' },
      { name: 'VLLM_CPU_KVCACHE_SPACE', value: '4' },
      { name: 'VLLM_ADDITIONAL_ARGS', value: '--max-model-len 4096' },
    ]);
  });

  it('gives each hardware its own image, and keeps the CPU, memory, and GPUs the user edited', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    const cpu = field(/^CPU/);
    await user.clear(cpu);
    await user.paste('3');
    const memory = field(/^Memory/);
    await user.clear(memory);
    await user.paste('12Gi');
    const gpus = screen.getByRole('spinbutton', { name: 'GPUs' });
    await user.clear(gpus);
    await user.type(gpus, '2');
    // An image typed for NVIDIA GPU is not CPU only's: selecting other hardware replaces it.
    await user.click(field(/Runtime image/));
    await user.paste('registry.example/vllm-cuda:mine');
    await selectHardware(user, 'CPU only');
    expect(field(/Runtime image/)).toHaveValue(cpuImage);
    expect(field(/Runtime image/)).toHaveAccessibleDescription(
      `Set by CPU only: ${cpuImageName}. Replace it to use another vLLM image.`,
    );
    expect(field(/^CPU/)).toHaveValue('3');
    expect(field(/^Memory/)).toHaveValue('12Gi');
    await setImage(user, 'registry.example/vllm-cpu:mine');
    await selectHardware(user, 'NVIDIA GPU');
    expect(field(/Runtime image/)).toHaveValue('');
    expect(field(/^CPU/)).toHaveValue('3');
    expect(field(/^Memory/)).toHaveValue('12Gi');
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(2);
  });

  it('shows the image name on Review with the digest as secondary text, and the raw image once it is edited', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    await selectHardware(user, 'CPU only');
    let review = await toReview(user, false);
    const runtime = within(review).getByText('Runtime image').closest('div') as HTMLElement;
    expect(within(runtime).getByText(cpuImageName)).toBeVisible();
    expect(within(runtime).getByText(cpuImage)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await setImage(user, 'registry.example/vllm-cpu:mine');
    // The name belongs to the hardware's image, not to one typed over it.
    expect(field(/Runtime image/)).toHaveAccessibleDescription(
      'Set by the selected hardware. Replace it to use another vLLM image.',
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    review = await screen.findByTestId('model-review');
    expect(review).toHaveTextContent('Runtime imageregistry.example/vllm-cpu:mine');
    expect(review).not.toHaveTextContent(cpuImageName);
  });

  describe('on the model details page', () => {
    /** A model "widget" whose runtime image is this one, opened at its page. */
    const openWidget = (image: string) => {
      const service = new MockConsoleService();
      const models = widget(service);
      models.models[models.models.length - 1].spec!.main!.image = image;
      renderAt('/models/widget', service);
    };

    it('names the image the hardware list names, with its digest to copy', async () => {
      openWidget(` ${cpuImage} `);
      const term = await screen.findByText('Runtime image');
      const row = term.closest('div') as HTMLElement;
      expect(row).toHaveTextContent(`Runtime image${cpuImageName} ${cpuImage}`);
      expect(within(row).getByRole('button', { name: 'Copy the runtime image' })).toBeVisible();
    });

    it('shows an image the list does not have as it is', async () => {
      openWidget('registry.example/runtime:test');
      const row = (await screen.findByText('Runtime image')).closest('div') as HTMLElement;
      expect(row).toHaveTextContent('Runtime imageregistry.example/runtime:test');
      expect(row).not.toHaveTextContent(cpuImageName);
      expect(within(row).queryByRole('button', { name: 'Copy the runtime image' })).not.toBeInTheDocument();
    });
  });

  it('shows the raw image for hardware without an image name', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    service.config = {
      ...service.config,
      models: { hardware: [{ id: 'gaudi', label: 'Intel Gaudi', accelerator: 'habana.ai/gaudi', image: 'r/gaudi:1' }] },
    };
    await openDeployment(user, service);
    expect(field(/Runtime image/)).toHaveAccessibleDescription(
      'Set by the selected hardware. Replace it to use another vLLM image.',
    );
    const review = await toReview(user, false);
    expect(review).toHaveTextContent('Runtime imager/gaudi:1');
  });

  it('names the accelerator field after the accelerator, and requests it by its resource', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    service.config = {
      ...service.config,
      models: {
        hardware: [
          {
            id: 'amd-gpu',
            label: 'AMD GPU',
            accelerator: 'amd.com/gpu',
            defaults: { accelerators: 2, cpu: '4', memory: '32Gi' },
          },
          { id: 'gaudi', label: 'Intel Gaudi', accelerator: 'habana.ai/gaudi', image: 'registry.example/vllm-gaudi:1' },
        ],
      },
    };
    const create = await openDeployment(user, service);
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(2);
    // The cluster's default image is for NVIDIA GPUs: other hardware needs an image of its own.
    expect(field(/Runtime image/)).toBeRequired();
    expect(field(/Runtime image/)).toHaveAccessibleDescription('Enter a vLLM image for this hardware.');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(field(/Runtime image/));
    await user.tab();
    expect(field(/Runtime image/)).toHaveAccessibleDescription(/Required : error status;$/);
    await selectHardware(user, 'Intel Gaudi');
    expect(screen.getByRole('spinbutton', { name: 'Accelerators' })).toHaveValue(1);
    expect(field(/^Memory/)).toHaveValue('4Gi');
    await selectHardware(user, 'AMD GPU');
    await user.click(field(/Runtime image/));
    await user.paste('registry.example/vllm-rocm:1');
    await toReview(user);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].object?.spec?.main?.requests).toEqual({
      cpu: '4',
      memory: '32Gi',
      'amd.com/gpu': '2',
    });
  });

  it('refuses fewer than one GPU', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    const gpus = screen.getByRole('spinbutton', { name: 'GPUs' });
    await user.clear(gpus);
    await user.type(gpus, '0');
    await user.tab();
    expect(gpus).toHaveAccessibleDescription(/Enter a number from 1 to 64\./);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('refuses an image with spaces, and takes an emptied one', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    await user.type(field(/Runtime image/), 'bad image');
    await user.tab();
    expect(field(/Runtime image/)).toHaveAccessibleDescription(/Enter a container image without spaces\./);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await setImage(user, '');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(field(/Runtime image/)).not.toBeRequired();
  });

  describe('on a grid whose serving clusters have no GPUs', () => {
    const cpuOnlyService = () => {
      const clusters = seedClusters().map((c) => ({ ...c, gpuCapacity: 0 }));
      return new MockConsoleService(undefined, clusters);
    };

    it('starts on CPU only and deploys it with no accelerator and the CPU image', async () => {
      const user = userEvent.setup();
      const create = await openDeployment(user, cpuOnlyService());
      expect(await screen.findByRole('radio', { name: 'CPU only' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).not.toBeChecked();
      expect(field(/Runtime image/)).toHaveValue(cpuImage);
      await toReview(user);
      await waitFor(() => expect(create).toHaveBeenCalled());
      const spec = create.mock.calls[0][0].object?.spec;
      expect(spec?.main?.image).toBe(cpuImage);
      expect(spec?.main?.requests).toEqual({ cpu: '4', memory: '8Gi' });
    });

    it('keeps CPU only, not moving to NVIDIA GPU, when a later poll finds a GPU cluster', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const service = cpuOnlyService();
        await openDeployment(user, service);
        expect(await screen.findByRole('radio', { name: 'CPU only' })).toBeChecked();
        service.clusters = seedClusters();
        await act(() => vi.advanceTimersByTimeAsync(30000));
        expect(screen.getByRole('radio', { name: 'CPU only' })).toBeChecked();
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts on CPU only once a poll succeeds after the first cluster load failed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const service = cpuOnlyService();
        const list = service.listClusters;
        service.listClusters = unavailable;
        await openDeployment(user, service);
        expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
        service.listClusters = list;
        await act(() => vi.advanceTimersByTimeAsync(30000));
        await waitFor(() => expect(screen.getByRole('radio', { name: 'CPU only' })).toBeChecked());
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a selection made while the cluster load was failing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const service = cpuOnlyService();
        const list = service.listClusters;
        service.listClusters = unavailable;
        await openDeployment(user, service);
        await selectHardware(user, 'CPU only');
        await selectHardware(user, 'NVIDIA GPU');
        const answered = vi.fn(list);
        service.listClusters = answered;
        await act(() => vi.advanceTimersByTimeAsync(30000));
        await waitFor(() => expect(answered).toHaveBeenCalled());
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps NVIDIA GPU and an edit made before the clusters loaded', async () => {
      const user = userEvent.setup();
      const service = cpuOnlyService();
      const slow = deferred<void>();
      const list = service.listClusters;
      service.listClusters = async () => {
        await slow.promise;
        return list();
      };
      const create = await openDeployment(user, service);
      await user.click(field(/^CPU/));
      await user.clear(field(/^CPU/));
      await user.paste('6');
      expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
      slow.resolve();
      await toReview(user, false);
      // Only the loaded clusters say site1 has no GPUs, and only NVIDIA GPU makes that a mismatch:
      // the hint shows the clusters have loaded and the hardware held.
      expect(await screen.findByTestId('model-hardware-mismatch')).toHaveTextContent(
        "site1 reports no NVIDIA GPUs, so the model can't run there",
      );
      await user.click(screen.getByRole('button', { name: 'Deploy' }));
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0].object?.spec?.main?.requests?.cpu).toBe('6');
    });
  });

  it('requires an image for CPU only: the cluster’s default is for NVIDIA GPUs', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    await selectHardware(user, 'CPU only');
    expect(field(/Runtime image/)).toBeRequired();
    await setImage(user, '');
    await user.tab();
    expect(field(/Runtime image/)).toHaveAccessibleDescription(/Required : error status;$/);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('says on CPU that long-context models need --max-model-len', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    const hint = 'For long-context models on CPU, set --max-model-len in Advanced settings.';
    expect(field(/^Memory/)).not.toHaveAccessibleDescription(new RegExp(hint));
    await selectHardware(user, 'CPU only');
    expect(field(/^Memory/)).toHaveAccessibleDescription(`For example, 4Gi or 512Mi. ${hint}`);
  });

  it('waits for the console’s settings, and offers Retry when they fail to load', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    const getConfig = service.getConfig;
    service.getConfig = () => Promise.reject(new ServiceError(503, 'The console server is unavailable.'));
    await openDeployment(user, service);
    const alert = await screen.findByText('Unable to load hardware');
    expect(alert).toBeVisible();
    expect(screen.getByText('The console server is unavailable.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    service.getConfig = getConfig;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  describe('a hint on Review when the chosen clusters don’t suit the hardware', () => {
    const withGpus = (gpuCapacity: number) => {
      const service = new MockConsoleService();
      service.clusters = service.clusters.map((c) => (c.name === cluster1 ? { ...c, gpuCapacity } : c));
      return service;
    };

    it('says a cluster without NVIDIA GPUs can’t run NVIDIA GPU', async () => {
      const user = userEvent.setup();
      await openDeployment(user, withGpus(0));
      await toReview(user, false);
      expect(await screen.findByTestId('model-hardware-mismatch')).toHaveTextContent(
        "site1 reports no NVIDIA GPUs, so the model can't run there",
      );
    });

    it('says CPU only leaves a GPU cluster’s GPUs unused', async () => {
      const user = userEvent.setup();
      // The mock's member clusters each report 16 GPUs.
      await openDeployment(user);
      await selectHardware(user, 'CPU only');
      await toReview(user, false);
      expect(await screen.findByTestId('model-hardware-mismatch')).toHaveTextContent(
        "site1 has GPUs that the model doesn't use with CPU only",
      );
    });

    it('gives no hint for other accelerators: the clusters count NVIDIA GPUs only', async () => {
      const user = userEvent.setup();
      const service = withGpus(0);
      service.config = {
        ...service.config,
        models: { hardware: [{ id: 'amd-gpu', label: 'AMD GPU', accelerator: 'amd.com/gpu', image: 'r/rocm:1' }] },
      };
      await openDeployment(user, service);
      await toReview(user, false);
      expect(await screen.findByTestId('model-review')).toBeVisible();
      expect(screen.queryByTestId('model-hardware-mismatch')).not.toBeInTheDocument();
    });

    it('matches the chosen clusters by name, not by location label', async () => {
      const user = userEvent.setup();
      const service = new MockConsoleService();
      // site1 has GPUs, so NVIDIA GPU suits it. site2 has none and a location label that happens to
      // equal site1's name; it isn't chosen, so it mustn't be warned about.
      service.clusters = service.clusters.map((c) =>
        c.name === cluster2 ? { ...c, gpuCapacity: 0, location: cluster1 } : c,
      );
      await openDeployment(user, service);
      await toReview(user, false);
      expect(await screen.findByTestId('model-review')).toBeVisible();
      expect(screen.queryByTestId('model-hardware-mismatch')).not.toBeInTheDocument();
    });
  });

  describe('a deployed model', () => {
    const openDeploymentStep = async (user: User) =>
      user.click(
        within(await screen.findByRole('navigation', { name: 'Wizard steps' })).getByRole('button', {
          name: 'Deployment',
        }),
      );

    /** granite-3-8b deployed without presets, with these requests, image and env. */
    const deployed = (requests: Record<string, string>, image: string, env: Record<string, string> = {}) => {
      const service = new MockConsoleService();
      const granite = modelsOf(service).find('granite-3-8b');
      granite.spec!.baseRefs = [];
      granite.spec!.main!.requests = requests;
      granite.spec!.main!.image = image;
      granite.spec!.main!.env = Object.entries(env).map(([name, value]) => ({
        $typeName: 'ai_grid.v1.ModelEnvVar',
        name,
        value,
      }));
      return service;
    };

    it('shows the accelerator it requests and its image on its page, and its edit starts on the hardware it matches', async () => {
      const service = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' }, '');
      const page = renderAt('/models/granite-3-8b', service);
      const details = await screen.findByLabelText('Deployment');
      expect(details).toHaveTextContent('Accelerators1 GPU (nvidia.com/gpu)');
      expect(details).toHaveTextContent("Runtime imageDefault (the cluster's vLLM image for NVIDIA GPUs)");
      expect(details).not.toHaveTextContent('Hardware');
      expect(details).not.toHaveTextContent('Presets');
      page.unmount();
      const user = userEvent.setup();
      renderAt('/models/granite-3-8b/edit', service);
      await openDeploymentStep(user);
      // NVIDIA GPU deploys exactly this: one nvidia.com/gpu, no image, no environment.
      expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'CPU only' })).not.toBeChecked();
      expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(1);
      expect(field(/^CPU/)).toHaveValue('2');
      expect(field(/^Memory/)).toHaveValue('16Gi');
      expect(screen.queryByRole('textbox', { name: 'Accelerators' })).not.toBeInTheDocument();
      await user.click(
        within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name: 'Review' }),
      );
      const review = await screen.findByTestId('model-review');
      expect(review).toHaveTextContent('HardwareNVIDIA GPU');
      expect(review).toHaveTextContent('GPUs1');
      // Nothing changed yet.
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('words what a model requests without the console’s hardware list, which may have changed or not load', async () => {
      const cpu = deployed({ cpu: '4', memory: '8Gi' }, 'registry.example/vllm-cpu:old', { OMP_NUM_THREADS: '4' });
      cpu.getConfig = () => Promise.reject(new ServiceError(503, 'The console server is unavailable.'));
      const first = renderAt('/models/granite-3-8b', cpu);
      const details = await screen.findByLabelText('Deployment');
      expect(details).toHaveTextContent('AcceleratorsNone (CPU only)');
      expect(details).toHaveTextContent('Runtime imageregistry.example/vllm-cpu:old');
      first.unmount();
      renderAt('/models/granite-3-8b', deployed({ 'amd.com/gpu': '2', 'habana.ai/gaudi': '1' }, 'r/vllm:1'));
      expect(await screen.findByLabelText('Deployment')).toHaveTextContent(
        'Accelerators2 GPUs (amd.com/gpu), 1 accelerator (habana.ai/gaudi)',
      );
    });

    it('keeps an image on a model without NVIDIA GPUs: the cluster’s default is for NVIDIA GPUs', async () => {
      const service = deployed({ cpu: '4', memory: '8Gi' }, cpuImage);
      const user = userEvent.setup();
      renderAt('/models/granite-3-8b/edit', service);
      await openDeploymentStep(user);
      const image = await screen.findByRole('textbox', { name: /Runtime image/ });
      expect(image).toBeRequired();
      expect(image).toHaveAccessibleDescription("Enter a vLLM image for the model's hardware.");
      await setImage(user, '');
      await user.tab();
      expect(screen.getByRole('textbox', { name: /Runtime image/ })).toHaveAccessibleDescription(
        /Required : error status;$/,
      );
      expect(
        within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name: 'Review' }),
      ).toBeDisabled();
    });

    it('saves an edit of a stored model without an image, NVIDIA GPUs, or presets, leaving its image alone', async () => {
      const service = deployed({ cpu: '4', memory: '8Gi' }, '');
      const update = vi.spyOn(modelsOf(service), 'update');
      const user = userEvent.setup();
      renderAt('/models/granite-3-8b/edit', service);
      await openDeploymentStep(user);
      const description = await screen.findByRole('textbox', { name: 'Description' });
      await user.clear(description);
      await user.paste('Edited');
      await user.click(
        within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name: 'Review' }),
      );
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(update).toHaveBeenCalled());
      expect(update.mock.calls[0][0].updateMask?.paths).toEqual(['metadata.annotations']);
    });

    it('says a cleared image runs the presets’ image, on NVIDIA GPUs too', async () => {
      const service = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' }, 'registry.example/vllm-cuda:1');
      modelsOf(service).find('granite-3-8b').spec!.baseRefs = ['custom-preset'];
      const user = userEvent.setup();
      renderAt('/models/granite-3-8b/edit', service);
      await openDeploymentStep(user);
      expect(await screen.findByRole('textbox', { name: /Runtime image/ })).toHaveAccessibleDescription(
        'Leave empty to use the image the presets set.',
      );
    });

    it('shows its presets read-only, beside what it requests', async () => {
      const service = new MockConsoleService();
      modelsOf(service).find('granite-3-8b').spec!.baseRefs = ['custom-preset'];
      const user = userEvent.setup();
      renderAt('/models/granite-3-8b/edit', service);
      await openDeploymentStep(user);
      const presets = await screen.findByRole('textbox', { name: 'Presets' });
      expect(presets).toHaveValue('custom-preset');
      expect(presets).toHaveAttribute('readonly');
      expect(presets).toHaveAccessibleDescription(
        'Set when the model was deployed. New models are deployed without presets.',
      );
      expect(screen.queryByRole('textbox', { name: 'Hardware' })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Accelerators' })).toHaveValue('None (CPU only)');
    });

    it('clears the image of a model on NVIDIA GPUs in an edit, and sends no presets', async () => {
      const service = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' }, 'registry.example/vllm-cuda:1');
      const update = vi.spyOn(modelsOf(service), 'update');
      const user = userEvent.setup();
      renderAt('/models/granite-3-8b/edit', service);
      await openDeploymentStep(user);
      expect(await screen.findByRole('textbox', { name: /Runtime image/ })).toHaveAccessibleDescription(
        defaultImageHelp,
      );
      await setImage(user, '');
      await user.click(
        within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name: 'Review' }),
      );
      expect(await screen.findByTestId('model-review')).toHaveTextContent(
        "Runtime imageDefault (the cluster's vLLM image for NVIDIA GPUs)",
      );
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(update).toHaveBeenCalled());
      const [request] = update.mock.calls[0];
      expect(request.updateMask?.paths).toEqual(['spec.main.image']);
      expect(request.object?.spec?.main?.image).toBe('');
      expect(request.object?.spec?.baseRefs).toEqual([]);
    });
  });
});

describe('editing a model deployment', () => {
  const openStep = async (user: User, name: 'Source' | 'Deployment' | 'Clusters' | 'Review') =>
    user.click(within(await screen.findByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name }));

  it('reuses the deploy wizard: the served name read-only, every step open, and only the changed paths sent', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b', service);
    await user.click(await screen.findByRole('button', { name: 'Actions for Granite 3.3 8B Instruct' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit model' })).toBeVisible();
    // The title is the action; the description names the model, and the breadcrumb keeps its name.
    expect(
      screen.getByText((_, el) =>
        el?.tagName === 'P'
          ? el.textContent === 'Make changes to the configuration of the Granite 3.3 8B Instruct model.'
          : false,
      ),
    ).toBeVisible();
    expect(screen.getByText('Granite 3.3 8B Instruct', { selector: 'strong' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Granite 3.3 8B Instruct' })).toHaveAttribute(
      'href',
      '/models/granite-3-8b',
    );
    expect(screen.getByRole('textbox', { name: /^Model URI/ })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: /^Model URI/ })).toHaveValue('hf://example-org/granite-3-8b');
    expect(screen.getByRole('textbox', { name: 'Model name in requests' })).toHaveAttribute('readonly');
    await openStep(user, 'Review');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await openStep(user, 'Deployment');
    expect(screen.getByRole('textbox', { name: /^CPU/ })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: /^CPU/ })).toHaveValue('2');
    expect(screen.getByRole('textbox', { name: 'Presets' })).toHaveAttribute('readonly');
    const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.paste('3');
    await openStep(user, 'Clusters');
    await user.click(await screen.findByRole('combobox', { name: 'Clusters' }));
    await user.click(screen.getByRole('option', { name: optionName(cluster2) }));
    await user.keyboard('{Escape}');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes to model Granite 3.3 8B Instruct saved to Git')).toBeVisible();
    const [request] = update.mock.calls[0];
    expect(request.updateMask?.paths).toEqual(['spec.replicas', 'spec.placement']);
    expect(request.lock).toBe(true);
    expect(request.object?.metadata?.version).toBe(1);
    expect(request.object?.spec?.replicas).toBe(3);
    expect(request.object?.spec?.placement?.labelSelector?.matchExpressions[0].values).toEqual(['site1', 'site2']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Granite 3.3 8B Instruct' })).toBeVisible();
    expect(await within(screen.getByTestId('model-clusters')).findByText('site2')).toBeVisible();
  });

  it('sends the annotations and the env whole, keeping what the console doesn’t edit', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const granite = models.find('granite-3-8b');
    granite.metadata!.annotations.team = 'research';
    granite.spec!.main!.env = [{ $typeName: 'ai_grid.v1.ModelEnvVar', name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' }];
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.paste('Updated description');
    await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
    await user.click(screen.getByRole('textbox', { name: 'Additional runtime arguments' }));
    await user.paste('--enforce-eager');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const [request] = update.mock.calls[0];
    expect(request.updateMask?.paths).toEqual(['spec.main.env', 'metadata.annotations']);
    expect(request.object?.metadata?.annotations).toEqual({
      'openshift.io/display-name': 'Granite 3.3 8B Instruct',
      'openshift.io/description': 'Updated description',
      team: 'research',
    });
    expect(request.object?.spec?.main?.env.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' },
      { name: 'VLLM_ADDITIONAL_ARGS', value: '--enforce-eager' },
    ]);
  });

  it('leaves the display name alone when only the description changes on a model without one', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    delete models.find('granite-3-8b').metadata!.annotations['openshift.io/display-name'];
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.paste('new');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const annotations = update.mock.calls[0][0].object?.metadata?.annotations;
    expect(annotations).not.toHaveProperty('openshift.io/display-name');
    expect(annotations).toHaveProperty('openshift.io/description', 'new');
  });

  it('shows the name users send read-only, as the model has it', async () => {
    const service = new MockConsoleService();
    // A model written before the backend served models as their ids can keep another name.
    modelsOf(service).find('granite-3-8b').spec!.model!.name = 'example-org/granite-3-8b';
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    const served = await screen.findByRole('textbox', { name: 'Model name in requests' });
    expect(served).toHaveValue('example-org/granite-3-8b');
    expect(served).toHaveAttribute('readonly');
    expect(
      screen.getByText(/Users send this name as the model in their requests\. It cannot be edited\./),
    ).toBeInTheDocument();
    await openStep(user, 'Review');
    const review = await screen.findByTestId('model-review');
    expect(review).toHaveTextContent('Model name in requestsexample-org/granite-3-8b');
    expect(within(review).getAllByText('Model name in requests')).toHaveLength(1);
  });

  it("says a model that still serves an older name fails users' requests until any change is saved", async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    // Saved before the backend served models as their ids: it still serves its own name.
    models.find('granite-3-8b').spec!.model!.name = 'example-org/granite-3-8b';
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    const alert = await screen.findByTestId('model-older-name');
    expect(alert).toHaveClass('pf-m-info');
    expect(within(alert).getByRole('heading', { name: /This model uses an older name/ })).toBeVisible();
    expect(alert).toHaveTextContent(
      'Users request models by their ID, granite-3-8b, but this model still answers only to example-org/granite-3-8b, so their requests to it fail. Saving any change updates it to use its ID. The model is unavailable for a moment while it restarts.',
    );
    expect([...alert.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'granite-3-8b',
      'example-org/granite-3-8b',
    ]);
    await openStep(user, 'Deployment');
    expect(screen.queryByTestId('model-older-name')).not.toBeInTheDocument();
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.paste('new');
    await openStep(user, 'Review');
    expect(within(screen.getByTestId('model-review')).getByTestId('model-older-name')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes to model Granite 3.3 8B Instruct saved to Git')).toBeVisible();
    // The edit sends no served name: the backend switches the model to its id on any update.
    const [request] = update.mock.calls[0];
    expect(request.updateMask?.paths).toEqual(['metadata.annotations']);
    expect(request.object?.spec?.model).toBeUndefined();
    expect(models.find('granite-3-8b').spec?.model?.name).toBe('granite-3-8b');
  });

  it('shows no older-name alert for a model served as its id', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    expect(await screen.findByRole('textbox', { name: 'Model name in requests' })).toHaveValue('granite-3-8b');
    expect(screen.queryByTestId('model-older-name')).not.toBeInTheDocument();
    await openStep(user, 'Review');
    expect(await screen.findByTestId('model-review')).toBeVisible();
    expect(screen.queryByTestId('model-older-name')).not.toBeInTheDocument();
  });

  it('leaves a resource the model was deployed without empty and optional, and adds none', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    models.find('granite-3-8b').spec!.main!.requests = {};
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const cpu = await screen.findByRole('textbox', { name: 'CPU' });
    expect(cpu).toHaveValue('');
    expect(cpu).not.toBeRequired();
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Memory' })).not.toBeRequired();
    await user.click(cpu);
    await user.tab();
    expect(cpu).toHaveAccessibleDescription('In cores or millicores. For example, 2 or 500m.');
    await user.click(screen.getByRole('textbox', { name: 'Description' }));
    await user.paste(' (edited)');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].updateMask?.paths).toEqual(['metadata.annotations']);
  });

  it('treats spaces around a runtime argument as no change', async () => {
    const service = new MockConsoleService();
    modelsOf(service).find('granite-3-8b').spec!.main!.env = [
      { $typeName: 'ai_grid.v1.ModelEnvVar', name: 'VLLM_ADDITIONAL_ARGS', value: '--enforce-eager' },
    ];
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    await user.click(await screen.findByRole('button', { name: 'Advanced settings' }));
    const end = '--enforce-eager'.length;
    await user.type(screen.getByRole('textbox', { name: 'Additional runtime arguments' }), ' ', {
      initialSelectionStart: end,
      initialSelectionEnd: end,
    });
    await openStep(user, 'Review');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('shows a placement the console doesn’t write read-only and leaves it alone', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const granite = models.find('granite-3-8b');
    granite.spec!.placement!.clusterSets = ['global'];
    // Its location labels differ from its clusters' names: the step shows the clusters.
    granite.status!.placement!.locations = ['somewhere'];
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Clusters');
    const placed = await screen.findByRole('textbox', { name: 'Clusters' });
    expect(placed).toHaveAttribute('readonly');
    expect(placed).toHaveValue(granite.status!.placement!.selectedClusters.join(', '));
    expect(screen.getByText(/selects clusters by more than their names/)).toBeVisible();
    await openStep(user, 'Deployment');
    const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.paste('2');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].updateMask?.paths).toEqual(['spec.replicas']);
  });

  it('saves against the version the edit started from, whatever a refetch brings in meanwhile', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const get = vi.spyOn(models, 'get');
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const replicas = await screen.findByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.paste('4');
    // Another tab saves; then the window regains focus, and the model is read again.
    models.find('granite-3-8b').metadata!.version = 2;
    const reads = get.mock.calls.length;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(reads));
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    // The edit's version, not the refetched one: the backend refuses it, and the page says so.
    expect(update.mock.calls[0][0].object?.metadata?.version).toBe(1);
    expect(
      await screen.findByText('This model was changed by another user. Reload the page to edit the latest version.'),
    ).toBeVisible();
    act(() => focusManager.setFocused(undefined));
  });

  it('says the deployment changed when the version it opened is stale', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const replicas = await screen.findByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.paste('4');
    // Another tab saves first.
    models.find('granite-3-8b').metadata!.version = 9;
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('This model was changed by another user. Reload the page to edit the latest version.'),
    ).toBeVisible();
  });

  it('saves an unrelated change while a kept cluster is not offered, or the clusters fail to load', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const update = vi.spyOn(models, 'update');
    let calls = 0;
    models.placementClusters = async () => {
      if (calls++ === 0) return ['site2'];
      throw new ConnectError('Location catalog unavailable.', Code.Unavailable);
    };
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Clusters');
    await openStep(user, 'Deployment');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.paste('Still on site1');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].updateMask?.paths).toEqual(['metadata.annotations']);
  });

  it.each([
    ['no stored count', undefined],
    ['a count outside the deploy wizard’s limits', 0],
  ])('leaves the replicas alone when the model has %s', async (_, replicas) => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    models.find('granite-3-8b').spec!.replicas = replicas;
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    await user.click(await screen.findByRole('textbox', { name: 'Description' }));
    await user.paste(' (edited)');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].updateMask?.paths).not.toContain('spec.replicas');
  });

  it('shows an autoscaled model’s replicas as Autoscaled, on its step and in Review', async () => {
    const service = new MockConsoleService();
    const granite = modelsOf(service).find('granite-3-8b');
    granite.spec!.replicas = undefined;
    granite.spec!.scaling = {
      $typeName: 'ai_grid.v1.ModelScaling',
      minReplicas: 1,
      maxReplicas: 3,
      keda: true,
      triggers: [],
    };
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('textbox', { name: 'Replicas' })).toHaveValue('Autoscaled');
    await openStep(user, 'Review');
    expect(within(await screen.findByTestId('model-review')).getByText('Autoscaled')).toBeVisible();
  });

  it("shows the backend's refusal and keeps the input", async () => {
    const service = new MockConsoleService();
    vi.spyOn(modelsOf(service), 'update').mockImplementation(() => {
      throw new ConnectError('spec.main.image: Invalid value', Code.InvalidArgument);
    });
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    await user.clear(await screen.findByRole('textbox', { name: 'Description' }));
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('spec.main.image: Invalid value')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await openStep(user, 'Deployment');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  });

  it('offers Edit from the list, next to the details and Delete', async () => {
    const user = userEvent.setup();
    renderAt('/models', new MockConsoleService());
    await user.click(await screen.findByRole('button', { name: 'Actions for Granite 3.3 8B Instruct' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['View details', 'Edit', 'Delete']);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit model' })).toBeVisible();
  });
});

describe('editing what a deployed model runs', () => {
  const cpuOnly = configExample.body.data.models.hardware.find((h) => h.id === 'cpu')!;
  const cpuHint = 'For long-context models on CPU, set --max-model-len in Advanced settings.';
  const openStep = async (user: User, name: 'Source' | 'Deployment' | 'Clusters' | 'Review') =>
    user.click(within(await screen.findByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name }));
  const field = (name: string | RegExp) => screen.getByRole('textbox', { name });
  const replace = async (user: User, name: string | RegExp, value: string) => {
    await user.clear(field(name));
    if (value) await user.paste(value);
  };

  /** granite-3-8b deployed without presets, with these requests, image and env; its update spy. */
  const deployed = (requests: Record<string, string>, image: string, env: Record<string, string> = {}) => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const granite = models.find('granite-3-8b');
    granite.spec!.baseRefs = [];
    granite.spec!.main!.requests = requests;
    granite.spec!.main!.image = image;
    granite.spec!.main!.env = Object.entries(env).map(([name, value]) => ({
      $typeName: 'ai_grid.v1.ModelEnvVar',
      name,
      value,
    }));
    return { service, models, update: vi.spyOn(models, 'update') };
  };

  /** Opens Review, saves, and returns the Models/Update request. */
  const save = async (user: User, update: ReturnType<typeof deployed>['update']) => {
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    return update.mock.calls[0][0];
  };

  // The model page after a save. The Review step has a list labelled Deployment too, so wait for the
  // wizard to leave before reading the page's.
  const deploymentAfterSave = async () => {
    await waitFor(() => expect(screen.queryByTestId('model-review')).not.toBeInTheDocument());
    return screen.findByLabelText('Deployment');
  };

  const envOf = (env: { name: string; value: string }[] | undefined) =>
    env?.map(({ name, value }) => ({ name, value }));

  it('edits the model URI, says on Review that users get the new model under the same name, and sends spec.model', async () => {
    const { service, update } = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' }, '');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    const uri = await screen.findByRole('textbox', { name: /^Model URI/ });
    expect(uri).toBeRequired();
    await openStep(user, 'Review');
    expect(screen.queryByTestId('model-uri-changed')).not.toBeInTheDocument();
    await openStep(user, 'Source');
    await replace(user, /^Model URI/, 'hf://example-org/granite-3.3-8b-instruct');
    await openStep(user, 'Review');
    const review = screen.getByTestId('model-review');
    expect(review).toHaveTextContent('Model URIhf://example-org/granite-3.3-8b-instruct');
    const warning = within(review).getByTestId('model-uri-changed');
    expect(warning).toHaveClass('pf-m-warning');
    expect(within(warning).getByRole('heading', { name: /This changes the model users are served/ })).toBeVisible();
    expect(warning).toHaveTextContent(
      'Once the change rolls out, requests for granite-3-8b are answered by the model at the new URI. Subscriptions that include this model serve the new one under the same name.',
    );
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.model']);
    // The URI only: the backend serves the model as its id whatever an update sends.
    expect(request.object?.spec?.model).toEqual(
      expect.objectContaining({ uri: 'hf://example-org/granite-3.3-8b-instruct', name: '' }),
    );
    expect(await screen.findByText('Changes to model Granite 3.3 8B Instruct saved to Git')).toBeVisible();
    expect(await deploymentAfterSave()).toHaveTextContent('Model URIhf://example-org/granite-3.3-8b-instruct');
  });

  it('checks a new model URI as Deploy does, and keeps one the model already has', async () => {
    const { service, models } = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' }, '');
    // The backend takes https:// URIs; the Deploy wizard offers hf, oci, s3, and pvc only.
    models.find('granite-3-8b').spec!.model!.uri = 'https://models.example.com/granite';
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    const uri = await screen.findByRole('textbox', { name: /^Model URI/ });
    await user.click(uri);
    await user.tab();
    expect(uri).toHaveAccessibleDescription(/^For example, hf:\/\/org\/model/);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await replace(user, /^Model URI/, 'https://models.example.com/other');
    await user.tab();
    expect(uri).toHaveAccessibleDescription(/^Enter a model URI using hf, oci, s3 or pvc\./);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await replace(user, /^Model URI/, '');
    expect(uri).toHaveAccessibleDescription(/^Required : error status;$/);
  });

  it('edits CPU and memory, sending the requests whole with every other resource kept', async () => {
    const { service, update } = deployed(
      { cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1', 'ephemeral-storage': '20Gi' },
      '',
    );
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('textbox', { name: /^CPU/ })).toBeRequired();
    // Without presets there is nothing to remove.
    expect(screen.queryByRole('checkbox', { name: 'Remove presets' })).not.toBeInTheDocument();
    await replace(user, /^CPU/, '4');
    await replace(user, /^Memory/, '32Gi');
    await openStep(user, 'Review');
    const review = screen.getByTestId('model-review');
    expect(review).toHaveTextContent('CPU4');
    expect(review).toHaveTextContent('Memory32Gi');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.requests']);
    expect(request.object?.spec?.main?.requests).toEqual({
      cpu: '4',
      memory: '32Gi',
      'nvidia.com/gpu': '1',
      'ephemeral-storage': '20Gi',
    });
    const details = await deploymentAfterSave();
    expect(details).toHaveTextContent('CPU4');
    expect(details).toHaveTextContent('Memory32Gi');
  });

  it('edits the GPU count of a model on NVIDIA GPUs', async () => {
    const { service, update } = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' }, '');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const gpus = await screen.findByRole('spinbutton', { name: 'GPUs' });
    await user.clear(gpus);
    await user.type(gpus, '2');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.requests']);
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '2' });
  });

  it.each([
    ['NVIDIA GPU', { cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '2', 'rdma/hca': '1' }],
    ['CPU only', { cpu: '4', memory: '8Gi', 'rdma/hca': '1' }],
  ])(
    'replaces only the known accelerator of a model that also requests another resource, on %s',
    async (label, requests) => {
      const { service, update } = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1', 'rdma/hca': '1' }, '');
      const user = userEvent.setup();
      renderAt('/models/granite-3-8b/edit', service);
      await openStep(user, 'Deployment');
      // Two resources with a `/` match no hardware, so the edit shows them read-only until one is selected.
      expect(await screen.findByRole('textbox', { name: 'Accelerators' })).toHaveValue(
        '1 GPU (nvidia.com/gpu), 1 accelerator (rdma/hca)',
      );
      await selectHardware(user, label);
      if (label === 'NVIDIA GPU') await user.click(screen.getByRole('button', { name: 'Increase gpus' }));
      const request = await save(user, update);
      expect(request.object?.spec?.main?.requests).toEqual(requests);
    },
  );

  it('checks CPU, memory, and GPUs as Deploy does, and keeps values the model already has', async () => {
    // Values the backend took that the Deploy wizard doesn't write: 16G (not Gi) and 80 GPUs (over 64).
    const { service } = deployed({ cpu: '2', memory: '16G', 'nvidia.com/gpu': '80' }, '');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const memory = await screen.findByRole('textbox', { name: /^Memory/ });
    await user.click(memory);
    await user.tab();
    expect(memory).toHaveAccessibleDescription('For example, 4Gi or 512Mi.');
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(80);
    const reviewNav = () =>
      within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name: 'Review' });
    expect(reviewNav()).toBeEnabled();
    await replace(user, /^CPU/, 'two');
    await user.tab();
    expect(field(/^CPU/)).toHaveAccessibleDescription(
      /^Enter positive CPU cores or millicores, for example 2 or 500m\./,
    );
    expect(reviewNav()).toBeDisabled();
    await replace(user, /^CPU/, '');
    await user.tab();
    expect(field(/^CPU/)).toHaveAccessibleDescription(/^Required : error status;$/);
    await replace(user, /^CPU/, '2');
    expect(reviewNav()).toBeEnabled();
    await replace(user, /^Memory/, '16GB');
    await user.tab();
    expect(memory).toHaveAccessibleDescription(/^Enter memory such as 4Gi or 512Mi\./);
    await replace(user, /^Memory/, '16G');
    const gpus = screen.getByRole('spinbutton', { name: 'GPUs' });
    await user.clear(gpus);
    await user.type(gpus, '0');
    await user.tab();
    expect(gpus).toHaveAccessibleDescription(/Enter a number from 1 to 64\./);
    expect(reviewNav()).toBeDisabled();
  });

  it('applies other hardware as Deploy does, and goes back to the model’s own values when its hardware is selected again', async () => {
    const { service, update } = deployed({ cpu: '3', memory: '12Gi', 'nvidia.com/gpu': '2' }, '', { TEAM: 'research' });
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
    expect(field(/^Memory/)).toHaveAccessibleDescription('For example, 4Gi or 512Mi.');
    await selectHardware(user, 'CPU only');
    expect(field(/Runtime image/)).toHaveValue(cpuOnly.image);
    expect(field(/Runtime image/)).toBeRequired();
    expect(field(/^CPU/)).toHaveValue('4');
    expect(field(/^Memory/)).toHaveValue('8Gi');
    expect(field(/^Memory/)).toHaveAccessibleDescription(`For example, 4Gi or 512Mi. ${cpuHint}`);
    expect(screen.queryByRole('spinbutton', { name: 'GPUs' })).not.toBeInTheDocument();
    await openStep(user, 'Review');
    const review = screen.getByTestId('model-review');
    expect(review).toHaveTextContent('HardwareCPU only');
    // As Deploy: CPU only has no accelerator row.
    expect(review).not.toHaveTextContent('Accelerators');
    await openStep(user, 'Deployment');
    await selectHardware(user, 'NVIDIA GPU');
    expect(field(/Runtime image/)).toHaveValue('');
    expect(field(/^CPU/)).toHaveValue('3');
    expect(field(/^Memory/)).toHaveValue('12Gi');
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(2);
    await openStep(user, 'Review');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await openStep(user, 'Deployment');
    await selectHardware(user, 'CPU only');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.image', 'spec.main.requests', 'spec.main.env']);
    expect(request.object?.spec?.main?.image).toBe(cpuOnly.image);
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '4', memory: '8Gi' });
    expect(envOf(request.object?.spec?.main?.env)).toEqual([
      { name: 'TEAM', value: 'research' },
      { name: 'OMP_NUM_THREADS', value: '4' },
      { name: 'VLLM_CPU_KVCACHE_SPACE', value: '4' },
    ]);
  });

  it('starts a model that matches no hardware on none, its accelerators read-only, until the user selects one', async () => {
    const { service, update } = deployed({ cpu: '4', memory: '8Gi', 'amd.com/gpu': '2' }, 'registry.example/rocm:1', {
      VLLM_CPU_KVCACHE_SPACE: '4',
      TEAM: 'research',
      VLLM_ADDITIONAL_ARGS: '--enforce-eager',
    });
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'CPU only' })).not.toBeChecked();
    expect(
      screen.getByText(
        "The model's current settings match none of these. Select one to apply its runtime image, environment, and resources.",
      ),
    ).toBeVisible();
    const accelerators = field('Accelerators');
    expect(accelerators).toHaveValue('2 GPUs (amd.com/gpu)');
    expect(accelerators).toHaveAttribute('readonly');
    expect(accelerators).toHaveAccessibleDescription('Select hardware to edit the accelerators.');
    await openStep(user, 'Review');
    expect(screen.getByTestId('model-review')).toHaveTextContent('Accelerators2 GPUs (amd.com/gpu)');
    expect(screen.getByTestId('model-review')).not.toHaveTextContent('Hardware');
    await openStep(user, 'Deployment');
    await selectHardware(user, 'NVIDIA GPU');
    expect(screen.queryByText(/match none of these/)).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(1);
    expect(field(/Runtime image/)).toHaveValue('');
    expect(field(/^CPU/)).toHaveValue('2');
    expect(field(/^Memory/)).toHaveValue('16Gi');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.image', 'spec.main.requests', 'spec.main.env']);
    expect(request.object?.spec?.main?.image).toBe('');
    // The AMD GPUs give way to the NVIDIA GPU; CPU only's variable goes, the model's own stays.
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' });
    expect(envOf(request.object?.spec?.main?.env)).toEqual([
      { name: 'TEAM', value: 'research' },
      { name: 'VLLM_ADDITIONAL_ARGS', value: '--enforce-eager' },
    ]);
  });

  it('starts a model with an image of its own on NVIDIA GPU, changing nothing, with its GPUs editable', async () => {
    const { service, update } = deployed(
      { cpu: '3', memory: '12Gi', 'nvidia.com/gpu': '2' },
      'registry.example/vllm-cuda:mine',
      { TEAM: 'research' },
    );
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
    expect(screen.queryByText(/match none of these/)).not.toBeInTheDocument();
    // Preselected only: the model's own image, resources, and count stay.
    expect(field(/Runtime image/)).toHaveValue('registry.example/vllm-cuda:mine');
    expect(field(/Runtime image/)).toHaveAccessibleDescription(
      "Leave empty to use the cluster's default vLLM image for NVIDIA GPUs.",
    );
    expect(field(/^CPU/)).toHaveValue('3');
    expect(field(/^Memory/)).toHaveValue('12Gi');
    const gpus = screen.getByRole('spinbutton', { name: 'GPUs' });
    expect(gpus).toHaveValue(2);
    await openStep(user, 'Review');
    expect(screen.getByTestId('model-review')).toHaveTextContent('HardwareNVIDIA GPU');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await openStep(user, 'Deployment');
    await user.clear(screen.getByRole('spinbutton', { name: 'GPUs' }));
    await user.type(screen.getByRole('spinbutton', { name: 'GPUs' }), '4');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.requests']);
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '3', memory: '12Gi', 'nvidia.com/gpu': '4' });
  });

  it('looks for the model’s hardware again once its presets are removed, changing nothing', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const granite = models.find('granite-3-8b');
    granite.spec!.main!.requests = { cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' };
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).not.toBeChecked();
    expect(field('Accelerators')).toHaveAttribute('readonly');
    await user.click(screen.getByRole('checkbox', { name: 'Remove presets' }));
    expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(1);
    expect(field(/Runtime image/)).toHaveValue('quay.io/example/vllm:v1');
    expect(field(/^CPU/)).toHaveValue('2');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.base_refs']);
  });

  it('keeps quantities the console doesn’t write when an edit doesn’t touch them', async () => {
    // Valid Kubernetes quantities in forms the wizard doesn't write: 3000m is three whole GPUs.
    const { service, update } = deployed({ cpu: '2000m', memory: '16G', 'nvidia.com/gpu': '3000m' }, '');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(3);
    expect(field(/^CPU/)).toHaveValue('2000m');
    expect(field(/^Memory/)).toHaveValue('16G');
    await user.click(screen.getByRole('textbox', { name: 'Description' }));
    await user.paste(' (edited)');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['metadata.annotations']);
  });

  it('sends a GPU count the user edits as a whole number, keeping CPU and memory as stored', async () => {
    const { service, update } = deployed({ cpu: '2000m', memory: '16G', 'nvidia.com/gpu': '3000m' }, '');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    await user.click(await screen.findByRole('button', { name: 'Increase gpus' }));
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.requests']);
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '2000m', memory: '16G', 'nvidia.com/gpu': '4' });
  });

  it('selects hardware for a model with presets only once they are removed', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    // The CPU preset sets an image and environment that other hardware would conflict with.
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'CPU only' })).toBeDisabled();
    expect(screen.getByText('Remove presets to select hardware.')).toBeVisible();
    expect(screen.queryByText(/match none of these/)).not.toBeInTheDocument();
    const remove = screen.getByRole('checkbox', { name: 'Remove presets' });
    await user.click(remove);
    expect(screen.getByRole('radio', { name: 'CPU only' })).toBeEnabled();
    expect(screen.queryByText('Remove presets to select hardware.')).not.toBeInTheDocument();
    await selectHardware(user, 'NVIDIA GPU');
    // Keeping the presets again puts the model's own hardware back.
    await user.click(remove);
    expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).toBeDisabled();
    expect(field(/Runtime image/)).toHaveValue('quay.io/example/vllm:v1');
    await user.click(remove);
    await selectHardware(user, 'CPU only');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual([
      'spec.base_refs',
      'spec.main.image',
      'spec.main.requests',
      'spec.main.env',
    ]);
    expect(request.object?.spec?.baseRefs).toEqual([]);
    expect(request.object?.spec?.main?.image).toBe(cpuOnly.image);
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '4', memory: '8Gi' });
    expect(envOf(request.object?.spec?.main?.env)).toEqual([
      { name: 'OMP_NUM_THREADS', value: '4' },
      { name: 'VLLM_CPU_KVCACHE_SPACE', value: '4' },
    ]);
  });

  it('keeps an image the user typed when the presets are kept again', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const remove = await screen.findByRole('checkbox', { name: 'Remove presets' });
    await replace(user, /Runtime image/, 'registry.example/vllm:mine');
    await user.click(remove);
    expect(field(/Runtime image/)).toHaveValue('registry.example/vllm:mine');
    await user.click(remove);
    expect(remove).not.toBeChecked();
    expect(field(/Runtime image/)).toHaveValue('registry.example/vllm:mine');
    // Typed after selecting hardware, too.
    await user.click(remove);
    await selectHardware(user, 'NVIDIA GPU');
    expect(field(/Runtime image/)).toHaveValue('');
    await replace(user, /Runtime image/, 'registry.example/vllm:other');
    await user.click(remove);
    expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).not.toBeChecked();
    expect(field(/Runtime image/)).toHaveValue('registry.example/vllm:other');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.image']);
    expect(request.object?.spec?.main?.image).toBe('registry.example/vllm:other');
  });

  it('puts the model’s own image back when the presets are kept again and the user typed none', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const remove = await screen.findByRole('checkbox', { name: 'Remove presets' });
    await user.click(remove);
    await selectHardware(user, 'CPU only');
    expect(field(/Runtime image/)).toHaveValue(cpuOnly.image);
    await user.click(remove);
    expect(field(/Runtime image/)).toHaveValue('quay.io/example/vllm:v1');
    // A typed image gives way to the hardware selected after it, so it is not typed any more.
    await user.click(remove);
    await replace(user, /Runtime image/, 'registry.example/vllm:mine');
    await selectHardware(user, 'NVIDIA GPU');
    await user.click(remove);
    expect(field(/Runtime image/)).toHaveValue('quay.io/example/vllm:v1');
    await openStep(user, 'Review');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('goes back to the model’s own values when its hardware is selected again after the presets are removed', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const granite = models.find('granite-3-8b');
    granite.spec!.main!.image = 'registry.example/vllm-cuda:mine';
    granite.spec!.main!.requests = { cpu: '3', memory: '12Gi', 'nvidia.com/gpu': '2' };
    granite.spec!.main!.env = [{ $typeName: 'ai_grid.v1.ModelEnvVar', name: 'TEAM', value: 'research' }];
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    await user.click(await screen.findByRole('checkbox', { name: 'Remove presets' }));
    expect(screen.getByRole('radio', { name: 'NVIDIA GPU' })).toBeChecked();
    await selectHardware(user, 'CPU only');
    expect(field(/^CPU/)).toHaveValue('4');
    await selectHardware(user, 'NVIDIA GPU');
    expect(field(/Runtime image/)).toHaveValue('registry.example/vllm-cuda:mine');
    expect(field(/^CPU/)).toHaveValue('3');
    expect(field(/^Memory/)).toHaveValue('12Gi');
    expect(screen.getByRole('spinbutton', { name: 'GPUs' })).toHaveValue(2);
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.base_refs']);
  });

  it('removes the presets, sending spec.base_refs empty, and says so on Review', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    // Presets set part of the image and environment, so no hardware matches.
    expect(await screen.findByRole('radio', { name: 'NVIDIA GPU' })).not.toBeChecked();
    expect(field('Presets')).toHaveValue('v3-6-0-kserve-config-llm-template-cpu');
    const remove = screen.getByRole('checkbox', { name: 'Remove presets' });
    expect(remove).not.toBeChecked();
    expect(remove).toHaveAccessibleDescription(
      "The model then uses only the runtime image, environment, and resources set here. Presets can't be added back.",
    );
    await user.click(remove);
    await openStep(user, 'Review');
    expect(screen.getByTestId('model-review')).toHaveTextContent(
      'PresetsNone (v3-6-0-kserve-config-llm-template-cpu removed)',
    );
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.base_refs']);
    expect(request.object?.spec?.baseRefs).toEqual([]);
    expect(await screen.findByText('Changes to model Granite 3.3 8B Instruct saved to Git')).toBeVisible();
    expect(models.find('granite-3-8b').spec?.baseRefs).toEqual([]);
    expect(await deploymentAfterSave()).not.toHaveTextContent('Presets');
  });

  it('requires an image once the presets that set it are removed, off NVIDIA GPUs', async () => {
    const service = new MockConsoleService();
    const models = modelsOf(service);
    models.find('granite-3-8b').spec!.main!.image = '';
    const update = vi.spyOn(models, 'update');
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const image = await screen.findByRole('textbox', { name: /Runtime image/ });
    expect(image).not.toBeRequired();
    expect(image).toHaveAccessibleDescription('Leave empty to use the image the presets set.');
    await user.click(screen.getByRole('checkbox', { name: 'Remove presets' }));
    expect(image).toBeRequired();
    expect(image).toHaveAccessibleDescription("Enter a vLLM image for the model's hardware.");
    const reviewNav = within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', {
      name: 'Review',
    });
    expect(reviewNav).toBeDisabled();
    await user.click(image);
    await user.paste('registry.example/vllm-cpu:1');
    expect(reviewNav).toBeEnabled();
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.base_refs', 'spec.main.image']);
    expect(request.object?.spec?.main?.image).toBe('registry.example/vllm-cpu:1');
  });

  it('checks the image against the hardware the user selects: optional on NVIDIA GPUs, required on others', async () => {
    // Stored without an image or presets on CPU: the edit keeps that until other hardware is selected.
    const { service, update } = deployed({ cpu: '4', memory: '8Gi' }, '');
    service.config = {
      ...service.config,
      models: {
        hardware: [
          ...service.config.models.hardware,
          { id: 'amd-gpu', label: 'AMD GPU', accelerator: 'amd.com/gpu', defaults: { accelerators: 1 } },
        ],
      },
    };
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    const image = await screen.findByRole('textbox', { name: /Runtime image/ });
    expect(image).not.toBeRequired();
    await selectHardware(user, 'AMD GPU');
    expect(image).toBeRequired();
    expect(image).toHaveAccessibleDescription('Enter a vLLM image for this hardware.');
    const reviewNav = within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', {
      name: 'Review',
    });
    expect(reviewNav).toBeDisabled();
    await selectHardware(user, 'NVIDIA GPU');
    expect(image).not.toBeRequired();
    expect(image).toHaveAccessibleDescription("Leave empty to use the cluster's default vLLM image for NVIDIA GPUs.");
    expect(reviewNav).toBeEnabled();
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.requests']);
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' });
  });

  it('saves an edit while the hardware list fails to load, keeping what the model requests', async () => {
    const { service, update } = deployed({ cpu: '2', memory: '16Gi', 'nvidia.com/gpu': '1' }, '');
    service.getConfig = () => Promise.reject(new ServiceError(503, 'The console server is unavailable.'));
    const user = userEvent.setup();
    renderAt('/models/granite-3-8b/edit', service);
    await openStep(user, 'Deployment');
    expect(await screen.findByText('Unable to load hardware')).toBeVisible();
    expect(field('Accelerators')).toHaveValue('1 GPU (nvidia.com/gpu)');
    await replace(user, /^CPU/, '6');
    const request = await save(user, update);
    expect(request.updateMask?.paths).toEqual(['spec.main.requests']);
    expect(request.object?.spec?.main?.requests).toEqual({ cpu: '6', memory: '16Gi', 'nvidia.com/gpu': '1' });
  });
});

it('shows the loading spinner until the models arrive, then the list in its place', async () => {
  const service = new MockConsoleService();
  const models = modelsOf(service);
  const release = deferred<void>();
  const list = models.list;
  vi.spyOn(models, 'list').mockImplementationOnce(async (req, ctx) => {
    await release.promise;
    return list(req, ctx);
  });
  renderAt('/models', service);
  const spinner = await screen.findByRole('progressbar', { name: 'Loading models' });
  expect(spinner.closest('.pf-v6-c-page__main-section')).toHaveClass('pf-m-fill');
  expect(screen.queryByRole('grid', { name: 'Models' })).not.toBeInTheDocument();
  await act(async () => release.resolve());
  expect(await screen.findByRole('grid', { name: 'Models' })).toBeVisible();
  expect(screen.queryByRole('progressbar', { name: 'Loading models' })).not.toBeInTheDocument();
});

describe('each cluster of a placed model (status.clusters, proposal P13)', () => {
  /** Mistral on three clusters, ready on one, as the backend reports it. */
  const partial = () => {
    const service = new MockConsoleService();
    modelsOf(service).models.push(
      modelObject({
        id: 'mistral-7b-instruct',
        metadata: {
          name: 'mistral-7b-instruct',
          version: 4,
          annotations: { 'openshift.io/display-name': 'Mistral 7B Instruct' },
        },
        spec: {
          model: { uri: 'hf://mistralai/mistral-7b-instruct', name: 'mistral-7b-instruct' },
          replicas: 1,
          placement: {
            labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: ['site1', 'site2', 'site3'] }] },
          },
        },
        status: {
          phase: ModelPhase.PARTIALLY_AVAILABLE,
          reason: 'PartiallyAvailable',
          deployment: ModelDeploymentState.STARTING,
          // The summary counts every reporting cluster, an ingress one (hub-ingress) included; only the
          // placed ones have an entry in `clusters`.
          message: 'Not ready on site2; ready on hub-ingress, site1; no report from site3',
          placement: { selectedClusters: ['site1', 'site2', 'site3'] },
          clusters: [
            {
              cluster: 'site1',
              phase: ModelPhase.READY,
              reason: 'Ready',
              message: 'LLMInferenceService ready',
              deployment: ModelDeploymentState.RUNNING,
              sync: ModelSyncState.SYNCED,
            },
            {
              cluster: 'site2',
              phase: ModelPhase.PENDING,
              reason: 'NotReady',
              message: 'LLMInferenceService not ready',
              deployment: ModelDeploymentState.STARTING,
              sync: ModelSyncState.SYNCED,
            },
            {
              cluster: 'site3',
              phase: ModelPhase.PENDING,
              reason: 'NoReport',
              message: 'No LLMInferenceService report',
            },
          ],
        },
      }),
    );
    return service;
  };

  it('expands a model to each placed cluster the backend reports, with its site, region and status', async () => {
    const user = userEvent.setup();
    renderAt('/models', partial());
    const row = await rowOf('mistral-7b-instruct');
    expect(within(row).getByTestId('model-phase')).toHaveTextContent('Partially ready');
    expect(within(row).getByTestId('model-cluster-names-mistral-7b-instruct')).toHaveTextContent('site1site2site3');
    await user.click(within(row).getByRole('button', { name: 'Details' }));
    const rows = await tableRows('Clusters of Mistral 7B Instruct');
    // As the backend lists them: hub-ingress, in the message only, has no row.
    expect(rows.map((r) => cellIn(r, 'Cluster').textContent)).toEqual(['site1', 'site2', 'site3']);
    expect(within(rows[0]).getByRole('link', { name: 'site1' })).toHaveAttribute('href', '/clusters/site1');
    expect(rows.map((r) => cellIn(r, 'Site').textContent)).toEqual(['San Francisco', 'New York', 'Brussels']);
    expect(rows.map((r) => cellIn(r, 'Region').textContent)).toEqual(['us-west', 'us-east', 'europe-west']);
    expect(rows.map((r) => cellIn(r, 'Status').textContent)).toEqual([
      'Ready on site1',
      'Starting on site2',
      'Pending sync on site3',
    ]);
    expect(within(rows[0]).getByRole('button', { name: 'Ready on site1' })).toBeVisible();
    expect(within(rows[1]).getByRole('button', { name: 'Starting on site2' })).toBeVisible();
    expect(within(rows[2]).queryByRole('button')).not.toBeInTheDocument();
    expect(cellIn(rows[2], 'Status').querySelector('.pf-v6-c-label')).toHaveClass('pf-m-outline');
    // No view_url from the backend: no View link.
    for (const r of rows) expect(within(r).queryByRole('link', { name: /^View/ })).not.toBeInTheDocument();
  });

  it.each(['/models', '/models/mistral-7b-instruct'])(
    'keeps cluster status informational and page editing available on %s',
    async (path) => {
      const user = userEvent.setup();
      renderAt(path, partial());
      if (path === '/models') {
        await user.click(within(await rowOf('mistral-7b-instruct')).getByRole('button', { name: 'Details' }));
      }
      await user.click(await screen.findByRole('button', { name: 'Starting on site2' }));
      const modal = await screen.findByRole('dialog', { name: 'Mistral 7B Instruct on site2' });
      expect(within(modal).getByRole('heading', { name: /Mistral 7B Instruct status/ })).toBeVisible();
      expect(modal).toHaveTextContent('SiteNew York');
      expect(modal).toHaveTextContent('Regionus-east');
      expect(modal).toHaveTextContent('LLMInferenceService not ready');
      expect(within(modal).queryByRole('button', { name: /Edit|Stop/ })).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(modal).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Actions for Mistral 7B Instruct' }));
      await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
      expect(await screen.findByRole('heading', { name: /^Edit / })).toBeVisible();
    },
  );

  it('lists the same clusters on the model page', async () => {
    renderAt('/models/mistral-7b-instruct', partial());
    const table = await screen.findByRole('grid', { name: 'Clusters of Mistral 7B Instruct' });
    expect(screen.getByTestId('model-clusters')).toContainElement(table);
    expect(await within(table).findByRole('button', { name: 'Ready on site1' })).toBeVisible();
  });

  it('shows a dash for a missing site or region, never one in place of the other', async () => {
    const user = userEvent.setup();
    const service = partial();
    const [site1, site2] = ['site1', 'site2'].map((name) => service.clusters.find((c) => c.name === name)!);
    site1.siteName = undefined;
    site2.region = undefined;
    renderAt('/models/mistral-7b-instruct', service);
    const rows = await tableRows('Clusters of Mistral 7B Instruct');
    expect(rows.map((r) => [cellIn(r, 'Site').textContent, cellIn(r, 'Region').textContent])).toEqual([
      ['—', 'us-west'],
      ['New York', '—'],
      ['Brussels', 'europe-west'],
    ]);
    await user.click(within(rows[0]).getByRole('button', { name: 'Ready on site1' }));
    const modal = await screen.findByRole('dialog', { name: 'Mistral 7B Instruct on site1' });
    expect(modal).toHaveTextContent('Site—');
    expect(modal).toHaveTextContent('Regionus-west');
  });

  it.each(['/models', '/models/mistral-7b-instruct'])(
    "says on %s when the clusters fail to load, so a dash doesn't read as no site or region",
    async (path) => {
      const user = userEvent.setup();
      const service = partial();
      const clusters = vi.spyOn(service, 'listClusters').mockRejectedValue(new ServiceError(503, 'Hub unavailable.'));
      renderAt(path, service);
      const title = await screen.findByRole('heading', { name: 'Warning alert: Unable to load clusters' });
      const alert = title.closest('.pf-v6-c-alert') as HTMLElement;
      expect(alert).toHaveTextContent('Site and Region show a dash until the clusters load.');
      expect(alert).toHaveTextContent('The AI grid backend is unavailable. Try again.');
      // The page's own content stays.
      expect(screen.getAllByText('Mistral 7B Instruct')[0]).toBeVisible();
      clusters.mockRestore();
      await user.click(within(alert).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(alert).not.toBeInTheDocument());
      if (path === '/models') {
        await user.click(within(await rowOf('mistral-7b-instruct')).getByRole('button', { name: 'Details' }));
      }
      const [row] = await tableRows('Clusters of Mistral 7B Instruct');
      expect(cellIn(row, 'Site')).toHaveTextContent('San Francisco');
    },
  );

  it('keeps the last loaded sites under a warning when the clusters fail to reload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const service = partial();
      renderAt('/models/mistral-7b-instruct', service);
      const [row] = await tableRows('Clusters of Mistral 7B Instruct');
      expect(cellIn(row, 'Site')).toHaveTextContent('San Francisco');
      vi.spyOn(service, 'listClusters').mockRejectedValue(new ServiceError(503, 'Hub unavailable.'));
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(await screen.findByText('Showing the last loaded clusters')).toBeVisible();
      expect(cellIn((await tableRows('Clusters of Mistral 7B Instruct'))[0], 'Site')).toHaveTextContent(
        'San Francisco',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Models list expands every row', () => {
  it('gives every row the expand toggle, named Details, collapsed until clicked', async () => {
    const user = userEvent.setup();
    renderAt('/models', new MockConsoleService());
    for (const id of ['granite-3-8b', 'llama-3-70b', 'granite-research']) {
      expect(within(await rowOf(id)).getByRole('button', { name: 'Details' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    }
    const toggle = within(await rowOf('llama-3-70b')).getByRole('button', { name: 'Details' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands a model without a placement to say so, with Edit clusters for a provider admin', async () => {
    const user = userEvent.setup();
    renderAt('/models', new MockConsoleService());
    await user.click(within(await rowOf('llama-3-70b')).getByRole('button', { name: 'Details' }));
    const empty = await screen.findByTestId('model-not-placed-llama-3-70b');
    expect(within(empty).getByRole('heading', { name: 'No clusters' })).toBeVisible();
    await user.click(within(empty).getByRole('button', { name: 'Edit clusters' }));
    expect(await screen.findByRole('heading', { name: /^Edit / })).toBeVisible();
  });

  it('lists the clusters the placement chose while none has reported, each Pending sync', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    widget(service);
    renderAt('/models', service);
    await user.click(within(await rowOf('widget')).getByRole('button', { name: 'Details' }));
    const [row] = await tableRows('Clusters of Widget');
    expect(row).toHaveTextContent(/^site1San Franciscous-westPending sync on site1—$/);
    // Nothing has reported, so the status opens nothing.
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers no Edit clusters to a user the console could not load', async () => {
    const user = userEvent.setup();
    renderAt('/models', unknownUser());
    await user.click(within(await rowOf('llama-3-70b')).getByRole('button', { name: 'Details' }));
    const empty = await screen.findByTestId('model-not-placed-llama-3-70b');
    expect(within(empty).queryByRole('button', { name: 'Edit clusters' })).not.toBeInTheDocument();
  });
});

describe('the deployment and MaaS statuses', () => {
  /** A model running on site1 and starting on site2, published on hub-ingress with no subscription. */
  const running = () => {
    const service = new MockConsoleService();
    modelsOf(service).models.push(
      modelObject({
        id: 'smollm2',
        metadata: { name: 'smollm2', version: 2 },
        spec: {
          model: { uri: 'hf://x/smollm2', name: 'smollm2' },
          replicas: 1,
          placement: {
            labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: ['site1', 'site2'] }] },
          },
        },
        status: {
          phase: ModelPhase.PARTIALLY_AVAILABLE,
          reason: 'PartiallyAvailable',
          message: 'Not ready on site2; ready on hub-ingress, site1',
          deployment: ModelDeploymentState.STARTING,
          maas: ModelMaasState.AWAITING_SUBSCRIPTION,
          placement: { selectedClusters: ['site1', 'site2'] },
          clusters: [
            {
              cluster: 'site1',
              phase: ModelPhase.READY,
              reason: 'Ready',
              message: 'LLMInferenceService ready',
              deployment: ModelDeploymentState.RUNNING,
            },
            {
              cluster: 'site2',
              phase: ModelPhase.PENDING,
              reason: 'NotReady',
              message: 'LLMInferenceService not ready',
              deployment: ModelDeploymentState.STARTING,
              deploymentMessage: 'Deployment does not have minimum availability.',
            },
          ],
          ingress: [
            {
              cluster: 'hub-ingress',
              state: ModelMaasState.AWAITING_SUBSCRIPTION,
              message: 'Awaiting governance pairing',
            },
          ],
        },
      }),
      modelObject({
        id: 'maas-only',
        metadata: { name: 'maas-only', version: 1 },
        spec: { model: { uri: 'hf://x/maas-only', name: 'maas-only' } },
        status: { phase: ModelPhase.PENDING, reason: 'NotReady', maas: 99 as ModelMaasState },
      }),
      modelObject({
        id: 'all-good',
        metadata: { name: 'all-good', version: 1 },
        spec: { model: { uri: 'hf://x/all-good', name: 'all-good' } },
        status: {
          phase: ModelPhase.READY,
          reason: 'Ready',
          deployment: ModelDeploymentState.RUNNING,
          maas: ModelMaasState.AWAITING_SUBSCRIPTION,
        },
      }),
    );
    return service;
  };

  it('shows Availability in the Models list: a label and its reason, opening the dialog', async () => {
    const user = userEvent.setup();
    renderAt('/models', running());
    const cell = async (id: string) => within(await rowOf(id)).getByTestId(`model-availability-${id}`);
    expect(await cell('all-good')).toHaveTextContent(
      /^Pending availability of all-goodAwaiting subscription: all-good$/,
    );
    expect(await cell('smollm2')).toHaveTextContent(/^Pending availability of smollm2Awaiting subscription: smollm2$/);
    // A state newer than the pin is Unknown, and opens nothing.
    expect(await cell('maas-only')).toHaveTextContent(/^Unknown availability of maas-only$/);
    expect(within(await cell('maas-only')).queryByRole('button')).not.toBeInTheDocument();
    // No MaaS report: a dash.
    expect(await cell('granite-3-8b')).toHaveTextContent(/^—$/);
    await user.click(within(await cell('smollm2')).getByRole('button', { name: /^Awaiting subscription/ }));
    const modal = await screen.findByRole('dialog', { name: 'smollm2 availability' });
    expect(modal).toHaveTextContent('Pending MaaS governance');
    // MaaS's own words, per ingress cluster.
    expect(within(modal).getByLabelText('What MaaS reported')).toHaveTextContent(
      'MaaS on hub-ingressAwaiting subscription: Awaiting governance pairing',
    );
    expect(within(modal).getByRole('link', { name: 'Go to Subscriptions' })).toHaveAttribute('href', '/subscriptions');
  });

  it("colours the Availability subtext in its label's tone, as a subscription's", async () => {
    const service = running();
    const smollm2 = modelsOf(service).find('smollm2');
    renderAt('/models', service);
    const subtext = async () => within(await rowOf('smollm2')).getByRole('button', { name: /: smollm2$/ });
    for (const [state, className] of [
      [ModelMaasState.AWAITING_SUBSCRIPTION, 'pf-v6-u-text-color-status-default'],
      [ModelMaasState.UNAVAILABLE, 'pf-v6-u-text-color-status-warning'],
      [ModelMaasState.FAILED, 'pf-v6-u-text-color-status-danger'],
    ] as [ModelMaasState, string][]) {
      smollm2.status!.maas = state;
      cleanup();
      renderAt('/models', service);
      expect(await subtext()).toHaveClass(className);
    }
  });

  it('links to the model details from the status dialog on the list, and not on its own page', async () => {
    const user = userEvent.setup();
    const service = running();
    modelsOf(service).find('smollm2').status!.maas = ModelMaasState.AWAITING_SUBSCRIPTION_AND_BACKEND;
    renderAt('/models', service);
    await user.click(await screen.findByRole('button', { name: 'Pending availability of smollm2' }));
    const dialog = await screen.findByRole('dialog', { name: 'smollm2 availability' });
    expect(within(dialog).getByText('Model status')).toBeVisible();
    expect(dialog).toHaveTextContent(
      'No users can access this model. To grant users access, add this model to a subscription, and make sure it has the Ready status.',
    );
    await user.click(within(dialog).getByRole('link', { name: 'View model details' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'smollm2' })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // On the model's page, the same dialog has nowhere else to go but Subscriptions.
    await user.click(screen.getByRole('button', { name: 'Pending availability of smollm2' }));
    const again = await screen.findByRole('dialog', { name: 'smollm2 availability' });
    expect(within(again).getByRole('link', { name: 'Go to Subscriptions' })).toBeVisible();
    expect(within(again).queryByRole('link', { name: 'View model details' })).not.toBeInTheDocument();
  });

  it('words every MaaS state as the design does', async () => {
    const service = running();
    const smollm2 = modelsOf(service).find('smollm2');
    renderAt('/models', service);
    const cell = async () => within(await rowOf('smollm2')).getByTestId('model-availability-smollm2');
    for (const [state, text] of [
      [ModelMaasState.AVAILABLE, /^Available availability of smollm2$/],
      [ModelMaasState.CONFIGURING_ROUTING, /^Pending availability of smollm2Configuring route: smollm2$/],
      [
        ModelMaasState.AWAITING_SUBSCRIPTION_AND_BACKEND,
        /^Pending availability of smollm2Awaiting subscription and backend: smollm2$/,
      ],
      [ModelMaasState.UNAVAILABLE, /^Unavailable availability of smollm2Endpoint not serving: smollm2$/],
      [ModelMaasState.FAILED, /^Failed availability of smollm2Setup failed: smollm2$/],
    ] as [ModelMaasState, RegExp][]) {
      smollm2.status!.maas = state;
      cleanup();
      renderAt('/models', service);
      expect(await cell()).toHaveTextContent(text);
    }
  });

  describe.each([
    ['the Models list', '/models'],
    ['the model page', '/models/smollm2'],
  ])('the Unavailable reason on %s', (_, path) => {
    const generic =
      'The inference service is not serving requests. The model server might be starting, crashing, or lacking resources.';
    // As the backend reports them (apply and unservedReason in its models_git.go): status.message is
    // the phase summary, which can open with "Ready on", and status.maas_message alone says why MaaS
    // reads Unavailable, while MaaS on the ingress cluster still says Available.
    const servedName = {
      message:
        'Not ready on site2; ready on site1; published on hub-ingress; serves "facebook/opt-125m" while MaaS lists it as "smollm2"; update the model to serve it as its id',
      maasMessage:
        'The model\'s deployment serves it as "facebook/opt-125m", but MaaS lists it as "smollm2", so requests through MaaS can\'t reach it. Update the model to serve it as "smollm2"; any update does this.',
    };
    const notRunning = {
      message: 'Stopped on site1, site2; published on hub-ingress',
      maasMessage: "The model isn't running on any cluster it's placed on. It's stopped on site1, site2.",
    };
    const serviceWith = (maas: ModelMaasState, status: { message: string; maasMessage: string }) => {
      const service = running();
      const smollm2 = modelsOf(service).find('smollm2');
      smollm2.status!.maas = maas;
      smollm2.status!.message = status.message;
      smollm2.status!.maasMessage = status.maasMessage;
      smollm2.status!.ingress[0].state = ModelMaasState.AVAILABLE;
      smollm2.status!.ingress[0].message = 'Model is available';
      return service;
    };
    const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole('button', { name: 'Unavailable availability of smollm2' }));
      return screen.findByRole('dialog', { name: 'smollm2 availability' });
    };

    it.each([
      ['its deployment serves another name', servedName],
      ['no placed cluster runs it', notRunning],
    ])("shows the backend's reason when %s, not the phase summary", async (_, status) => {
      const user = userEvent.setup();
      renderAt(path, serviceWith(ModelMaasState.UNAVAILABLE, status));
      const dialog = await openDialog(user);
      const heading = within(dialog).getByRole('heading', { name: 'Warning alert: Model unavailable' });
      // The alert's body is the reason, whole and as sent.
      expect(heading.closest('.pf-v6-c-alert')?.querySelector('.pf-v6-c-alert__description')?.textContent).toBe(
        status.maasMessage,
      );
      expect(dialog).not.toHaveTextContent(generic);
      expect(dialog).not.toHaveTextContent(status.message);
      // MaaS's own words stay, per ingress cluster.
      expect(within(dialog).getByLabelText('What MaaS reported')).toHaveTextContent(
        'MaaS on hub-ingressAvailable: Model is available',
      );
    });

    it('keeps the generic text without a reason, never the phase summary', async () => {
      const user = userEvent.setup();
      renderAt(path, serviceWith(ModelMaasState.UNAVAILABLE, { message: notRunning.message, maasMessage: '' }));
      const dialog = await openDialog(user);
      expect(dialog).toHaveTextContent(generic);
      expect(dialog).not.toHaveTextContent(notRunning.message);
    });

    it('shows no reason for Available, whose label opens nothing', async () => {
      renderAt(
        path,
        serviceWith(ModelMaasState.AVAILABLE, {
          message: 'Ready on site1, site2; published on hub-ingress',
          maasMessage: '',
        }),
      );
      expect(await screen.findByText('availability of smollm2', { exact: false })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /availability of smollm2/ })).not.toBeInTheDocument();
      expect(screen.queryByText(generic, { exact: false })).not.toBeInTheDocument();
    });
  });

  it("shows each cluster's status with KServe's message in its dialog", async () => {
    const user = userEvent.setup();
    renderAt('/models/smollm2', running());
    const rows = await tableRows('Clusters of smollm2');
    expect(rows.map((r) => cellIn(r, 'Status').textContent)).toEqual(['Ready on site1', 'Starting on site2']);
    await user.click(within(rows[1]).getByRole('button', { name: 'Starting on site2' }));
    const modal = await screen.findByRole('dialog', { name: 'smollm2 on site2' });
    const reported = within(modal).getByLabelText('What site2 reported');
    expect(reported).toHaveTextContent('Model on the clusterStarting');
    expect(reported).toHaveTextContent('Model messageDeployment does not have minimum availability.');
    expect(reported).not.toHaveTextContent(/Deployment(?! does)/);
  });

  it("lists MaaS on each ingress cluster on the model page, with MaaS's message", async () => {
    renderAt('/models/smollm2', running());
    const section = await screen.findByTestId('model-maas-endpoint');
    expect(within(section).getByRole('button', { name: 'Pending availability of smollm2' })).toBeVisible();
    const rows = await tableRows('Availability of smollm2', section);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByRole('link', { name: 'hub-ingress' })).toHaveAttribute('href', '/clusters/hub-ingress');
    // hub-ingress isn't a cluster the hub lists here, so its site and region are dashes.
    expect(cellIn(rows[0], 'Site')).toHaveTextContent(/^—$/);
    expect(cellIn(rows[0], 'Region')).toHaveTextContent(/^—$/);
    expect(cellIn(rows[0], 'Availability')).toHaveTextContent(/^Awaiting subscription on hub-ingress$/);
    expect(rows[0]).toHaveTextContent('Awaiting governance pairing');
  });

  it('words a stopped cluster, a failed sync and a cluster syncing', async () => {
    const user = userEvent.setup();
    const service = running();
    const smollm2 = modelsOf(service).find('smollm2');
    smollm2.status!.clusters[0].deployment = ModelDeploymentState.STOPPED;
    smollm2.status!.clusters[0].deploymentMessage = 'Service is stopped';
    smollm2.status!.clusters[0].sync = ModelSyncState.SYNCED;
    smollm2.status!.clusters[1].deployment = ModelDeploymentState.UNSPECIFIED;
    smollm2.status!.clusters[1].deploymentMessage = '';
    smollm2.status!.clusters[1].sync = ModelSyncState.FAILED;
    smollm2.status!.clusters[1].syncMessage = 'one or more objects failed to apply';
    renderAt('/models/smollm2', service);
    const rows = await tableRows('Clusters of smollm2');
    expect(cellIn(rows[0], 'Status')).toHaveTextContent('Stopped on site1');
    expect(cellIn(rows[1], 'Status')).toHaveTextContent('Failed on site2');
    await user.click(within(rows[1]).getByRole('button', { name: 'Failed on site2' }));
    const modal = await screen.findByRole('dialog', { name: 'smollm2 on site2' });
    expect(modal).toHaveTextContent('Git syncSync failed');
    expect(modal).toHaveTextContent('one or more objects failed to apply');
    await user.click(within(modal).getByRole('button', { name: 'Close' }));
    smollm2.status!.clusters[1].sync = ModelSyncState.OUT_OF_SYNC;
    smollm2.status!.clusters[1].syncMessage = '';
    cleanup();
    renderAt('/models/smollm2', service);
    const again = await tableRows('Clusters of smollm2');
    expect(cellIn(again[1], 'Status')).toHaveTextContent('Syncing on site2');
    await user.click(within(again[1]).getByRole('button', { name: 'Syncing on site2' }));
    expect(await screen.findByRole('dialog', { name: 'smollm2 on site2' })).toHaveTextContent(
      'currently synchronizing',
    );
  });

  it('opens a Partially ready model to each cluster', async () => {
    const user = userEvent.setup();
    renderAt('/models', running());
    await user.click(within(await rowOf('smollm2')).getByRole('button', { name: 'Partially ready for smollm2' }));
    const modal = await screen.findByRole('dialog', { name: 'smollm2 status' });
    expect(modal).toHaveTextContent('The model isn’t ready on one or more of its clusters.');
    const rows = await tableRows('Clusters of smollm2', modal);
    expect(rows).toHaveLength(2);
    // The dialog's cluster statuses open nothing: PatternFly's dialogs don't stack.
    for (const r of rows) expect(within(r).queryByRole('button')).not.toBeInTheDocument();
  });

  it('links View to OpenShift AI or the OpenShift console, and nothing else', async () => {
    const service = running();
    const smollm2 = modelsOf(service).find('smollm2');
    smollm2.status!.clusters[0].viewUrl = 'https://rh-ai.apps.site1.example.com/ai-hub/models/deployments/internal/m';
    smollm2.status!.clusters[0].viewTarget = ModelViewTarget.OPENSHIFT_AI;
    smollm2.status!.clusters[1].viewUrl = 'http://console-openshift-console.apps.site2.example.com/k8s/ns/models';
    smollm2.status!.clusters[1].viewTarget = ModelViewTarget.OPENSHIFT_CONSOLE;
    renderAt('/models/smollm2', service);
    const rows = await tableRows('Clusters of smollm2');
    const view = within(rows[0]).getByRole('link', { name: 'View on site1 in OpenShift AI' });
    expect(view).toHaveAttribute('target', '_blank');
    expect(view).toHaveAttribute('rel', 'noopener noreferrer');
    // A link that isn't https isn't rendered, plain http included.
    expect(within(rows[1]).queryByRole('link', { name: /^View/ })).not.toBeInTheDocument();
    expect(cellIn(rows[1], 'View')).toHaveTextContent(/^—$/);
  });

  it.each([
    ['an https URL', 'https://console.apps.site1.example.com/k8s/ns/models', true],
    ['an https URL with a port', 'https://console.apps.site1.example.com:8443/x', true],
    ['http', 'http://console.apps.site1.example.com/k8s', false],
    ['javascript', 'javascript:alert(1)', false],
    ['a user name', 'https://admin@console.apps.site1.example.com/', false],
    ['a user name and password', 'https://admin:secret@console.apps.site1.example.com/', false],
    ['no host', 'https://', false],
    ['a relative path', '/k8s/ns/models', false],
    ['not a URL', 'console.apps.site1.example.com', false],
    ['nothing', '', false],
  ])('renders View for %s only when it is https with a host and no user', (_name, href, renders) => {
    expect(viewHref(href)).toBe(renders ? new URL(href).href : undefined);
  });

  it('words cluster states newer than the pin Unknown', async () => {
    const service = running();
    const smollm2 = modelsOf(service).find('smollm2');
    smollm2.status!.clusters[1].state = 99 as ModelState;
    renderAt('/models/smollm2', service);
    const rows = await tableRows('Clusters of smollm2');
    expect(cellIn(rows[1], 'Status')).toHaveTextContent('Unknown on site2');
  });

  it('keeps the model status dialog closed after polling out of and back into Partially ready', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const service = running();
      const smollm2 = modelsOf(service).find('smollm2');
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderAt('/models', service);
      await user.click(within(await rowOf('smollm2')).getByRole('button', { name: 'Partially ready for smollm2' }));
      expect(await screen.findByRole('dialog', { name: 'smollm2 status' })).toBeVisible();
      smollm2.status!.clusters[1].deployment = ModelDeploymentState.RUNNING;
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'smollm2 status' })).not.toBeInTheDocument());
      smollm2.status!.clusters[1].deployment = ModelDeploymentState.STARTING;
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      await waitFor(() =>
        expect(
          within(screen.getByTestId('model-cluster-names-smollm2').closest('tr')!).getByTestId('model-phase'),
        ).toHaveTextContent('Partially ready'),
      );
      expect(screen.queryByRole('dialog', { name: 'smollm2 status' })).not.toBeInTheDocument();
      await user.click(within(await rowOf('smollm2')).getByRole('button', { name: 'Partially ready for smollm2' }));
      expect(await screen.findByRole('dialog', { name: 'smollm2 status' })).toBeVisible();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: 'smollm2 status' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['/models', '/models/smollm2'])(
    'keeps Availability closed after polling through Available on %s',
    async (path) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const service = running();
        const smollm2 = modelsOf(service).find('smollm2');
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderAt(path, service);
        await user.click(await screen.findByRole('button', { name: 'Pending availability of smollm2' }));
        const availability = { name: 'smollm2 availability' };
        expect(await screen.findByRole('dialog', availability)).toBeVisible();
        smollm2.status!.maas = ModelMaasState.AVAILABLE;
        await act(() => vi.advanceTimersByTimeAsync(30_000));
        await waitFor(() => expect(screen.queryByRole('dialog', availability)).not.toBeInTheDocument());
        smollm2.status!.maas = ModelMaasState.AWAITING_SUBSCRIPTION;
        await act(() => vi.advanceTimersByTimeAsync(30_000));
        expect(await screen.findByRole('button', { name: 'Pending availability of smollm2' })).toBeVisible();
        expect(screen.queryByRole('dialog', availability)).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Pending availability of smollm2' }));
        expect(await screen.findByRole('dialog', availability)).toBeVisible();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog', availability)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("titles the model page's alert with its Status word, not the phase", async () => {
    const service = running();
    const smollm2 = modelsOf(service).find('smollm2');
    smollm2.status!.state = ModelState.STOPPED;
    smollm2.status!.phase = ModelPhase.PENDING;
    smollm2.status!.reason = 'Stopped';
    smollm2.status!.message = 'Not ready on site1, site2';
    // As the backend reports a model stopped everywhere: each cluster stopped too.
    for (const c of smollm2.status!.clusters) {
      c.state = ModelState.STOPPED;
      c.deployment = ModelDeploymentState.STOPPED;
      c.deploymentMessage = 'Service is stopped';
    }
    renderAt('/models/smollm2', service);
    expect(await screen.findByTestId('model-status-alert')).toHaveTextContent(/^.*Stopped/);
    expect(screen.getByTestId('model-status-alert')).not.toHaveTextContent('Pending');
  });

  it('explains a starting model by its clusters, and keeps a MaaS failure under Availability', async () => {
    const service = running();
    const smollm2 = modelsOf(service).find('smollm2');
    // Starting on its clusters; MaaS failed to publish it on hub-ingress, so the phase is Failed.
    smollm2.status!.state = ModelState.STARTING;
    smollm2.status!.phase = ModelPhase.FAILED;
    smollm2.status!.reason = 'Failed';
    smollm2.status!.message = 'Failed to publish on hub-ingress: HTTPRoute rejected';
    smollm2.status!.maas = ModelMaasState.FAILED;
    smollm2.status!.ingress[0].state = ModelMaasState.FAILED;
    smollm2.status!.ingress[0].message = 'HTTPRoute rejected by the gateway.';
    smollm2.status!.clusters[0].state = ModelState.STARTING;
    smollm2.status!.clusters[0].deployment = ModelDeploymentState.STARTING;
    smollm2.status!.clusters[1].state = ModelState.STARTING;
    renderAt('/models/smollm2', service);
    const alert = await screen.findByTestId('model-status-alert');
    expect(alert).toHaveClass('pf-m-info');
    expect(within(alert).getByRole('heading', { name: 'Info alert: Starting' })).toBeVisible();
    expect(alert).toHaveTextContent('site2: Starting. Deployment does not have minimum availability.');
    expect(alert).not.toHaveTextContent('Unable to deploy');
    expect(alert).not.toHaveTextContent('HTTPRoute');
    // MaaS's failure is under Availability.
    const [ingress] = await tableRows('Availability of smollm2', screen.getByTestId('model-maas-endpoint'));
    expect(ingress).toHaveTextContent('HTTPRoute rejected by the gateway.');
    expect(
      within(screen.getByTestId('model-maas-endpoint')).getByRole('button', { name: 'Failed availability of smollm2' }),
    ).toBeVisible();
  });

  it('says when no ingress cluster reports the model', async () => {
    renderAt('/models/granite-3-8b', new MockConsoleService());
    expect(await screen.findByText('No ingress cluster has reported this model yet.')).toBeVisible();
  });

  it('has no MaaS table for a model no ingress cluster reports', async () => {
    renderAt('/models/granite-3-8b', new MockConsoleService());
    await screen.findByText('Resource name');
    expect(screen.queryByRole('grid', { name: 'Availability of Granite 3.3 8B Instruct' })).not.toBeInTheDocument();
  });
});
