// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/clusters.test.tsx at 62319b8.
// The PoC drives a fake ACM Hub through its backend; here the same cases run on
// MockConsoleService, and the BFF's PATCH is covered by bff/internal/api tests.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceError } from '../api/ConsoleService';
import { create } from '@bufbuild/protobuf';
import { fakeClients } from '../api/connect/testing';
import { MockConsoleService, seedClusters } from '../api/MockConsoleService';
import type { GridCluster } from '../api/types';
import {
  ManagedClusterLocationSource,
  ManagedClusterSchema,
  ManagedClusterState,
} from '../gen/ai_grid/v1/managed_cluster_type_pb';
import { createClient } from '@connectrpc/connect';
import { Clusters } from '../api/connect/clients';
import { notificationsKey, watchesKey } from '../notifications/storageKeys';
import { AI_GRID_SUMMARY } from '../pages/clusters/clusterInfo';
import { LOCATION_DOCS_URL } from '../pages/clusters/site';
import { EMPTY_VALUE } from '../utilities/format';
import { transportFor } from './connectClusters';
import { renderAt } from './render';

const cluster = (name: string, status: GridCluster['status'], labels: Record<string, string> = {}): GridCluster => {
  const aiGridEnabled = labels['ai-grid/enabled'] === 'true';
  const provisioned = labels['ai-grid/provisioned'] === 'true';
  return {
    name,
    status,
    aiGridEnabled,
    provisioned,
    provisioningStatus: provisioned ? 'Provisioned' : aiGridEnabled ? 'Provisioning' : 'Not provisioned',
    ...(labels.location ? { location: labels.location } : {}),
    addons: {},
    conditions: [],
    labels,
  };
};

const hubClusters = () => [
  cluster('cluster-a', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/provisioned': 'true', location: 'site1' }),
  cluster('cluster-b', 'Ready', { location: 'site2' }),
  cluster('cluster-c', 'Unavailable'),
];

const serviceWith = (clusters: GridCluster[]) => new MockConsoleService(undefined, clusters);

type User = ReturnType<typeof userEvent.setup>;

/** The add icon for a cluster outside AI grid. */
const addButton = (cluster: string) => screen.getByRole('button', { name: `Add ${cluster} to AI grid` });

/** The AI grid status cell: a member's provisioning, or — outside AI grid. */
const aiGridStatus = (row: HTMLElement) => row.querySelector('[data-label="AI grid status"]');

/** Opens a member's actions menu and picks an item, or clicks Add for a cluster outside AI grid. */
const pick = async (user: User, cluster: string, item: string) => {
  if (item === 'Add to AI grid') {
    await user.click(await screen.findByRole('button', { name: `Add ${cluster} to AI grid` }));
    return;
  }
  await user.click(await screen.findByRole('button', { name: `Actions for ${cluster}` }));
  await user.click(screen.getByRole('menuitem', { name: item }));
};

/** Adds a cluster from its add button as an inference cluster, keeping its location, and confirms. */
const add = async (user: User, cluster: string) => {
  await pick(user, cluster, 'Add to AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  return modal;
};

it('lists live Hub states, includes AI grid navigation and enrolls with a label-only PATCH', async () => {
  const user = userEvent.setup();
  const service = serviceWith(hubClusters());
  renderAt('/clusters', service);
  const table = await screen.findByTestId('clusters-table');
  const nav = screen.getByRole('navigation', { name: 'Console sections' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['AI grid', 'Monitoring', 'Clusters', 'Organizations', 'Models', 'Subscriptions']);
  // Every name links to the cluster's details page; a member shows its provisioning, one status line each.
  const member = within(table).getByRole('link', { name: 'cluster-a' }).closest('tr')!;
  expect(within(table).getByRole('link', { name: 'cluster-a' })).toHaveAttribute('href', '/clusters/cluster-a');
  expect(within(member).getByText('Provisioned')).toBeInTheDocument();
  const offline = within(table).getByRole('link', { name: 'cluster-c' }).closest('tr')!;
  expect(within(table).getByRole('link', { name: 'cluster-c' })).toHaveAttribute('href', '/clusters/cluster-c');
  expect(offline).toHaveTextContent('Unavailable');
  expect(within(offline).getAllByText('—').length).toBeGreaterThan(0);
  await add(user, 'cluster-b');
  expect(await screen.findByText('Cluster cluster-b added to AI grid')).toBeVisible();
  expect(screen.queryByTestId('cluster-membership-modal')).not.toBeInTheDocument();
  const enrolled = service.clusters.find((c) => c.name === 'cluster-b')!;
  expect(enrolled.labels).toEqual({ location: 'site2', 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference' });
  expect(enrolled.location).toBe('site2');
  await user.click(screen.getByRole('textbox', { name: 'Filter clusters' }));
  await user.paste('cluster-c');
  expect(within(screen.getByTestId('clusters-table')).queryByText('cluster-a')).not.toBeInTheDocument();
  expect(addButton('cluster-c')).not.toHaveAttribute('aria-disabled', 'true');
});

it('removes a member from AI grid after a confirmation', async () => {
  const user = userEvent.setup();
  const service = serviceWith(hubClusters());
  renderAt('/clusters', service);
  await pick(user, 'cluster-a', 'Remove from AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  expect(modal).toHaveTextContent('Remove cluster-a from AI grid?');
  // A remote cluster also leaves the cross-cluster network.
  expect(modal).toHaveTextContent('The cluster is also disconnected from the other AI grid clusters.');
  expect(modal).toHaveTextContent(
    'OpenShift AI and the models running on it are not uninstalled, but the AI grid no longer manages them. Move its models to other clusters first.',
  );
  // Destructive, so it asks for the cluster's name typed in, as every delete does.
  expect(within(modal).getByRole('button', { name: 'Remove' })).toBeDisabled();
  await user.type(within(modal).getByRole('textbox', { name: 'Type cluster-a to confirm:' }), 'cluster-a');
  await user.click(within(modal).getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('Cluster cluster-a removed from AI grid')).toBeVisible();
  const removed = service.clusters.find((c) => c.name === 'cluster-a')!;
  expect(removed.labels).toEqual({ 'ai-grid/provisioned': 'true', location: 'site1' });
  const row = within(screen.getByTestId('clusters-table')).getByRole('link', { name: 'cluster-a' }).closest('tr')!;
  expect(aiGridStatus(row)).toHaveTextContent('—');
  expect(row).not.toHaveTextContent('Not added');
});

it('does not say the hub is disconnected when removing local-cluster', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceWith([cluster('local-cluster', 'Ready', { 'ai-grid/enabled': 'true', location: 'hub' })]),
  );
  await pick(user, 'local-cluster', 'Remove from AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  // The network Placement always selects local-cluster.
  expect(modal).not.toHaveTextContent('disconnected');
  expect(modal).toHaveTextContent('The AI grid stops managing this cluster, and models are no longer deployed to it.');
  expect(modal).toHaveTextContent(
    'OpenShift AI and the models running on it are not uninstalled, but the AI grid no longer manages them. Move its models to other clusters first.',
  );
});

const REMOVE_WARNING_TITLE = 'Warning alert: Requests move to the other ingress clusters';
const REMOVE_WARNING_BODY =
  "This cluster receives requests from organizations' users. After it is removed, their requests go through the other ingress clusters, and their API keys keep working. The AI grid refuses the removal and shows the reason while this is the only ingress cluster, or while removing it would delete a subscription's copy and revoke its API keys.";
const REMOVE_WARNING_DETAIL =
  "If this cluster keeps copies of subscriptions after removal, don't delete them, uninstall MaaS, or delete their namespace on this cluster. MaaS would revoke their API keys on every cluster.";

it.each<[string, string | undefined, boolean]>([
  ['an Ingress', 'ingress', true],
  ['an Ingress and inference', 'combined', true],
  ['an Inference', 'inference', false],
  ['a no-role', undefined, false],
])('says what happens to users when removing %s cluster only where it receives requests', async (_, role, warns) => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceWith([
      cluster('site-a', 'Ready', {
        'ai-grid/enabled': 'true',
        location: 'eu',
        ...(role ? { 'ai-grid/role': role } : {}),
      }),
    ]),
  );
  await pick(user, 'site-a', 'Remove from AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  if (warns) {
    expect(within(modal).getByRole('heading', { name: REMOVE_WARNING_TITLE })).toBeVisible();
    expect(within(modal).getByText(REMOVE_WARNING_BODY)).toBeVisible();
    expect(within(modal).getByText(REMOVE_WARNING_DETAIL)).toBeVisible();
  } else {
    expect(within(modal).queryByRole('heading', { name: REMOVE_WARNING_TITLE })).not.toBeInTheDocument();
    expect(modal).not.toHaveTextContent('API keys');
  }
});

it('shows the backend refusing to remove an ingress cluster while subscriptions exist, with the form kept', async () => {
  const user = userEvent.setup();
  const service = serviceWith([
    cluster('site-a', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'ingress', location: 'eu' }),
  ]);
  const message =
    'Cluster "site-a" serves ingress, and 3 subscriptions exist (sub-a, sub-b, sub-c). When a cluster stops serving ingress, the API keys of every subscription are revoked on all clusters. Delete the subscriptions first, or keep the cluster in AI grid.';
  // 412 is FailedPrecondition over Connect (connectClusters.ts).
  vi.spyOn(service, 'removeClusterFromGrid').mockRejectedValueOnce(new ServiceError(412, message));
  renderAt('/clusters', service);
  await pick(user, 'site-a', 'Remove from AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  const reload = vi.spyOn(service, 'getCluster');
  const typed = within(modal).getByRole('textbox', { name: 'Type site-a to confirm:' });
  await user.click(typed);
  await user.paste('site-a');
  await user.click(within(modal).getByRole('button', { name: 'Remove' }));
  expect(await within(modal).findByText(message)).toBeVisible();
  // The warning and the typed name stay, so Remove can be sent again once the subscriptions are gone.
  expect(within(modal).getByRole('heading', { name: REMOVE_WARNING_TITLE })).toBeVisible();
  expect(within(modal).getByText(REMOVE_WARNING_BODY)).toBeVisible();
  expect(typed).toHaveValue('site-a');
  expect(within(modal).getByRole('button', { name: 'Remove' })).toBeEnabled();
  expect(modal).not.toHaveTextContent('This cluster was changed after this dialog opened');
  // A refusal isn't a stale version: nothing is loaded again into the dialog.
  expect(reload).not.toHaveBeenCalled();
  expect(service.clusters[0].aiGridEnabled).toBe(true);
});

it.each([
  ['Add to AI grid', 'cluster-b', 'enrollCluster', 403, 'the hub refused the change'],
  ['Add to AI grid', 'cluster-b', 'enrollCluster', 409, 'This cluster was changed after this dialog opened'],
  ['Remove from AI grid', 'cluster-a', 'removeClusterFromGrid', 412, 'models are placed on cluster-a'],
  ['Edit', 'cluster-a', 'updateCluster', 422, 'label "location" is not a valid label value'],
] as const)(
  'keeps a refused %s of %s in the dialog (%s, %i), with no notification and nothing followed',
  async (action, name, write, status, shown) => {
    const user = userEvent.setup();
    const service = serviceWith(hubClusters());
    vi.spyOn(service, write).mockRejectedValueOnce(new ServiceError(status, shown));
    renderAt('/clusters', service);
    if (action !== 'Add to AI grid') await pick(user, name, action);
    if (action === 'Edit') {
      // cluster-a has no role: Edit sets one, which the hub would install, and a new location label.
      const modal = await screen.findByTestId('cluster-edit-modal');
      await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
      await user.click(await screen.findByRole('option', { name: /Inference/ }));
      const location = within(modal).getByRole('textbox', { name: 'Location label' });
      await user.clear(location);
      await user.paste('site9');
      await user.click(within(modal).getByRole('button', { name: 'Save' }));
      expect(service.updateCluster).toHaveBeenCalled();
      expect(await within(modal).findByText(new RegExp(shown))).toBeVisible();
    } else if (action === 'Remove from AI grid') {
      const modal = await screen.findByTestId('cluster-membership-modal');
      await user.click(within(modal).getByRole('textbox', { name: `Type ${name} to confirm:` }));
      await user.paste(name);
      await user.click(within(modal).getByRole('button', { name: 'Remove' }));
      expect(await within(modal).findByText(new RegExp(shown))).toBeVisible();
    } else {
      const modal = await add(user, name);
      expect(await within(modal).findByText(new RegExp(shown))).toBeVisible();
    }
    // Nothing reached the notification center, and nothing is followed.
    expect(screen.queryByText(new RegExp(`^(Cluster ${name}|Changes to cluster ${name})`))).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(notificationsKey('dev-user'))).toBeNull();
    expect(window.sessionStorage.getItem(watchesKey('dev-user'))).toBeNull();
  },
);

/** The cluster watches the notification center keeps in the tab. */
const clusterWatches = () =>
  (JSON.parse(window.sessionStorage.getItem(watchesKey('dev-user')) ?? '[]') as { subject: string }[]).filter(
    (r) => r.subject === 'cluster',
  );

it('follows an added cluster until it is provisioned, and not an edit of the location label alone', async () => {
  const user = userEvent.setup();
  const service = serviceWith([
    ...hubClusters(),
    cluster('cluster-d', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference', location: 'eu' }),
  ]);
  renderAt('/clusters', service);

  await pick(user, 'cluster-d', 'Edit');
  const edit = await screen.findByTestId('cluster-edit-modal');
  const location = within(edit).getByRole('textbox', { name: 'Location label' });
  await user.clear(location);
  await user.paste('eu-west');
  await user.click(within(edit).getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Changes to cluster cluster-d saved')).toBeVisible();
  expect(clusterWatches()).toEqual([]);

  await add(user, 'cluster-b');
  expect(await screen.findByText('Cluster cluster-b added to AI grid')).toBeVisible();
  expect(
    screen.getByText("The hub is installing what its Inference role needs. You'll be notified when it's provisioned."),
  ).toBeVisible();
  expect(clusterWatches()).toMatchObject([{ op: 'add', id: 'cluster-b', role: 'inference', stage: 'ready' }]);
});

it('asks for a location label and role before adding', async () => {
  const user = userEvent.setup();
  const service = serviceWith([
    cluster('no-location-member', 'Ready', { 'ai-grid/enabled': 'true' }),
    { ...cluster('no-location', 'Ready'), latitude: 37.7749, longitude: -122.4194 },
    cluster('local-cluster', 'Ready'),
  ]);
  renderAt('/clusters', service);
  // A member without a location label gets no warning: nothing places models by it.
  const memberRow = await screen.findByRole('row', { name: /^no-location-member / });
  expect(memberRow).not.toHaveTextContent('No location');
  expect(screen.queryByTestId('missing-location-no-location-member')).not.toBeInTheDocument();
  await pick(user, 'no-location', 'Add to AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  // A form, titled as one, that names the cluster in its description and says a role stays.
  expect(screen.getByRole('dialog', { name: 'Add cluster to AI grid' })).toBe(modal);
  expect(within(modal).getByText('no-location', { selector: 'strong' })).toBeVisible();
  expect(modal).toHaveTextContent(`Configure the no-location cluster for the AI grid. ${AI_GRID_SUMMARY}`);
  // The role stays, said in a plain inline alert directly under the Role field's helper text.
  const roleFixed = within(modal).getByText(
    "A cluster's role cannot be changed once it has been added to the AI grid.",
  );
  expect(roleFixed).toBeVisible();
  expect(roleFixed.closest('.pf-v6-c-alert')).toHaveClass('pf-m-inline', 'pf-m-plain');
  const roleGroup = within(modal).getByRole('combobox', { name: 'Role' }).closest('.pf-v6-c-form__group')!;
  const alert = roleFixed.closest('.pf-v6-c-alert');
  expect(alert?.parentElement).toHaveClass('pf-v6-c-form__helper-text');
  expect(alert).toBeInstanceOf(HTMLElement);
  expect(roleGroup.querySelector('.pf-v6-c-form__helper-text + .pf-v6-c-form__helper-text')).toContainElement(
    alert instanceof HTMLElement ? alert : null,
  );
  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  // Nothing is written until both are given; each field says why and describes its error.
  const location = within(modal).getByRole('textbox', { name: 'Location label' });
  const role = within(modal).getByRole('combobox', { name: 'Role' });
  // Location, then role, as Edit asks for them.
  expect(location.compareDocumentPosition(role) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(location).toBeRequired();
  expect(location).toHaveAttribute('aria-invalid', 'true');
  expect(role).toHaveAttribute('aria-invalid', 'true');
  expect(location).toHaveAccessibleDescription(/^Required : error status;/);
  expect(within(modal).queryByText('For example, us-east.')).not.toBeInTheDocument();
  // The position is in the field's help, not under the input.
  expect(within(modal).queryByText('37.7749, -122.4194')).not.toBeInTheDocument();
  // The role keeps its helper, and the error follows it.
  expect(role).toHaveAccessibleDescription(
    /^Select the role this cluster will perform in the AI grid\. .* Required : error status;$/,
  );
  await user.click(location);
  await user.paste('us east');
  expect(location).toHaveAccessibleDescription(/Must start and end with a letter or number/);
  expect(service.clusters[1].labels).toEqual({});
  // What the label is, and this cluster's position, site and cloud region, is in the field's help.
  // An empty site or cloud region still has a row.
  await user.click(within(modal).getByRole('button', { name: 'More info for the location label field' }));
  const help = await screen.findByRole('dialog', { name: 'Location label' });
  expect(help).toHaveTextContent(
    "Provide a text label that can help identify the cluster's location on the AI grid map. This label does not impact the cluster's location on the map.",
  );
  expect(help).toHaveTextContent(
    "Use the cluster's position, site, and cloud region to inform the label. For example, a cluster with the position 43.65, -79.38 might have the location label Toronto.",
  );
  expect(within(help).getByText('Toronto').tagName).toBe('STRONG');
  expect(within(help).getByRole('heading', { name: 'Cluster details' })).toBeVisible();
  expect(within(help).queryByRole('heading', { name: 'Location label' })).not.toBeInTheDocument();
  expect(
    within(help)
      .getAllByRole('term')
      .map((term) => term.textContent),
  ).toEqual(['Map position', 'Site', 'Cloud region']);
  expect(within(help).getByText('37.7749, -122.4194')).toBeVisible();
  expect(within(help).queryByText('Missing coordinates')).not.toBeInTheDocument();
  expect(within(help).getAllByText(EMPTY_VALUE)).toHaveLength(2);
  await user.click(within(help).getByRole('button', { name: 'Copy map position' }));
  expect(await navigator.clipboard.readText()).toBe('37.7749, -122.4194');
  await user.click(within(modal).getByRole('button', { name: 'More info for the location label field' }));
  // The Role field's help explains each role.
  await user.click(within(modal).getByRole('button', { name: 'More info for the role field' }));
  const roles = await screen.findByRole('dialog', { name: 'Cluster roles' });
  // No heading: what roles are, each role with its name in bold, then that a role is set once.
  expect(within(roles).queryByRole('heading')).not.toBeInTheDocument();
  expect(within(roles).getByText('Roles define what each cluster does in the AI grid.')).toBeVisible();
  expect(
    within(roles)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual([
    'Ingress clusters receive requests via Models-as-a-Service and route those requests to inference clusters.',
    'Inference clusters serve models via KServe and receive requests through an ingress cluster.',
    'Ingress and inference clusters receive requests via Models-as-a-Service and serve models via KServe.',
  ]);
  expect(Array.from(roles.querySelectorAll('li > strong')).map((name) => name.textContent)).toEqual([
    'Ingress',
    'Inference',
    'Ingress and inference',
  ]);
  expect(
    within(roles).getByText('Roles are assigned when adding a cluster to the AI grid, and cannot be changed once set.'),
  ).toBeVisible();
  await user.click(within(modal).getByRole('button', { name: 'Cancel' }));
  // The hub itself defaults to the combined role.
  await pick(user, 'local-cluster', 'Add to AI grid');
  const hub = await screen.findByTestId('cluster-membership-modal');
  expect(within(hub).getByRole('combobox', { name: 'Role' })).toHaveValue('Ingress and inference');
  // No position, site, or cloud region.
  await user.click(within(hub).getByRole('button', { name: 'More info for the location label field' }));
  const hubHelp = await screen.findByRole('dialog', { name: 'Location label' });
  expect(hubHelp).toHaveTextContent('No map position, site, or cloud region is available to inform the label.');
  expect(within(hubHelp).queryByRole('term')).not.toBeInTheDocument();
  expect(within(hubHelp).queryByText('Missing coordinates')).not.toBeInTheDocument();
  const how = within(hubHelp).getByRole('link', { name: "How to set a cluster's position" });
  expect(how.closest('p')).toHaveTextContent(
    'No map position, site, or cloud region is available to inform the label.',
  );
  expect(how.querySelector('svg')).toBeInTheDocument();
  expect(how).toHaveAttribute('href', LOCATION_DOCS_URL);
  expect(within(hubHelp).queryByRole('button', { name: 'Copy map position' })).not.toBeInTheDocument();
});

it('keeps an unenrolled cluster on patch failure and allows a retry', async () => {
  const service = serviceWith(hubClusters());
  const enroll = service.enrollCluster;
  service.enrollCluster = async () => {
    throw new ServiceError(403, 'The backend does not have permission to list or patch ACM ManagedClusters.');
  };
  const user = userEvent.setup();
  renderAt('/clusters', service);
  const modal = await add(user, 'cluster-b');
  // The error stays in the dialog, which stays open for a retry.
  expect(
    await within(modal).findByText('The backend does not have permission to list or patch ACM ManagedClusters.'),
  ).toBeVisible();
  expect(service.clusters[1].labels['ai-grid/enabled']).toBeUndefined();
  service.enrollCluster = enroll;
  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('Cluster cluster-b added to AI grid')).toBeVisible();
});

it('reports Hub unavailability and retries instead of showing a false empty list', async () => {
  const service = serviceWith(hubClusters());
  const list = service.listClusters;
  service.listClusters = async () => {
    throw new ServiceError(503, 'The AI grid backend is unavailable. Try again.');
  };
  const user = userEvent.setup();
  renderAt('/clusters', service);
  expect(await screen.findByRole('heading', { name: 'Unable to load clusters' })).toBeVisible();
  expect(screen.getByText('The AI grid backend is unavailable. Try again.')).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'No clusters' })).not.toBeInTheDocument();
  service.listClusters = list;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('clusters-table')).toHaveTextContent('cluster-a');
});

it('refresh reflects external membership changes on the Hub', async () => {
  const service = serviceWith(hubClusters());
  const user = userEvent.setup();
  renderAt('/clusters', service);
  await add(user, 'cluster-b');
  expect(await screen.findByText('Cluster cluster-b added to AI grid')).toBeVisible();
  const row = () => within(screen.getByTestId('clusters-table')).getByRole('row', { name: /^cluster-b / });
  await waitFor(() => expect(row()).toHaveTextContent('Provisioning'));
  service.clusters[1] = cluster('cluster-b', 'Ready', { location: 'site2' });
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(aiGridStatus(row())).toHaveTextContent('—'));
  expect(row()).not.toHaveTextContent('Not added');
});

it('shows the role a removed cluster kept read-only when it is added again, and sends it', async () => {
  const user = userEvent.setup();
  const service = serviceWith([cluster('former', 'Ready', { 'ai-grid/role': 'ingress', location: 'paris' })]);
  const enroll = vi.spyOn(service, 'enrollCluster');
  renderAt('/clusters', service);
  await pick(user, 'former', 'Add to AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  // Remove kept its role, which Add shows as Edit does: read-only, with why under it.
  const role = within(modal).getByRole('textbox', { name: 'Role' });
  expect(role).toHaveValue('Ingress');
  expect(role).toHaveAttribute('readonly');
  expect(role).toHaveAccessibleDescription("A cluster's role cannot be changed once it has been added to the AI grid.");
  expect(within(modal).queryByRole('combobox', { name: 'Role' })).not.toBeInTheDocument();
  expect(within(modal).getByRole('button', { name: 'More info for the role field' })).toBeVisible();
  // The sentence is said once, under the role, not again as the alert a role still to select gets.
  expect(
    within(modal).getAllByText("A cluster's role cannot be changed once it has been added to the AI grid."),
  ).toHaveLength(1);
  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('Cluster former added to AI grid')).toBeVisible();
  expect(enroll.mock.calls[0][1]).toEqual({ location: 'paris', role: 'ingress' });
});

it('shows the role and location Add wrote while the list reloads', async () => {
  const service = serviceWith([cluster('cluster-b', 'Ready')]);
  const list = service.listClusters;
  const user = userEvent.setup();
  renderAt('/clusters', service);
  await pick(user, 'cluster-b', 'Add to AI grid');
  // The reload after Add hasn't answered yet, so the table still holds the list from before. It
  // reads the list twice (Clusters/List and /api/v1), so every call waits for answer().
  const waiting: (() => void)[] = [];
  const answer = () => waiting.splice(0).forEach((go) => go());
  service.listClusters = () => new Promise((resolve) => waiting.push(() => resolve(list())));
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('textbox', { name: 'Location label' }));
  await user.paste('paris');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('Cluster cluster-b added to AI grid')).toBeVisible();
  const row = within(screen.getByTestId('clusters-table')).getByRole('row', { name: /^cluster-b / });
  expect(row).toHaveTextContent('Inference');
  expect(row).toHaveTextContent('paris');
  expect(screen.queryByTestId('missing-role-cluster-b')).not.toBeInTheDocument();
  // The reloaded list replaces it: here someone changed the role in the meantime.
  service.clusters[0] = {
    ...service.clusters[0],
    labels: { ...service.clusters[0].labels, 'ai-grid/role': 'ingress' },
  };
  answer();
  await waitFor(() =>
    expect(within(screen.getByTestId('clusters-table')).getByRole('row', { name: /^cluster-b / })).toHaveTextContent(
      'Ingress',
    ),
  );
});

it('keeps the cluster Add returned when a poll replaced the list during the PATCH', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const service = serviceWith([cluster('cluster-b', 'Ready', { location: 'site2' })]);
    const enroll = service.enrollCluster;
    let finish: () => Promise<void> = async () => {};
    service.enrollCluster = (c, m) => new Promise((resolve) => (finish = async () => resolve(await enroll(c, m))));
    const list = service.listClusters;
    let polls = 0;
    service.listClusters = () => {
      polls++;
      return list();
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt('/clusters', service);
    await add(user, 'cluster-b');
    // A poll answers with the list from before the change; then the reload after Add hangs. Each
    // load reads the list once, over Connect (Clusters/List).
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(polls).toBe(2);
    service.listClusters = () => new Promise(() => {});
    await act(() => finish());
    expect(await screen.findByText('Cluster cluster-b added to AI grid')).toBeVisible();
    const row = () => within(screen.getByTestId('clusters-table')).getByRole('row', { name: /^cluster-b / });
    expect(row()).toHaveTextContent('Inference');
    // Refresh while that reload hangs keeps it, and an older reload that answers first (with the
    // list from before Add) doesn't drop it either.
    const before = [cluster('cluster-b', 'Ready', { location: 'site2' })];
    const olderCalls: (() => void)[] = [];
    service.listClusters = () => new Promise((resolve) => olderCalls.push(() => resolve(before)));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const latestCalls: (() => void)[] = [];
    service.listClusters = () => new Promise((resolve) => latestCalls.push(() => resolve(list())));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => olderCalls.forEach((go) => go()));
    expect(row()).toHaveTextContent('Inference');
    // The latest reload's answer replaces it: someone changed the role in the meantime.
    service.clusters[0] = {
      ...service.clusters[0],
      labels: { ...service.clusters[0].labels, 'ai-grid/role': 'ingress' },
    };
    await act(async () => latestCalls.forEach((go) => go()));
    await waitFor(() => expect(row()).toHaveTextContent('Ingress'));
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a response that does not confirm membership', async () => {
  const service = serviceWith(hubClusters());
  service.enrollCluster = async (c) => cluster(c.name, 'Ready');
  const user = userEvent.setup();
  renderAt('/clusters', service);
  const modal = await add(user, 'cluster-b');
  expect(await within(modal).findByText('Unable to add cluster to AI grid')).toBeVisible();
  expect(within(modal).getByText('The hub did not confirm the change. Refresh the page and try again.')).toBeVisible();
});

it('says when the hub has no clusters', async () => {
  renderAt('/clusters', serviceWith([]));
  expect(await screen.findByRole('heading', { name: 'No clusters' })).toBeVisible();
  expect(screen.getByText(/first import them using Red Hat Advanced Cluster Management for Kubernetes/)).toBeVisible();
});

it('keeps the list under a warning when a reload fails, and clears it on the next', async () => {
  const service = serviceWith(hubClusters());
  const user = userEvent.setup();
  renderAt('/clusters', service);
  expect(await screen.findByRole('link', { name: 'cluster-a' })).toBeVisible();
  const failed = vi.spyOn(service, 'listClusters').mockRejectedValue(new ServiceError(503, 'Hub unavailable.'));
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  const alert = await screen.findByTestId('stale-data-alert');
  expect(alert).toHaveTextContent('Showing the last loaded clusters');
  // The fake Connect transport answers a 503 with its own Unavailable message.
  expect(alert).toHaveTextContent('The AI grid backend is unavailable. Try again.');
  expect(screen.getByRole('link', { name: 'cluster-a' })).toBeVisible();
  failed.mockRestore();
  await user.click(within(alert).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByTestId('stale-data-alert')).not.toBeInTheDocument());
});

it('shows the seeded clusters with region, location label, status and provisioning', async () => {
  renderAt('/clusters', new MockConsoleService());
  const table = await screen.findByTestId('clusters-table');
  const sydney = within(table).getByRole('row', { name: /^site4 / });
  // site4 is both the name and the location.
  expect(within(sydney).getAllByText('site4')).toHaveLength(2);
  expect(sydney).toHaveTextContent('Ready');
  // Its region shows in the Region column; its ai-grid/site label isn't shown.
  expect(within(sydney).getByRole('cell', { name: 'asia-pacific' })).toBeVisible();
  expect(sydney).not.toHaveTextContent('sydney');
  // Not a member: a dash in AI Grid status, with no provisioning and no role.
  expect(sydney).not.toHaveTextContent('provisioned');
  expect(aiGridStatus(sydney)).toHaveTextContent('—');
  expect(sydney).not.toHaveTextContent('Not added');
  expect(sydney).not.toHaveTextContent('Ingress and inference');
  expect(within(table).getAllByText('Provisioned')).toHaveLength(3);
  expect(within(table).getAllByText('Ingress and inference')).toHaveLength(3);
});

it('shows the role of each member, and warns about a member without one', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceWith([
      cluster('edge-1', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'ingress', location: 'paris' }),
      cluster('gpu-1', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference', location: 'paris' }),
      cluster('no-role', 'Ready', { 'ai-grid/enabled': 'true', location: 'paris' }),
      // A value the console doesn't know counts as no role: the hub's Placements select on the three.
      cluster('odd-role', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'gateway', location: 'paris' }),
      // A role left behind after Remove isn't shown: the cluster isn't a member.
      cluster('former', 'Ready', { 'ai-grid/role': 'combined', location: 'paris' }),
    ]),
  );
  const table = await screen.findByTestId('clusters-table');
  expect(within(table).getByRole('row', { name: /^edge-1 / })).toHaveTextContent('Ingress');
  expect(within(table).getByRole('row', { name: /^gpu-1 / })).toHaveTextContent('Inference');
  const former = within(table).getByRole('row', { name: /^former / });
  expect(aiGridStatus(former)).toHaveTextContent('—');
  expect(former).not.toHaveTextContent('Not added');
  expect(former).not.toHaveTextContent('Ingress and inference');
  const missing = screen.getByTestId('missing-role-no-role');
  expect(missing).toHaveTextContent('No role');
  await user.hover(missing);
  // It points to the edit, not to removing the cluster and adding it again.
  expect(
    await screen.findByText(
      "This cluster has no role, so the hub cannot install OpenShift AI or MaaS on it, and provisioning cannot finish. To set a role, select Edit in the cluster's actions.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByTestId('missing-role-odd-role')).toHaveTextContent('No role');
  // The header explains the three roles, without sorting the table.
  const names = () =>
    within(table)
      .getAllByRole('row')
      .slice(2)
      .map((r) => r.querySelector('td')?.textContent);
  const before = names();
  await user.click(within(table).getByRole('button', { name: 'About cluster roles' }));
  const roles = await screen.findByRole('dialog', { name: 'Cluster roles' });
  expect(within(roles).queryByRole('heading')).not.toBeInTheDocument();
  expect(roles).toHaveTextContent(
    'Inference clusters serve models via KServe and receive requests through an ingress cluster.',
  );
  expect(names()).toEqual(before);
});

it('sorts by role: clusters outside AI grid, then members without a role, then by role', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceWith([
      cluster('c-inference', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference', location: 'x' }),
      cluster('b-outside', 'Ready'),
      cluster('d-combined', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'combined', location: 'x' }),
      cluster('a-no-role', 'Ready', { 'ai-grid/enabled': 'true', location: 'x' }),
      cluster('e-ingress', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/role': 'ingress', location: 'x' }),
    ]),
  );
  const table = await screen.findByTestId('clusters-table');
  const names = () =>
    within(table)
      .getAllByRole('row')
      .slice(2)
      .map((r) => r.querySelector('td')?.textContent);
  const sortButton = within(within(table).getByRole('columnheader', { name: /^Role/ })).getByRole('button', {
    name: 'Role',
  });
  await user.click(sortButton);
  expect(names()).toEqual(['b-outside', 'a-no-role', 'c-inference', 'e-ingress', 'd-combined']);
  await user.click(sortButton);
  expect(names()).toEqual(['d-combined', 'e-ingress', 'c-inference', 'a-no-role', 'b-outside']);
});

/** A user the console couldn't load: the pages show, but without write actions. A viewer
 * (isProviderAdmin false) sees no pages at all (App.test.tsx). */
const unknownUser = () => {
  const service = new MockConsoleService();
  service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
  return service;
};

it('hides write actions until it knows the user is a provider admin', async () => {
  const service = unknownUser();
  renderAt('/clusters', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('Unable to load user'));
  // site4 is both the name and the location, so find its row rather than the text.
  expect(await screen.findByRole('row', { name: /^site4 / })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Actions for / })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Add .+ to AI grid$/ })).not.toBeInTheDocument();
  const table = screen.getByTestId('clusters-table');
  const [groupRow, columnRow] = within(table).getAllByRole('row').slice(0, 2);
  expect(within(groupRow).getByRole('columnheader', { name: 'AI grid' })).toHaveAttribute('colspan', '3');
  expect(within(columnRow).queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
});

it('shows the not-available state on a backend without the RPC', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  service.enrollCluster = async () => {
    throw new ServiceError(501, 'The AI grid backend does not support this operation.');
  };
  renderAt('/clusters', service);
  const modal = await add(user, 'site4');
  expect(await within(modal).findByText('Unable to add cluster to AI grid')).toBeInTheDocument();
  expect(
    within(modal).getByText('Adding clusters to the AI grid is not available on this AI grid backend.'),
  ).toBeInTheDocument();
});

it('shows one pagination, in the toolbar, for a single page', async () => {
  renderAt('/clusters', new MockConsoleService());
  expect(await screen.findByTestId('clusters-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(1);
});

// Clusters/List answering these ManagedClusters, as the backend sends them.
const transportWith = (...items: Parameters<typeof create<typeof ManagedClusterSchema>>[1][]) =>
  fakeClients({
    clusters: {
      list: async () => ({
        items: items.map((init) => create(ManagedClusterSchema, init)),
        size: items.length,
        total: items.length,
      }),
    },
  }).transport;

it('shows Unknown for a cluster without a status', async () => {
  // The hub has reported no condition yet: the backend's state is UNSPECIFIED.
  renderAt('/clusters', new MockConsoleService(), transportWith({ id: 'bare', metadata: { name: 'bare' } }));
  const row = await screen.findByRole('row', { name: /^bare / });
  expect(within(row).getByText('Unknown')).toBeInTheDocument();
  expect(row).not.toHaveTextContent('provisioned');
});

it('shows the ACM state for an importing cluster', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    new MockConsoleService(),
    transportWith({
      id: 'site-berlin-1',
      metadata: { name: 'site-berlin-1' },
      status: {
        state: ManagedClusterState.IMPORTING,
        stateMessage: 'Import of the managed cluster is in progress',
      },
    }),
  );
  const row = await screen.findByRole('row', { name: /^site-berlin-1 / });
  // One status line; the state and the message are in its popover.
  expect(within(row).getByText('Unknown')).toBeInTheDocument();
  expect(within(row).queryByText('Importing')).not.toBeInTheDocument();
  await user.click(within(row).getByRole('button', { name: 'Unknown for site-berlin-1' }));
  const status = await screen.findByRole('dialog', { name: 'site-berlin-1 Unknown' });
  expect(within(status).getByText('Importing: Import of the managed cluster is in progress')).toBeVisible();
});

it('offers Edit, then Remove from AI grid, for a member, and an add button for another cluster', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await user.click(await screen.findByRole('button', { name: 'Actions for site1' }));
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Edit', 'Remove from AI grid']);
  // Remove is destructive: last, after a divider.
  expect(within(screen.getByRole('menu')).getByRole('separator')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  // site4 is outside AI grid: an add icon, with the menu's Add label as its tooltip.
  const add = addButton('site4');
  expect(screen.queryByRole('button', { name: 'Actions for site4' })).not.toBeInTheDocument();
  await user.hover(add);
  // jsdom gives the icon button no box, so Popper keeps the tooltip at opacity 0; the text is still there.
  expect(await screen.findByRole('tooltip', { name: 'Add to AI grid' })).toHaveTextContent('Add to AI grid');
});

it('offers Add to AI grid for ready, unavailable, and unknown clusters', async () => {
  const withState = (name: string, state: NonNullable<GridCluster['state']>): GridCluster => ({
    ...cluster(name, 'Unknown'),
    state,
  });
  renderAt(
    '/clusters',
    serviceWith([
      cluster('is-ready', 'Ready'),
      cluster('is-offline', 'Unavailable'),
      cluster('is-unknown', 'Unknown'),
      withState('is-detaching', 'Detaching'),
      withState('is-importfailed', 'Import failed'),
      withState('is-notaccepted', 'Not accepted'),
      withState('is-pendingimport', 'Pending import'),
      withState('is-importing', 'Importing'),
      withState('is-unset', 'Pending import'),
    ]),
  );
  await screen.findByTestId('clusters-table');
  const user = userEvent.setup();
  for (const name of ['is-ready', 'is-offline', 'is-unknown']) {
    expect(addButton(name)).not.toHaveAttribute('aria-disabled', 'true');
  }
  // The others say why they can't be added yet.
  for (const name of ['is-detaching', 'is-importfailed', 'is-pendingimport', 'is-importing', 'is-unset']) {
    const item = addButton(name);
    expect(item).toHaveAttribute('aria-disabled', 'true');
    await user.hover(item);
    expect(await screen.findByRole('tooltip', { name: /after the hub imports it/ })).toHaveTextContent(
      /after the hub imports it/,
    );
    await user.unhover(item);
  }
  const notAccepted = addButton('is-notaccepted');
  expect(notAccepted).toHaveAttribute('aria-disabled', 'true');
  await user.hover(notAccepted);
  expect(
    await screen.findByRole('tooltip', {
      name: 'The hub has not accepted this cluster. To add it to the AI grid, first accept it in ACM.',
    }),
  ).toHaveTextContent('The hub has not accepted this cluster. To add it to the AI grid, first accept it in ACM.');
});

it("lists each cluster's GPU configuration and capacity, as provider admins asked", async () => {
  const user = userEvent.setup();
  const clusters = seedClusters();
  // Two configurations on one cluster: the list shows the first and the rest behind "+1 more".
  const site1 = clusters[0].gpus!;
  clusters[0].gpus = {
    ...site1,
    total: site1.total + 4,
    nodeCount: site1.nodeCount + 1,
    configurations: [
      ...site1.configurations,
      { ...site1.configurations[0], product: 'NVIDIA-H100-80GB-HBM3', gpusPerNode: 4, nodeCount: 1 },
    ],
  };
  // The hub counts site4's GPUs, but Search has nothing for them: no model.
  clusters[3].capacity = { ...clusters[3].capacity, 'nvidia.com/gpu': '8' };
  clusters[3].gpuCapacity = 8;
  renderAt('/clusters', new MockConsoleService(undefined, clusters));
  await screen.findByRole('row', { name: /^site1 / });

  expect(screen.getByTestId('cluster-gpu-models-site1')).toHaveTextContent('NVIDIA H200, 8 GPUs/node');
  expect(screen.getByTestId('cluster-gpu-capacity-site1')).toHaveTextContent('3 nodes, 20 GPUs');
  await user.click(within(screen.getByTestId('cluster-gpu-models-site1')).getByText('+1 more'));
  expect(await screen.findByText('NVIDIA H100-80GB-HBM3, 4 GPUs/node')).toBeVisible();

  expect(screen.getByTestId('cluster-gpu-models-site2')).toHaveTextContent('NVIDIA L4, 1 GPU/node, Time-sliced ×4');
  expect(screen.getByTestId('cluster-gpu-capacity-site2')).toHaveTextContent('4 nodes, 4 GPUs');
  expect(screen.getByTestId('cluster-gpu-models-site3')).toHaveTextContent(
    'NVIDIA A100-SXM4-40GB, 8 GPUs/node, MIG 3g.20gb',
  );
  expect(screen.getByTestId('cluster-gpu-models-site4')).toHaveTextContent('—');
  expect(screen.getByTestId('cluster-gpu-capacity-site4')).toHaveTextContent('8 GPUs');
});

it('tells a cluster without GPUs from one whose capacity is not reported, as its details page does', async () => {
  const user = userEvent.setup();
  const clusters = seedClusters();
  // site3 without its GPU inventory and without a capacity: the hub reports nothing yet.
  clusters[2] = {
    ...clusters[2],
    gpus: undefined,
    capacity: undefined,
    allocatable: undefined,
    gpuCapacity: undefined,
  };
  renderAt('/clusters', new MockConsoleService(undefined, clusters));
  await screen.findByRole('row', { name: /^site1 / });
  expect(screen.getByTestId('cluster-gpu-capacity-site4')).toHaveTextContent(/^No GPUs$/);
  expect(screen.getByTestId('cluster-gpu-capacity-site3')).toHaveTextContent(/^Not reported$/);
  // Not reported sorts before none.
  await user.click(screen.getByRole('button', { name: 'Capacity' }));
  const names = screen
    .getAllByRole('row')
    .slice(2)
    .map((r) => r.textContent?.split(' ')[0]);
  expect(names[0]).toMatch(/^site3/);
  expect(names[1]).toMatch(/^site4/);
});

it('explains the AI grid column group in a popover, as it does the GPUs group', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await user.click(await screen.findByRole('button', { name: 'About AI grid' }));
  const help = await screen.findByRole('dialog', { name: 'AI grid' });
  // The body only, without a heading.
  expect(within(help).queryByRole('heading')).not.toBeInTheDocument();
  expect(within(help).getByText(AI_GRID_SUMMARY).tagName).toBe('P');
});

/** True when `earlier` precedes `later` in the document. */
const isBefore = (earlier: Element, later: Element) =>
  (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

it('groups the columns as the details page does, wraps them, and has Site and Region but no Hub column', async () => {
  // The test window is 1280px, above PatternFly's xl breakpoint (1200px).
  renderAt('/clusters', serviceWith(hubClusters()));
  const table = await screen.findByTestId('clusters-table');
  const [groups, columns] = within(table).getAllByRole('row').slice(0, 2);
  // Nested column headers (UX review): Cluster, AI grid and GPUs, as on the details page.
  // At xl and above, Actions is the last column of AI grid, so that group spans its three data columns plus Actions.
  expect(
    within(groups)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['Cluster', 'AI grid', 'GPUs']);
  expect(within(groups).getByRole('columnheader', { name: 'AI grid' })).toHaveAttribute('colspan', '4');
  const headers = within(columns).getAllByRole('columnheader');
  expect(headers.map((h) => h.textContent)).toEqual([
    'Name',
    'Cluster Status',
    'Site',
    'Region',
    'AI grid Status',
    'Location label',
    'Role',
    'Actions',
    'Capacity',
    'Configuration',
  ]);
  for (const header of headers) {
    if (header.textContent === 'Actions') continue;
    expect(header).toHaveClass('pf-m-wrap');
  }
  // The two Status columns read Status on screen, under their groups; their sort buttons say which.
  expect(within(columns).getByRole('button', { name: 'Cluster Status' })).toBeInTheDocument();
  expect(within(columns).getByRole('button', { name: 'AI grid Status' })).toBeInTheDocument();
  expect(within(columns).getAllByText('Status')).toHaveLength(2);
  expect(within(table).getByRole('columnheader', { name: /^Role/ })).not.toHaveClass('pf-m-hidden');
  // A cluster the hub hasn't accepted says so under Connection, so there is no Hub column.
  expect(within(table).queryByRole('columnheader', { name: 'Hub' })).not.toBeInTheDocument();
  // The OpenShift version is on the details page, leaving room for GPUs and Capacity.
  expect(within(table).queryByRole('columnheader', { name: 'OpenShift' })).not.toBeInTheDocument();
  // One Actions column, in the column row after Role, and not stuck to the right edge.
  expect(within(table).getAllByRole('columnheader', { name: 'Actions' })).toHaveLength(1);
  const actionsHeader = within(columns).getByRole('columnheader', { name: 'Actions' });
  expect(actionsHeader).not.toHaveClass('pf-v6-c-table__sticky-cell');
  expect(table.querySelectorAll('td.pf-v6-c-table__action')).toHaveLength(3);
  const member = within(table).getByRole('row', { name: /^cluster-a / });
  expect(
    isBefore(
      within(member).getByRole('button', { name: 'Actions for cluster-a' }),
      within(member).getByTestId('cluster-gpu-capacity-cluster-a'),
    ),
  ).toBe(true);
  const outsider = within(table).getByRole('row', { name: /^cluster-b / });
  expect(
    isBefore(
      within(outsider).getByRole('button', { name: 'Add cluster-b to AI grid' }),
      within(outsider).getByTestId('cluster-gpu-capacity-cluster-b'),
    ),
  ).toBe(true);
});

it('pins Actions to the right edge below the xl breakpoint, after the GPU columns', async () => {
  window.innerWidth = 1199;
  try {
    renderAt('/clusters', serviceWith(hubClusters()));
    const table = await screen.findByTestId('clusters-table');
    const [groups, columns] = within(table).getAllByRole('row').slice(0, 2);
    // AI grid spans only its own columns. Actions is the last header and sticks to the right.
    expect(within(groups).getByRole('columnheader', { name: 'AI grid' })).toHaveAttribute('colspan', '3');
    expect(
      within(groups)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Cluster', 'AI grid', 'GPUs', 'Actions']);
    expect(within(columns).queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader', { name: 'Actions' })).toHaveLength(1);
    const actionsHeader = within(groups).getByRole('columnheader', { name: 'Actions' });
    expect(actionsHeader).toHaveClass('pf-v6-c-table__sticky-cell');
    expect(actionsHeader).toHaveStyle({ '--pf-v6-c-table__sticky-cell--MinWidth': '3.5rem' });
    expect(table.querySelectorAll('td.pf-v6-c-table__action')).toHaveLength(3);
    const member = within(table).getByRole('row', { name: /^cluster-a / });
    const menu = within(member).getByRole('button', { name: 'Actions for cluster-a' });
    const memberCells = within(member).getAllByRole('cell');
    expect(memberCells[memberCells.length - 1]).toContainElement(menu);
    expect(menu.closest('td')).toHaveClass('pf-v6-c-table__sticky-cell');
    expect(menu.closest('td')).toHaveStyle({ '--pf-v6-c-table__sticky-cell--MinWidth': '3.5rem' });
    expect(isBefore(within(member).getByTestId('cluster-gpu-capacity-cluster-a'), menu)).toBe(true);
    const outsider = within(table).getByRole('row', { name: /^cluster-b / });
    const add = within(outsider).getByRole('button', { name: 'Add cluster-b to AI grid' });
    const outsiderCells = within(outsider).getAllByRole('cell');
    expect(outsiderCells[outsiderCells.length - 1]).toContainElement(add);
    expect(isBefore(within(outsider).getByTestId('cluster-gpu-capacity-cluster-b'), add)).toBe(true);
  } finally {
    window.innerWidth = 1280;
  }
});

it('says when the search matches no cluster, and clears it from the table', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  await user.click(screen.getByRole('textbox', { name: 'Filter clusters' }));
  await user.paste('no-such-cluster');
  expect(screen.getByRole('heading', { name: 'No results found' })).toBeVisible();
  expect(screen.getByText('Adjust your filters and try again.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
  expect(await screen.findByRole('row', { name: /^site1 / })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Filter clusters' })).toHaveValue('');
});

it('reloads the cluster in the open dialog after a conflict, keeping the choices, so the next Add works', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters', service);
  await pick(user, 'site4', 'Add to AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  const location = within(modal).getByRole('textbox', { name: 'Location label' });
  await user.clear(location);
  await user.paste('us-east');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  // Someone else changes the cluster while the dialog is open.
  const index = service.clusters.findIndex((c) => c.name === 'site4');
  const before = service.clusters[index];
  service.clusters[index] = {
    ...before,
    labels: { ...before.labels, team: 'blue' },
    resourceVersion: String(Number(before.resourceVersion) + 5),
  };
  const enroll = vi.spyOn(service, 'enrollCluster');

  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(
    await within(modal).findByText(
      'This cluster was changed after this dialog opened. The latest version is now shown. Review it and try again.',
    ),
  ).toBeVisible();
  expect(within(modal).queryByText(/resource version/)).not.toBeInTheDocument();
  expect(within(modal).getByRole('textbox', { name: 'Location label' })).toHaveValue('us-east');
  expect(within(modal).getByRole('combobox', { name: 'Role' })).toHaveValue('Inference');

  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('Cluster site4 added to AI grid')).toBeVisible();
  expect(enroll).toHaveBeenCalledTimes(2);
  // The second try carried the version and the labels the backend had then, so team stays.
  expect(enroll.mock.calls[1][0].resourceVersion).toBe(String(Number(before.resourceVersion) + 5));
  expect(service.clusters[index].labels).toMatchObject({
    team: 'blue',
    'ai-grid/enabled': 'true',
    location: 'us-east',
  });
});

it('shows the location and role someone else set meanwhile instead of sending the dialog’s over them', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters', service);
  await pick(user, 'site4', 'Add to AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  const location = within(modal).getByRole('textbox', { name: 'Location label' });
  await user.clear(location);
  await user.paste('us-east');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  // Another admin sets a location and role while the dialog is open.
  const index = service.clusters.findIndex((c) => c.name === 'site4');
  const before = service.clusters[index];
  service.clusters[index] = {
    ...before,
    location: 'eu-west',
    labels: { ...before.labels, location: 'eu-west', 'ai-grid/role': 'ingress' },
    resourceVersion: String(Number(before.resourceVersion) + 1),
  };
  const enroll = vi.spyOn(service, 'enrollCluster');

  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(
    await within(modal).findByText(
      "Another user changed this cluster's location label or role after this dialog opened. Their values are now shown. Review them and try again.",
    ),
  ).toBeVisible();
  expect(within(modal).getByRole('textbox', { name: 'Location label' })).toHaveValue('eu-west');
  // The role they set is now the cluster's, so it shows read-only, as a kept role does.
  expect(within(modal).getByRole('textbox', { name: 'Role' })).toHaveValue('Ingress');
  expect(within(modal).queryByRole('combobox', { name: 'Role' })).not.toBeInTheDocument();

  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('Cluster site4 added to AI grid')).toBeVisible();
  expect(enroll).toHaveBeenCalledTimes(2);
  expect(enroll.mock.calls[1][1]).toEqual({ location: 'eu-west', role: 'ingress' });
});

it('says so when the cluster changed and could not be loaded again', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters', service);
  await pick(user, 'site4', 'Add to AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  const location = within(modal).getByRole('textbox', { name: 'Location label' });
  await user.clear(location);
  await user.paste('us-east');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  const index = service.clusters.findIndex((c) => c.name === 'site4');
  const before = service.clusters[index];
  service.clusters[index] = { ...before, resourceVersion: String(Number(before.resourceVersion) + 1) };
  vi.spyOn(service, 'getCluster').mockRejectedValueOnce(new Error('network down'));

  await user.click(within(modal).getByRole('button', { name: 'Add' }));
  expect(
    await within(modal).findByText(
      'This cluster was changed after this dialog opened, and the latest version could not be loaded. Cancel, refresh the page, and try again.',
    ),
  ).toBeVisible();
});

it('shows a FailedPrecondition from Remove as the backend refusing it, not as a stale cluster', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  const message =
    'Cluster "site1" is the only AI grid cluster that serves ingress, and users reach models through ingress clusters. Give another cluster the ingress or combined role first.';
  // 412 is FailedPrecondition over Connect (connectClusters.ts).
  vi.spyOn(service, 'removeClusterFromGrid').mockRejectedValueOnce(new ServiceError(412, message));
  renderAt('/clusters', service);
  await pick(user, 'site1', 'Remove from AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  const reload = vi.spyOn(service, 'getCluster');
  await user.click(within(modal).getByRole('textbox', { name: 'Type site1 to confirm:' }));
  await user.paste('site1');
  await user.click(within(modal).getByRole('button', { name: 'Remove' }));
  expect(await within(modal).findByText(message)).toBeVisible();
  expect(modal).not.toHaveTextContent('This cluster was changed after this dialog opened');
  // A refusal isn't a stale version: nothing is loaded again into the dialog.
  expect(reload).not.toHaveBeenCalled();
  expect(service.clusters.find((c) => c.name === 'site1')!.aiGridEnabled).toBe(true);
});

/** Opens Edit for a row and returns the dialog. */
const openEdit = async (user: User, name: string) => {
  await pick(user, name, 'Edit');
  return screen.findByRole('dialog', { name: 'Edit AI grid cluster' });
};

/** Replaces a text field's value in the dialog, then leaves it. */
const enter = async (user: User, dialog: HTMLElement, name: string, value: string) => {
  const input = within(dialog).getByRole('textbox', { name });
  await user.clear(input);
  if (value) await user.paste(value);
  await user.tab();
};

// The page tests' shared Clusters fake (connectClusters.ts) writes what the backend's Update does:
// the labels as the mask names them. Called directly, to check the cases no page reaches.
describe('the shared Clusters fake', () => {
  const clustersClient = (service: MockConsoleService) => createClient(Clusters, transportFor(service)([]));

  it('refuses an annotations update rather than take it for a removal from AI grid', async () => {
    const service = new MockConsoleService();
    const before = service.clusters.find((c) => c.name === 'site1')!;
    await expect(
      clustersClient(service).update({
        object: {
          id: 'site1',
          metadata: {
            annotations: { 'ai-grid/site-name': 'San Francisco DC2' },
            version: Number(before.resourceVersion),
          },
        },
        updateMask: { paths: ['metadata.annotations'] },
        lock: true,
      }),
    ).rejects.toThrow(/doesn't write annotations/);
    expect(service.clusters.find((c) => c.name === 'site1')).toEqual(before);
  });

  it('takes the console keys of a sent map as the whole set and keeps every other key', async () => {
    const service = new MockConsoleService();
    const before = service.clusters.find((c) => c.name === 'site2')!;
    // Sent: the location changed, ai-grid/region left out, and none of the hub's own labels.
    await clustersClient(service).update({
      object: {
        id: 'site2',
        metadata: {
          labels: {
            'ai-grid/enabled': 'true',
            'ai-grid/role': 'combined',
            'ai-grid/site': 'new-york',
            'ai-grid/provisioned': 'true',
            location: 'us-east-2',
          },
          version: Number(before.resourceVersion),
        },
      },
      updateMask: { paths: ['metadata.labels'] },
      lock: true,
    });
    const after = service.clusters.find((c) => c.name === 'site2')!;
    const expected: Record<string, string> = { ...before.labels, location: 'us-east-2' };
    delete expected['ai-grid/region'];
    expect(after.labels).toEqual(expected);
    expect(after.aiGridEnabled).toBe(true);
  });

  it('refuses a changed key the console does not own, and removes a member only on labels without ai-grid/enabled', async () => {
    const service = new MockConsoleService();
    const before = service.clusters.find((c) => c.name === 'site3')!;
    const client = clustersClient(service);
    await expect(
      client.update({
        object: { id: 'site3', metadata: { labels: { ...before.labels, name: 'other' }, version: 1 } },
        updateMask: { paths: ['metadata.labels'] },
        lock: true,
      }),
    ).rejects.toThrow(/label "name" cannot be changed through the console/);
    const labels = { ...before.labels };
    delete labels['ai-grid/enabled'];
    await client.update({
      object: { id: 'site3', metadata: { labels, version: Number(before.resourceVersion) } },
      updateMask: { paths: ['metadata.labels'] },
      lock: true,
    });
    expect(service.clusters.find((c) => c.name === 'site3')!.aiGridEnabled).toBe(false);
  });
});

it('saves a labels-only edit with the other labels kept and the membership unchanged', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  const before = service.clusters.find((c) => c.name === 'site2')!;
  renderAt('/clusters', service);
  const dialog = await openEdit(user, 'site2');
  await enter(user, dialog, 'Location label', 'us-east-2');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Changes to cluster site2 saved')).toBeVisible();
  const after = service.clusters.find((c) => c.name === 'site2')!;
  expect(after.aiGridEnabled).toBe(true);
  expect(after.labels).toEqual({ ...before.labels, location: 'us-east-2' });
  expect(after.location).toBe('us-east-2');
  // The annotations weren't sent, so the site name and position stay.
  expect(after.siteName).toBe('New York');
  expect(after.longitude).toBe(-74.006);
});

it('returns focus to the row’s menu button when the dialog it opened closes', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await pick(user, 'site4', 'Add to AI grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByTestId('cluster-membership-modal')).not.toBeInTheDocument());
  await waitFor(() => expect(addButton('site4')).toHaveFocus());
});

it("shows each cluster's site and region apart, or what to fix", async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    new MockConsoleService(),
    transportWith(
      {
        id: 'named',
        metadata: { name: 'named' },
        status: {
          location: {
            siteName: 'Columbus DC2',
            latitude: 39.96,
            longitude: -83,
            source: ManagedClusterLocationSource.ANNOTATIONS,
          },
        },
      },
      {
        id: 'in-region',
        metadata: { name: 'in-region' },
        status: {
          location: {
            latitude: 40.42,
            longitude: -82.91,
            source: ManagedClusterLocationSource.CLOUD_REGION,
            region: 'us-east-2',
          },
        },
      },
      {
        id: 'wrong',
        metadata: { name: 'wrong' },
        status: {
          location: {
            source: ManagedClusterLocationSource.NONE,
            problem: 'ai-grid/latitude "40,7" is not a decimal number of degrees',
          },
        },
      },
      {
        id: 'nowhere',
        metadata: { name: 'nowhere' },
        status: { location: { source: ManagedClusterLocationSource.NONE } },
      },
    ),
  );
  expect(await screen.findByTestId('cluster-site-named')).toHaveTextContent(/^Columbus DC2$/);
  // The cloud region is the Region column, never the site.
  const inRegion = screen.getByRole('row', { name: /^in-region / });
  expect(screen.queryByTestId('cluster-site-in-region')).not.toBeInTheDocument();
  expect(within(inRegion).getByRole('cell', { name: 'us-east-2' })).toBeVisible();
  const wrong = screen.getByTestId('cluster-site-wrong');
  expect(wrong).toHaveTextContent('Invalid position');
  await user.hover(wrong);
  expect(await screen.findByText('ai-grid/latitude "40,7" is not a decimal number of degrees')).toBeInTheDocument();
  expect(within(screen.getByRole('row', { name: /^nowhere / })).getAllByText('—').length).toBeGreaterThan(0);
});

it('explains Unavailable in a popover from the compact cluster status and returns focus after dismissal', async () => {
  const user = userEvent.setup();
  const message = 'Hub has not received a heartbeat.';
  renderAt('/clusters', serviceWith([{ ...cluster('edge-a', 'Unavailable'), statusMessage: message }]));
  const trigger = await screen.findByRole('button', { name: 'Unavailable for edge-a' });
  expect(trigger.closest('.pf-v6-c-label')).toHaveClass('pf-m-compact');
  expect(trigger.closest('.pf-v6-c-label')).not.toHaveClass('pf-m-outline');
  await user.click(trigger);
  // The cluster's name and status, "Cluster status" under them, then what Unavailable means.
  const dialog = await screen.findByRole('dialog', { name: 'edge-a Unavailable' });
  expect(within(dialog).getByText('Cluster status')).toBeVisible();
  expect(within(dialog).getByRole('heading', { name: 'Warning alert: Cannot reach API server' })).toBeVisible();
  expect(
    within(dialog).getByText(
      'Telemetry and console updates are unavailable, and the system is unable to confirm whether the cluster is running.',
    ),
  ).toBeVisible();
  // The hub's message is on the cluster's page, in its status tooltip.
  expect(within(dialog).queryByText(message)).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard('{Enter}');
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('opens Ready only with a hub message, Unavailable always, and keeps message-free and AI grid statuses noninteractive', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceWith([
      {
        ...cluster('ready-message', 'Ready', { 'ai-grid/enabled': 'true', 'ai-grid/provisioned': 'true' }),
        statusMessage: 'All checks passed.',
      },
      cluster('ready-quiet', 'Ready'),
      cluster('offline-quiet', 'Unavailable'),
      { ...cluster('whitespace', 'Unknown'), statusMessage: '   ' },
    ]),
  );
  await user.click(await screen.findByRole('button', { name: 'Ready for ready-message' }));
  const ready = await screen.findByRole('dialog', { name: 'ready-message Ready' });
  expect(within(ready).getByText('Cluster status')).toBeVisible();
  expect(within(ready).getByText('All checks passed.')).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  // Unavailable says what it means even without a hub message.
  await user.click(screen.getByRole('button', { name: 'Unavailable for offline-quiet' }));
  expect(
    within(await screen.findByRole('dialog', { name: 'offline-quiet Unavailable' })).getByText(
      'Cannot reach API server',
    ),
  ).toBeVisible();
  await user.keyboard('{Escape}');
  for (const name of ['ready-quiet', 'whitespace']) {
    const row = screen.getByRole('row', { name: new RegExp(`^${name} `) });
    expect(within(row).queryByRole('button', { name: /Ready|Unavailable|Unknown/ })).not.toBeInTheDocument();
    expect(
      within(row)
        .getByText(name === 'ready-quiet' ? 'Ready' : 'Unknown')
        .closest('.pf-v6-c-label'),
    ).toHaveClass('pf-m-outline');
  }
  const provisioned = within(screen.getByRole('row', { name: /^ready-message / })).getByText('Provisioned');
  expect(provisioned.closest('.pf-v6-c-label')).toHaveClass('pf-m-outline');
  expect(provisioned.closest('button')).toBeNull();
});

it('keeps the cluster list filter, sort, and page while reading a status message', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceWith(
      Array.from({ length: 24 }, (_, i) => ({
        ...cluster(`edge-${String(i).padStart(2, '0')}`, 'Unavailable'),
        statusMessage: `Heartbeat ${i} is missing.`,
      })),
    ),
  );
  const search = await screen.findByRole('textbox', { name: 'Filter clusters' });
  await user.type(search, 'edge');
  await user.click(within(screen.getByRole('columnheader', { name: 'Name' })).getByRole('button'));
  await user.click(screen.getAllByRole('button', { name: 'Go to next page' })[0]);
  const names = () =>
    within(screen.getByTestId('clusters-table'))
      .getAllByRole('link')
      .map((link) => link.textContent);
  const before = names();
  expect(before[0]).toBe('edge-13');
  await user.click(screen.getByRole('button', { name: 'Unavailable for edge-13' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }));
  expect(search).toHaveValue('edge');
  expect(names()).toEqual(before);
  expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
});

it('refreshes the selected cluster by identity and forgets a dialog when its cluster disappears', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const a = { ...cluster('edge-a', 'Unavailable'), statusMessage: 'Waiting for a heartbeat.' };
    const b = { ...cluster('edge-b', 'Unavailable'), statusMessage: 'Other cluster report.' };
    const service = serviceWith([a, b]);
    renderAt('/clusters', service);
    await user.click(await screen.findByRole('button', { name: 'Unavailable for edge-a' }));
    service.clusters = [b, { ...a, status: 'Ready', statusMessage: 'Heartbeat received.' }];
    await act(() => vi.advanceTimersByTimeAsync(30000));
    const dialog = await screen.findByRole('dialog', { name: 'edge-a Ready' });
    expect(within(dialog).getByText('Heartbeat received.')).toBeVisible();
    expect(within(dialog).getByText('Ready')).toBeVisible();
    expect(within(dialog).queryByText('Other cluster report.')).not.toBeInTheDocument();
    service.clusters = [b];
    await act(() => vi.advanceTimersByTimeAsync(30000));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    service.clusters = [a, b];
    await act(() => vi.advanceTimersByTimeAsync(30000));
    await screen.findByRole('button', { name: 'Unavailable for edge-a' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
