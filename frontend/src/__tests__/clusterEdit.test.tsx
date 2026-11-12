// Edit, on the Clusters list and a cluster's page, against a Clusters service that answers Update as
// the backend does (its internal/servers/clusters_server.go): the version checked with `lock`, and
// each map the mask names replacing the cluster's. Edit changes the location label, and the role
// only of a cluster without one.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clone, create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { MockConsoleService } from '../api/MockConsoleService';
import { fakeClients } from '../api/connect/testing';
import type { ClustersUpdateRequest } from '../gen/ai_grid/v1/clusters_service_pb';
import {
  ManagedClusterLocationSource,
  ManagedClusterSchema,
  ManagedClusterState,
  type ManagedCluster,
} from '../gen/ai_grid/v1/managed_cluster_type_pb';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/clusters/ClusterDetailsPage';
import { deferred, findVisible, renderAt } from './render';

/** A ready cluster, an AI Grid member unless its labels say otherwise, at version 7. */
const managedCluster = (
  id: string,
  labels: Record<string, string>,
  annotations: Record<string, string> = {},
): ManagedCluster => {
  const latitude = Number(annotations['ai-grid/latitude']);
  const longitude = Number(annotations['ai-grid/longitude']);
  const mapped =
    annotations['ai-grid/latitude'] !== undefined &&
    annotations['ai-grid/longitude'] !== undefined &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude);
  return create(ManagedClusterSchema, {
    id,
    metadata: { name: id, labels, annotations, version: 7 },
    status: {
      aiGridMember: labels['ai-grid/enabled'] === 'true',
      provisioning: 'Compliant',
      state: ManagedClusterState.READY,
      location: {
        siteName: annotations['ai-grid/site-name'] ?? '',
        source: mapped ? ManagedClusterLocationSource.ANNOTATIONS : ManagedClusterLocationSource.NONE,
        ...(mapped ? { latitude, longitude } : {}),
      },
    },
  });
};

/** A member with a role, a label the console doesn't own, and annotations Edit never sends. */
const paris = () =>
  managedCluster(
    'paris-1',
    { 'ai-grid/enabled': 'true', 'ai-grid/role': 'ingress', location: 'eu-west', team: 'blue' },
    { 'ai-grid/site-name': 'Paris DC1', 'ai-grid/latitude': '48.8566', 'ai-grid/longitude': '2.3522' },
  );

/** A member without a role. */
const noRole = (id = 'no-role') => managedCluster(id, { 'ai-grid/enabled': 'true', location: 'eu-west' });

/**
 * Clusters/List, Get and Update over these clusters. Update records each request, checks the
 * version, and replaces the maps its mask names; `refuse` answers a request with an error instead,
 * and `hold` keeps the answer back until it settles.
 */
const clustersOf = (initial: ManagedCluster[]) => {
  const store = new Map(initial.map((c) => [c.id, c]));
  const requests: ClustersUpdateRequest[] = [];
  const state = {
    refuse: undefined as ((req: ClustersUpdateRequest) => ConnectError | undefined) | undefined,
    hold: undefined as Promise<void> | undefined,
  };
  /** Someone else's write: the cluster changed on the hub, at a newer version. */
  const changeOnHub = (id: string, change: (mc: ManagedCluster) => void) => {
    const next = clone(ManagedClusterSchema, store.get(id)!);
    change(next);
    next.metadata!.version += 3;
    store.set(id, next);
  };
  const { transport } = fakeClients({
    clusters: {
      list: () => ({ items: [...store.values()], size: store.size, total: store.size }),
      get: ({ id }) => {
        const object = store.get(id);
        if (!object) throw new ConnectError(`managed cluster "${id}" not found`, Code.NotFound);
        return { object };
      },
      update: async (req) => {
        requests.push(req);
        if (state.hold) await state.hold;
        const refusal = state.refuse?.(req);
        if (refusal) throw refusal;
        const id = req.object?.id ?? '';
        const current = store.get(id)!;
        if (req.object?.metadata?.version !== current.metadata?.version) {
          throw new ConnectError(`managed cluster "${id}" was modified; fetch it again and retry`, Code.Aborted);
        }
        const next = clone(ManagedClusterSchema, current);
        const paths = req.updateMask?.paths ?? [];
        if (paths.includes('metadata.labels')) next.metadata!.labels = { ...req.object?.metadata?.labels };
        if (paths.includes('metadata.annotations')) {
          next.metadata!.annotations = { ...req.object?.metadata?.annotations };
        }
        next.metadata!.version += 1;
        store.set(id, next);
        return { object: next };
      },
    },
  });
  return { transport, requests, state, changeOnHub, store };
};

type User = ReturnType<typeof userEvent.setup>;

/** Opens the edit dialog from a row's actions on the Clusters list. */
const openEdit = async (user: User, cluster: string) => {
  await user.click(await screen.findByRole('button', { name: `Actions for ${cluster}` }));
  await user.click(await findVisible('menuitem', 'Edit'));
  return screen.findByRole('dialog', { name: 'Edit AI Grid cluster' });
};

const field = (dialog: HTMLElement, name: string) => within(dialog).getByRole('textbox', { name });
// While it saves, the button's name starts with its spinner's text: the label stays Save.
const save = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /Save$/ });

/** Replaces a text field's value, then leaves it, as a user does. */
const enter = async (user: User, dialog: HTMLElement, name: string, value: string) => {
  const input = field(dialog, name);
  await user.clear(input);
  if (value) await user.paste(value);
  await user.tab();
};

const selectRole = async (user: User, dialog: HTMLElement, role: string) => {
  await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
  // An option is named by its label and then its description, which starts "The cluster".
  await user.click(await findVisible('option', new RegExp(`^${role} ?The cluster`)));
};

const renderList = (clusters: ManagedCluster[]) => {
  const backend = clustersOf(clusters);
  renderAt('/clusters', new MockConsoleService(), backend.transport);
  return backend;
};

const ROLE_FIXED = "A cluster's role cannot be changed once it has been added to the AI Grid.";
const SETTLES = 'The cluster shows Provisioning until the installation finishes.';

it('offers Edit for AI Grid clusters on the cluster page, before Remove from AI Grid', async () => {
  const user = userEvent.setup();
  const { transport } = clustersOf([paris()]);
  renderAt('/clusters/paris-1', new MockConsoleService(), transport);
  await user.click(await screen.findByRole('button', { name: 'Actions for paris-1' }));
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Edit', 'Remove from AI Grid']);
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  expect(await screen.findByRole('dialog', { name: 'Edit AI Grid cluster' })).toBeVisible();
});

it('offers no Edit for a cluster outside AI Grid, and the page still explains how a hub admin places it', async () => {
  const user = userEvent.setup();
  const { transport } = clustersOf([managedCluster('outside-1', { location: 'eu-west' })]);
  renderAt('/clusters/outside-1', new MockConsoleService(), transport);
  await user.click(await screen.findByRole('button', { name: 'Actions for outside-1' }));
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Add to AI Grid']);
  await user.keyboard('{Escape}');
  const position = screen.getByTestId('cluster-map-position');
  expect(within(position).getByRole('button', { name: "More about a cluster's map position" })).toBeVisible();
});

it('explains to a hub admin how to set the position of an AI Grid cluster without one, not offering Edit', async () => {
  const user = userEvent.setup();
  const { transport } = clustersOf([noRole('bare-1')]);
  renderAt('/clusters/bare-1', new MockConsoleService(), transport);
  const position = await screen.findByTestId('cluster-map-position');
  expect(position).toHaveTextContent('Not on the map: position not set');
  await user.click(within(position).getByRole('button', { name: "More about a cluster's map position" }));
  const help = await screen.findByText(/The map places a cluster from two annotations/);
  expect(help).toHaveTextContent('ai-grid/latitude');
  expect(help).toHaveTextContent('ai-grid/longitude');
  expect(help).toHaveTextContent('decimal degrees');
  // The help icon is the only control: Edit lives in the actions menu, not on the position.
  expect(within(position).getAllByRole('button')).toHaveLength(1);
});

it('shows the role of a cluster that has one read-only, with why, and only the location label to edit', async () => {
  const user = userEvent.setup();
  renderList([paris()]);
  const dialog = await openEdit(user, 'paris-1');
  const role = field(dialog, 'Role');
  expect(role).toHaveValue('Ingress');
  expect(role).toHaveAttribute('readonly');
  expect(role).toHaveAccessibleDescription(ROLE_FIXED);
  expect(within(dialog).queryByRole('combobox', { name: 'Role' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'More info for the role field' })).toBeVisible();
  expect(field(dialog, 'Location label')).toHaveValue('eu-west');
  expect(within(dialog).queryByText('For example, us-east.')).not.toBeInTheDocument();
  expect(within(dialog).getByText('Map position is 48.8566, 2.3522.')).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: 'Copy map position' })).not.toBeInTheDocument();
  expect(field(dialog, 'Location label')).toHaveAccessibleDescription(
    /^Must start and end with a letter or number\. .* Up to 63 characters\. Map position is 48\.8566, 2\.3522\.$/,
  );
  // No site name or position fields: they stay read-only in the console.
  expect(within(dialog).queryByRole('textbox', { name: /Site name|Latitude|Longitude/ })).not.toBeInTheDocument();
  expect(within(dialog).queryByTestId('cluster-role-change')).not.toBeInTheDocument();
  expect(save(dialog)).toBeDisabled();
});

it('saves a location-only edit as the labels as read with the location changed, and never the annotations', async () => {
  const user = userEvent.setup();
  const { requests } = renderList([paris()]);
  const dialog = await openEdit(user, 'paris-1');
  await enter(user, dialog, 'Location label', 'eu-central');
  await user.click(save(dialog));
  expect(await screen.findByText('Changes to cluster paris-1 saved')).toBeVisible();
  expect(screen.queryByRole('dialog', { name: 'Edit AI Grid cluster' })).not.toBeInTheDocument();
  expect(requests).toHaveLength(1);
  const [req] = requests;
  expect(req.updateMask?.paths).toEqual(['metadata.labels']);
  expect(req.lock).toBe(true);
  expect(req.object?.id).toBe('paris-1');
  expect(req.object?.metadata?.version).toBe(7);
  // Every label as read, the ones the console doesn't own included; the role as it was.
  expect(req.object?.metadata?.labels).toEqual({
    'ai-grid/enabled': 'true',
    'ai-grid/role': 'ingress',
    location: 'eu-central',
    team: 'blue',
  });
  expect(req.object?.metadata?.annotations).toEqual({});
  expect(screen.getByRole('row', { name: /^paris-1 / })).toHaveTextContent('eu-central');
});

it('never sends another role for a cluster that has one, even when the read-only field is changed', async () => {
  const user = userEvent.setup();
  const { requests } = renderList([paris()]);
  const dialog = await openEdit(user, 'paris-1');
  // A read-only input takes no edit from a user; a script can still change its value.
  fireEvent.change(field(dialog, 'Role'), { target: { value: 'Inference' } });
  fireEvent.input(field(dialog, 'Role'), { target: { value: 'inference' } });
  await enter(user, dialog, 'Location label', 'eu-central');
  await user.click(save(dialog));
  expect(await screen.findByText('Changes to cluster paris-1 saved')).toBeVisible();
  expect(requests[0].object?.metadata?.labels['ai-grid/role']).toBe('ingress');
});

it('saves nothing unchanged, including a location label edited back', async () => {
  const user = userEvent.setup();
  renderList([paris()]);
  const dialog = await openEdit(user, 'paris-1');
  expect(save(dialog)).toBeDisabled();
  await enter(user, dialog, 'Location label', 'eu-central');
  expect(save(dialog)).toBeEnabled();
  await enter(user, dialog, 'Location label', ' eu-west ');
  expect(save(dialog)).toBeDisabled();
});

it('checks the location label as Add does', async () => {
  const user = userEvent.setup();
  const { requests } = renderList([paris()]);
  const dialog = await openEdit(user, 'paris-1');
  await enter(user, dialog, 'Location label', '');
  expect(within(dialog).getByText('Required')).toBeVisible();
  await enter(user, dialog, 'Location label', 'eu west');
  expect(
    within(dialog).getByText(
      'Must start and end with a letter or number. Valid characters include letters, numbers, hyphens (-), underscores (_), and periods (.). Up to 63 characters.',
    ),
  ).toBeVisible();
  await user.click(save(dialog));
  expect(requests).toHaveLength(0);
});

it.each([
  [
    'Ingress',
    'ingress',
    'Saving sets the role to Ingress. The hub then installs MaaS, the consumer gateway, the MaaS portal, and the database replica on this cluster.',
  ],
  [
    'Inference',
    'inference',
    'Saving sets the role to Inference. The hub then installs KServe model serving, the provider gateway, and the GPU operators on this cluster.',
  ],
  [
    'Ingress and inference',
    'combined',
    'Saving sets the role to Ingress and inference. The hub then installs MaaS, the consumer gateway, the MaaS portal, the database replica, KServe model serving, the provider gateway, and the GPU operators on this cluster.',
  ],
])(
  'sets %s on a cluster without a role, says what the hub will install, and asks for no name',
  async (label, value, installs) => {
    const user = userEvent.setup();
    const { requests } = renderList([noRole()]);
    const dialog = await openEdit(user, 'no-role');
    expect(within(dialog).getByRole('combobox', { name: 'Role' })).toHaveValue('');
    expect(within(dialog).queryByTestId('cluster-role-change')).not.toBeInTheDocument();
    await selectRole(user, dialog, label);
    const change = within(dialog).getByTestId('cluster-role-change');
    expect(within(change).getByRole('heading', { name: 'Info alert: What the hub installs' })).toBeVisible();
    expect(
      within(within(change).getByRole('list'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([installs, SETTLES]);
    // It only adds: no typed name.
    expect(within(dialog).queryByRole('textbox', { name: /^Type no-role to confirm/ })).not.toBeInTheDocument();
    await user.click(save(dialog));
    expect(await screen.findByText('Changes to cluster no-role saved')).toBeVisible();
    expect(requests[0].updateMask?.paths).toEqual(['metadata.labels']);
    expect(requests[0].object?.metadata?.labels).toEqual({
      'ai-grid/enabled': 'true',
      'ai-grid/role': value,
      location: 'eu-west',
    });
    expect(screen.getByRole('row', { name: /^no-role / })).toHaveTextContent(label);
  },
);

it('lets a role label that is not one of the three be replaced by one', async () => {
  const user = userEvent.setup();
  const { requests } = renderList([
    managedCluster('odd-1', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'gateway', location: 'eu-west' }),
  ]);
  const dialog = await openEdit(user, 'odd-1');
  expect(within(dialog).getByRole('combobox', { name: 'Role' })).toHaveValue('');
  await selectRole(user, dialog, 'Inference');
  expect(within(dialog).getByTestId('cluster-role-change')).toHaveTextContent('Saving sets the role to Inference.');
  await user.click(save(dialog));
  expect(await screen.findByText('Changes to cluster odd-1 saved')).toBeVisible();
  expect(requests[0].object?.metadata?.labels['ai-grid/role']).toBe('inference');
});

it('announces what Save will install: the alert is a polite live region, and follows the role selected', async () => {
  const user = userEvent.setup();
  renderList([noRole()]);
  const dialog = await openEdit(user, 'no-role');
  await selectRole(user, dialog, 'Ingress');
  const change = within(dialog).getByTestId('cluster-role-change');
  expect(change).toHaveAttribute('aria-live', 'polite');
  expect(change).toHaveTextContent('Saving sets the role to Ingress.');
  await selectRole(user, dialog, 'Inference');
  // The same region, so the new role's text is announced as a change.
  expect(within(dialog).getByTestId('cluster-role-change')).toBe(change);
  expect(change).toHaveTextContent('Saving sets the role to Inference.');
});

it('says the map position is not set when the details page would', async () => {
  const user = userEvent.setup();
  renderList([noRole()]);
  const dialog = await openEdit(user, 'no-role');
  expect(within(dialog).getByText(/Map position is not set\./)).toBeVisible();
  const how = within(dialog).getByRole('button', { name: "More about a cluster's map position" });
  await user.click(how);
  expect(await screen.findByText(/The map places a cluster from two annotations/)).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: 'Copy map position' })).not.toBeInTheDocument();
});

it('asks for a role before saving a location label on a cluster without one', async () => {
  const user = userEvent.setup();
  const { requests } = renderList([noRole()]);
  const dialog = await openEdit(user, 'no-role');
  await enter(user, dialog, 'Location label', 'eu-central');
  await user.click(save(dialog));
  expect(within(dialog).getByText('Required')).toBeVisible();
  expect(requests).toHaveLength(0);
});

it('keeps every control disabled while the save is out, and sends it once', async () => {
  const user = userEvent.setup();
  const { requests, state } = renderList([noRole()]);
  const answer = deferred<void>();
  state.hold = answer.promise;
  const dialog = await openEdit(user, 'no-role');
  await selectRole(user, dialog, 'Inference');
  await enter(user, dialog, 'Location label', 'eu-central');
  await user.click(save(dialog));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(save(dialog)).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(within(dialog).getByRole('combobox', { name: 'Role' })).toBeDisabled();
  expect(field(dialog, 'Location label')).toBeDisabled();
  await user.click(save(dialog));
  expect(requests).toHaveLength(1);
  answer.resolve();
  expect(await screen.findByText('Changes to cluster no-role saved')).toBeVisible();
  expect(requests).toHaveLength(1);
});

it.each([
  [
    'an unknown role (InvalidArgument)',
    Code.InvalidArgument,
    'label "ai-grid/role" must be ingress, inference or combined, got "gateway"',
    'label "ai-grid/role" must be ingress, inference or combined, got "gateway"',
  ],
  [
    'models placed on it (FailedPrecondition)',
    Code.FailedPrecondition,
    'Cluster "no-role" has 2 models placed on it (model-a, model-b). Move them to other clusters before changing it to a role without inference.',
    'Cluster "no-role" has 2 models placed on it (model-a, model-b). Move them to other clusters before changing it to a role without inference.',
  ],
  [
    'the only ingress cluster (FailedPrecondition)',
    Code.FailedPrecondition,
    'Cluster "no-role" is the only AI Grid cluster that serves ingress, and users reach models through ingress clusters. Give another cluster the ingress or combined role first.',
    'Cluster "no-role" is the only AI Grid cluster that serves ingress, and users reach models through ingress clusters. Give another cluster the ingress or combined role first.',
  ],
  [
    'the cluster list refused (PermissionDenied)',
    Code.PermissionDenied,
    'managedclusters.cluster.open-cluster-management.io is forbidden: cannot list resource "managedclusters"',
    'managedclusters.cluster.open-cluster-management.io is forbidden: cannot list resource "managedclusters"',
  ],
  // The catalog can't be read: the console's words, as for any Unavailable, since such a message
  // can name the backend's internals.
  [
    'the catalog unreadable (Unavailable)',
    Code.Unavailable,
    'read catalog: git fetch: dial tcp 192.0.2.1:443: connection refused',
    'The AI Grid backend is unavailable. Try again.',
  ],
])('shows the backend refusing for %s, and keeps the form', async (_case, code, sent, shown) => {
  const user = userEvent.setup();
  const { requests, state } = renderList([noRole()]);
  state.refuse = () => new ConnectError(sent, code);
  const dialog = await openEdit(user, 'no-role');
  await selectRole(user, dialog, 'Inference');
  await enter(user, dialog, 'Location label', 'eu-central');
  await user.click(save(dialog));
  const alert = await within(dialog).findByRole('heading', { name: 'Danger alert: Unable to update cluster' });
  expect(alert.closest('.pf-v6-c-alert')).toHaveTextContent(shown);
  if (shown !== sent) expect(dialog).not.toHaveTextContent(sent);
  expect(requests).toHaveLength(1);
  // Nothing the user entered is lost, and Save can be tried again.
  expect(within(dialog).getByRole('combobox', { name: 'Role' })).toHaveValue('Inference');
  expect(field(dialog, 'Location label')).toHaveValue('eu-central');
  expect(save(dialog)).toBeEnabled();
  expect(screen.queryByText('Changes to cluster no-role saved')).not.toBeInTheDocument();
});

it('says so on a backend without the update', async () => {
  const user = userEvent.setup();
  const { state } = renderList([paris()]);
  state.refuse = () => new ConnectError('not implemented', Code.Unimplemented);
  const dialog = await openEdit(user, 'paris-1');
  await enter(user, dialog, 'Location label', 'eu-central');
  await user.click(save(dialog));
  expect(await within(dialog).findByText('Editing a cluster is not available on this AI Grid backend.')).toBeVisible();
});

it('loads the cluster again after a conflict, keeps the edit, and saves it at the new version', async () => {
  const user = userEvent.setup();
  const { requests, changeOnHub } = renderList([paris()]);
  const dialog = await openEdit(user, 'paris-1');
  await enter(user, dialog, 'Location label', 'eu-central');
  // Someone else changes a label the dialog doesn't edit.
  changeOnHub('paris-1', (mc) => {
    mc.metadata!.labels.team = 'red';
  });
  await user.click(save(dialog));
  expect(
    await within(dialog).findByText(
      'This cluster was changed after this dialog opened. The latest version is now shown. Review it and try again.',
    ),
  ).toBeVisible();
  expect(field(dialog, 'Location label')).toHaveValue('eu-central');
  await user.click(save(dialog));
  expect(await screen.findByText('Changes to cluster paris-1 saved')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].object?.metadata?.version).toBe(10);
  // Their label is sent back as the backend has it now.
  expect(requests[1].object?.metadata?.labels).toMatchObject({ team: 'red', location: 'eu-central' });
});

it('shows the role and location label someone else set meanwhile instead of sending the dialog’s over them', async () => {
  const user = userEvent.setup();
  const { requests, changeOnHub } = renderList([noRole()]);
  const dialog = await openEdit(user, 'no-role');
  await selectRole(user, dialog, 'Inference');
  await enter(user, dialog, 'Location label', 'eu-central');
  // Another admin sets a role and a location label while the dialog is open.
  changeOnHub('no-role', (mc) => {
    mc.metadata!.labels['ai-grid/role'] = 'ingress';
    mc.metadata!.labels.location = 'eu-south';
  });
  await user.click(save(dialog));
  expect(
    await within(dialog).findByText(
      "Another user changed this cluster's location label or role after this dialog opened. Their values are now shown. Review them and try again.",
    ),
  ).toBeVisible();
  // Their role is now the cluster's, so it is read-only, and their location label is shown.
  expect(field(dialog, 'Role')).toHaveValue('Ingress');
  expect(field(dialog, 'Location label')).toHaveValue('eu-south');
  expect(save(dialog)).toBeDisabled();
  expect(requests).toHaveLength(1);
});

it('edits from the cluster page and shows the result there', async () => {
  const user = userEvent.setup();
  const { requests, transport } = clustersOf([noRole()]);
  renderAt('/clusters/no-role', new MockConsoleService(), transport);
  await user.click(await screen.findByRole('button', { name: 'Actions for no-role' }));
  await user.click(await findVisible('menuitem', 'Edit'));
  const dialog = await screen.findByRole('dialog', { name: 'Edit AI Grid cluster' });
  await selectRole(user, dialog, 'Ingress and inference');
  await enter(user, dialog, 'Location label', 'eu-central');
  await user.click(save(dialog));
  expect(await screen.findByText('Changes to cluster no-role saved')).toBeVisible();
  expect(requests[0].updateMask?.paths).toEqual(['metadata.labels']);
  const aiGrid = screen.getByLabelText('AI Grid membership');
  expect(aiGrid).toHaveTextContent('eu-central');
  expect(aiGrid).toHaveTextContent('Ingress and inference');
});
