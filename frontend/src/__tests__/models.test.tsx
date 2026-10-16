// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/deployments.test.tsx at 62319b8.
// The PoC drives its Git-backed API; here the same cases run on MockConsoleService, and the
// BFF and fake backend rules are covered by bff/internal/api and bff/internal/fakebackend tests.
// Rulings and scope:
// - The Git file assertions (deployment, MaaSModelRef, Placement, ManifestWorkReplicaSet) become
//   assertions on the saved model; the console's backend owns those resources.
// - The new model in the subscription model picker is covered by subscriptions.test.tsx, which
//   picks models from the same list.
// - "persists deployment management in mock storage…" keeps only its location and stale-version
//   assertions (A5, D3); a referenced model is the blocked-delete case.
// - "explains a 200 response from an outdated backend" tests a PoC-only legacy payload and is
//   not ported.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import getModels from '../../../mock/examples/get-models.json';
import { ServiceError } from '../api/ConsoleService';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import type { CreateModelRequest } from '../api/types';
import { renderAt } from './render';

const input: CreateModelRequest = {
  name: 'widget',
  displayName: 'Widget',
  modelUri: 'hf://org/widget',
  modelName: 'org/widget',
  runtimeImage: 'registry.example/runtime:test',
  replicas: 1,
  cpu: '2',
  memory: '4Gi',
  gpuCount: 0,
  locations: ['site1', 'site2'],
  runtimeArgs: [],
};

const viewer = { username: 'viewer', groups: [], isProviderAdmin: false };

type User = ReturnType<typeof userEvent.setup>;

/** Fills the model details and deployment steps and moves on to Advanced settings. */
const fillModel = async (user: User) => {
  await user.type(await screen.findByRole('textbox', { name: /Model URI/ }), 'hf://org/widget');
  await user.type(screen.getByRole('textbox', { name: /^Model name/ }), 'org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(await screen.findByTestId('model-name-desc-name'), 'Widget');
  await user.type(screen.getByRole('textbox', { name: /Runtime image/ }), 'registry.example/runtime:test');
  await user.click(screen.getByRole('button', { name: 'Next' }));
};

it('walks the deployment wizard, selects locations, saves the model and removes it', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/models', service);
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Deploy model' }));
  expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
  await fillModel(user);
  expect(screen.queryByLabelText('Publish as MaaS')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  const reviewNav = within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', {
    name: /Review/,
  });
  expect(reviewNav).toBeVisible();
  expect(reviewNav).toBeDisabled();
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: 'site1' }));
  await user.click(screen.getByRole('option', { name: 'site2' }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('button', { name: 'Save deployment' }));

  const table = await screen.findByTestId('model-deployments-table');
  expect(table).toHaveTextContent('Widget');
  expect(await screen.findByText('Model deployment saved')).toBeVisible();
  const locationsCell = screen.getByTestId('model-locations-expand-widget');
  const expandLocations = within(locationsCell).getByRole('button');
  expect(expandLocations).toHaveTextContent('2');
  expect(expandLocations).toHaveAttribute('aria-expanded', 'false');
  await user.click(expandLocations);
  const panel = within(locationsCell.closest('tbody')!).getByTestId('locations-expanded-panel');
  expect(panel).toBeVisible();
  expect(panel).toHaveTextContent('site1');
  expect(panel).toHaveTextContent('site2');
  await user.click(expandLocations);
  expect(expandLocations).toHaveAttribute('aria-expanded', 'false');
  expect(panel).not.toBeVisible();
  const saved = (await service.listModels()).find((m) => m.name === 'widget');
  expect(saved).toMatchObject({
    namespace: 'ai-grid-models',
    modelUri: 'hf://org/widget',
    modelName: 'org/widget',
    modelRef: { kind: 'LLMInferenceService', name: 'widget' },
    locations: ['site1', 'site2'],
    availableForSubscriptions: true,
  });

  await user.click(screen.getByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  expect(dialog).toHaveTextContent('Delete model deployment?');
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
  await user.type(within(dialog).getByTestId('delete-modal-input'), 'Widget');
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('model-actions-widget')).not.toBeInTheDocument());
  expect((await service.listModels()).some((m) => m.name === 'widget')).toBe(false);
}, 20000);

it('keeps the confirmation dialog and model when a subscription blocks deletion', async () => {
  const service = new MockConsoleService();
  const result = await service.createModel(input);
  await service.createSubscription({
    name: 'widget-users',
    owner: { groups: [{ name: 'widget-users' }] },
    modelRefs: [{ name: 'widget', tokenRateLimits: [{ limit: 1000, window: '1h' }] }],
    priority: 0,
    tokenMetadata: { organizationId: '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c' },
    createAuthPolicy: true,
  });
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.type(screen.getByTestId('delete-modal-input'), 'Widget');
  await user.click(within(screen.getByTestId('delete-deployment-modal')).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByTestId('delete-model-error-message-alert')).toHaveTextContent('Remove this model');
  expect(screen.getByTestId('delete-deployment-modal')).toBeVisible();
  expect((await service.listModels()).find((m) => m.name === 'widget')?.resourceVersion).toBe(result.resourceVersion);
});

it('offers Ready, provisioned locations and protects models from stale versions', async () => {
  const service = new MockConsoleService();
  expect(await service.listLocations()).toEqual(['site1', 'site2', 'site3']);
  const before = (await service.listModels()).length;
  await expect(service.createModel({ ...input, locations: ['site4'] })).rejects.toMatchObject({
    status: 422,
    fieldErrors: { locations: 'Select locations from the available location catalog.' },
  });
  const result = await service.createModel(input);
  expect((await service.listModels()).find((m) => m.name === 'widget')?.locations).toEqual(['site1', 'site2']);
  expect(await service.listModels()).toHaveLength(before + 1);
  await expect(service.createModel(input)).rejects.toMatchObject({
    status: 409,
    message: 'A model with this resource name already exists.',
  });
  await expect(service.deleteModel('ai-grid-models', 'widget', `${result.resourceVersion}0`)).rejects.toMatchObject({
    status: 409,
    message: 'This model changed. Reload it before deleting.',
  });
  await service.deleteModel('ai-grid-models', 'widget', result.resourceVersion);
  expect(await service.listModels()).toHaveLength(before);
  expect((await service.listModels()).some((m) => m.name === 'widget')).toBe(false);
});

it('keeps the wizard usable after a location failure and retries', async () => {
  const service = new MockConsoleService();
  const list = service.listLocations;
  service.listLocations = async () => {
    service.listLocations = list;
    throw new ServiceError(503, 'Location catalog unavailable.');
  };
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Location catalog unavailable.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: 'site1' }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('hf://org/widget')).toBeVisible();
  expect(screen.getByText('site1')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save deployment' })).toBeEnabled();
});

it('keeps input when saving fails', async () => {
  const service = new MockConsoleService();
  await service.createModel(input);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: 'site3' }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Save deployment' }));
  expect(await screen.findByText('A model with this resource name already exists.')).toBeVisible();
  expect(screen.getByText('Unable to save deployment')).toBeVisible();
  expect(screen.getByText('hf://org/widget')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save deployment' })).toBeEnabled();
  expect((await service.listModels()).find((m) => m.name === 'widget')?.locations).toEqual(['site1', 'site2']);
});

it('hides write actions from a viewer', async () => {
  const service = new MockConsoleService(viewer);
  renderAt('/models', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('viewer'));
  const table = await screen.findByTestId('model-deployments-table');
  expect(table).toHaveTextContent('Granite 3.3 8B Instruct');
  expect(screen.queryByRole('link', { name: 'Deploy model' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('model-actions-granite-3-8b')).not.toBeInTheDocument();
});

it('shows the not-available state when the backend has no models yet', async () => {
  const service = new MockConsoleService();
  service.listModels = async () => {
    throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
  };
  renderAt('/models', service);
  expect(await screen.findByText('Models are not available on this backend yet')).toBeVisible();
  expect(screen.queryByTestId('model-deployments-table')).not.toBeInTheDocument();
});

it('paginates the list like the PoC', async () => {
  renderAt('/models', new MockConsoleService());
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(2);
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A MockConsoleService whose model calls go through HttpConsoleService to PR 12's model JSON
 * (mock/examples/get-models.json), as the BFF answers under PR 12's fixtures.
 */
const serviceOnModelJson = (fetchFn: ReturnType<typeof vi.fn>) => {
  const service = new MockConsoleService();
  const http = new HttpConsoleService(fetchFn as unknown as typeof fetch);
  service.listModels = () => http.listModels();
  service.listLocations = () => http.listLocations();
  service.createModel = (value) => http.createModel(value);
  service.deleteModel = (namespace, name, version) => http.deleteModel(namespace, name, version);
  return service;
};

const modelJsonFetch = () =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/locations')) return jsonResponse(200, { data: ['paris'] });
    return jsonResponse(200, { data: getModels.body.data });
  });

it('lists PR 12 models with their locations', async () => {
  const user = userEvent.setup();
  renderAt('/models', serviceOnModelJson(modelJsonFetch()));
  const table = await screen.findByTestId('model-deployments-table');
  expect(table).toHaveTextContent('Granite 8B Instruct');
  expect(table).toHaveTextContent('Tiny LLM (CPU)');
  const cell = screen.getByTestId('model-locations-expand-granite-8b-instruct');
  await user.click(within(cell).getByRole('button'));
  expect(within(cell.closest('tbody')!).getByTestId('locations-expanded-panel')).toHaveTextContent('paris');
  expect(within(screen.getByTestId('model-locations-expand-tiny-llm')).getByRole('button')).toHaveTextContent('0');
});

it('shows the phase', async () => {
  const user = userEvent.setup();
  renderAt('/models', serviceOnModelJson(modelJsonFetch()));
  const row = async (name: string) =>
    (await screen.findByTestId(`model-locations-expand-${name}`)).closest('tr') as HTMLElement;
  expect(within(await row('granite-8b-instruct')).getByTestId('model-phase')).toHaveTextContent('Ready');
  expect(within(await row('codellama-13b')).getByTestId('model-phase')).toHaveTextContent('Pending');
  const failed = within(await row('llama-3-70b')).getByTestId('model-phase');
  expect(failed).toHaveTextContent('Failed');
  expect(screen.queryByText(/Git/)).not.toBeInTheDocument();
  await user.click(within(failed).getByRole('button', { name: 'Failed' }));
  expect(await screen.findByText('ConfigNotFound')).toBeVisible();
  expect(screen.getByText(/v3-6-0-kserve-config-llm-template-tpu" not found/)).toBeVisible();
});

it('offers only eligible locations', async () => {
  const fetchFn = modelJsonFetch();
  const user = userEvent.setup();
  renderAt('/models/deploy', serviceOnModelJson(fetchFn));
  await fillModel(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['paris']);
  expect(fetchFn).toHaveBeenCalledWith('/api/v1/locations', expect.objectContaining({ method: 'GET' }));
});

it('deletes by namespace and name with If-Match', async () => {
  const fetchFn = modelJsonFetch();
  const user = userEvent.setup();
  renderAt('/models', serviceOnModelJson(fetchFn));
  await user.click(await screen.findByTestId('model-actions-granite-8b-instruct'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.type(screen.getByTestId('delete-modal-input'), 'Granite 8B Instruct');
  await user.click(within(screen.getByTestId('delete-deployment-modal')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('delete-deployment-modal')).not.toBeInTheDocument());
  const call = fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE');
  expect(call?.[0]).toBe('/api/v1/models/ai-grid-models/granite-8b-instruct');
  expect(call?.[1]?.headers).toMatchObject({ 'If-Match': '"48760230"' });
});
