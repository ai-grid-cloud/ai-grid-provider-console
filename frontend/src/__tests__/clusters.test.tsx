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
  cluster('cluster-c', 'Offline'),
];

const serviceWith = (clusters: GridCluster[]) => new MockConsoleService(undefined, clusters);

type User = ReturnType<typeof userEvent.setup>;

/** Opens a row's actions menu and picks an item. */
const pick = async (user: User, cluster: string, item: string) => {
  await user.click(await screen.findByRole('button', { name: `Actions for ${cluster}` }));
  await user.click(screen.getByRole('menuitem', { name: item }));
};

/** Adds a cluster from its row menu as an inference cluster, keeping its location, and confirms. */
const add = async (user: User, cluster: string) => {
  await pick(user, cluster, 'Add to AI Grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  return modal;
};

it('lists live Hub states, includes AI Grid navigation and enrolls with a label-only PATCH', async () => {
  const user = userEvent.setup();
  const service = serviceWith(hubClusters());
  renderAt('/clusters', service);
  const table = await screen.findByTestId('clusters-table');
  const nav = screen.getByRole('navigation', { name: 'Console sections' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['AI Grid', 'Monitoring', 'Clusters', 'Organizations', 'Models', 'Subscriptions']);
  // Every name links to the cluster's details page; a member shows its provisioning, one status line each.
  const member = within(table).getByRole('link', { name: 'cluster-a' }).closest('tr')!;
  expect(within(table).getByRole('link', { name: 'cluster-a' })).toHaveAttribute('href', '/clusters/cluster-a');
  expect(within(member).getByText('Provisioned')).toBeInTheDocument();
  const offline = within(table).getByRole('link', { name: 'cluster-c' }).closest('tr')!;
  expect(within(table).getByRole('link', { name: 'cluster-c' })).toHaveAttribute('href', '/clusters/cluster-c');
  expect(offline).toHaveTextContent('Offline');
  expect(within(offline).getAllByText('—').length).toBeGreaterThan(0);
  await add(user, 'cluster-b');
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
  expect(screen.queryByTestId('cluster-membership-modal')).not.toBeInTheDocument();
  const enrolled = service.clusters.find((c) => c.name === 'cluster-b')!;
  expect(enrolled.labels).toEqual({ location: 'site2', 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference' });
  expect(enrolled.location).toBe('site2');
  await user.click(screen.getByRole('textbox', { name: 'Filter clusters' }));
  await user.paste('cluster-c');
  expect(within(screen.getByTestId('clusters-table')).queryByText('cluster-a')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Actions for cluster-c' }));
  expect(screen.getByRole('menuitem', { name: 'Add to AI Grid' })).not.toHaveAttribute('aria-disabled', 'true');
});

it('removes a member from AI Grid after a confirmation', async () => {
  const user = userEvent.setup();
  const service = serviceWith(hubClusters());
  renderAt('/clusters', service);
  await pick(user, 'cluster-a', 'Remove from AI Grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  expect(modal).toHaveTextContent('Remove cluster-a from AI Grid?');
  // A remote cluster also leaves the cross-cluster network.
  expect(modal).toHaveTextContent('It is also disconnected from the other AI Grid clusters.');
  expect(modal).toHaveTextContent(
    'Models deployed to it from the Models page are removed from it. OpenShift AI is not uninstalled.',
  );
  // Destructive, so it asks for the cluster's name typed in, as every delete does.
  expect(within(modal).getByRole('button', { name: 'Remove' })).toBeDisabled();
  await user.type(within(modal).getByRole('textbox', { name: 'Type cluster-a to confirm:' }), 'cluster-a');
  await user.click(within(modal).getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('cluster-a removed from AI Grid')).toBeVisible();
  const removed = service.clusters.find((c) => c.name === 'cluster-a')!;
  expect(removed.labels).toEqual({ 'ai-grid/provisioned': 'true', location: 'site1' });
  const row = within(screen.getByTestId('clusters-table')).getByRole('link', { name: 'cluster-a' }).closest('tr')!;
  expect(within(row).getByText('Not added')).toBeInTheDocument();
});

it('does not say the hub is disconnected when removing local-cluster', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceWith([cluster('local-cluster', 'Ready', { 'ai-grid/enabled': 'true', location: 'hub' })]),
  );
  await pick(user, 'local-cluster', 'Remove from AI Grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  // The network Placement always selects local-cluster.
  expect(modal).not.toHaveTextContent('disconnected');
  expect(modal).toHaveTextContent('AI Grid stops managing this cluster, and models are no longer placed on it.');
  expect(modal).toHaveTextContent(
    'Models deployed to it from the Models page are removed from it. OpenShift AI is not uninstalled.',
  );
});

it('asks for a role before adding, and takes no location label as none', async () => {
  const user = userEvent.setup();
  const service = serviceWith([
    cluster('no-location-member', 'Ready', { 'ai-grid/enabled': 'true' }),
    cluster('no-location', 'Ready'),
    cluster('local-cluster', 'Ready'),
  ]);
  renderAt('/clusters', service);
  // A member without a location label gets no warning: nothing places models by it.
  expect(within(await screen.findByRole('row', { name: /^no-location-member / })).queryByRole('img')).toBeNull();
  await pick(user, 'no-location', 'Add to AI Grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  // Nothing is written until a role is given; the location label is optional and says so.
  const location = within(modal).getByRole('textbox', { name: 'Location label' });
  const role = within(modal).getByRole('combobox', { name: 'Role' });
  expect(location).not.toHaveAttribute('aria-invalid', 'true');
  expect(location).not.toBeRequired();
  expect(location).toHaveAccessibleDescription(
    /^Optional\. .*Models are placed on clusters by name, not by this label\./,
  );
  expect(role).toHaveAttribute('aria-invalid', 'true');
  expect(role).toHaveAccessibleDescription(/^Required\./);
  await user.click(location);
  await user.paste('us east');
  expect(location).toHaveAccessibleDescription(/Use up to 63 letters/);
  expect(service.clusters[1].labels).toEqual({});
  // Left empty, the cluster gets a role and no location label.
  await user.clear(location);
  await user.click(role);
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('no-location added to AI Grid')).toBeVisible();
  expect(service.clusters[1].labels).toEqual({ 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference' });
  // The hub itself defaults to the combined role.
  await pick(user, 'local-cluster', 'Add to AI Grid');
  expect(
    within(await screen.findByTestId('cluster-membership-modal')).getByRole('combobox', { name: 'Role' }),
  ).toHaveValue('Combined');
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
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
});

it('reports Hub unavailability and retries instead of showing a false empty list', async () => {
  const service = serviceWith(hubClusters());
  const list = service.listClusters;
  service.listClusters = async () => {
    throw new ServiceError(503, 'the AI Grid backend is unavailable; try again');
  };
  const user = userEvent.setup();
  renderAt('/clusters', service);
  expect(await screen.findByRole('heading', { name: 'Unable to load clusters' })).toBeVisible();
  expect(screen.getByText('the AI Grid backend is unavailable; try again')).toBeVisible();
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
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
  const row = () => within(screen.getByTestId('clusters-table')).getByRole('row', { name: /^cluster-b / });
  await waitFor(() => expect(row()).toHaveTextContent('Provisioning'));
  service.clusters[1] = cluster('cluster-b', 'Ready', { location: 'site2' });
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(within(row()).getByText('Not added')).toBeInTheDocument());
});

it('shows the role and location Add wrote while the list reloads', async () => {
  const service = serviceWith([cluster('cluster-b', 'Ready')]);
  const list = service.listClusters;
  const user = userEvent.setup();
  renderAt('/clusters', service);
  await pick(user, 'cluster-b', 'Add to AI Grid');
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
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
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
      'MaaS (ingress)',
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
    expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
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
    await waitFor(() => expect(row()).toHaveTextContent('MaaS (ingress)'));
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
  expect(await within(modal).findByText('Unable to add the cluster')).toBeVisible();
  expect(within(modal).getByText('The Hub did not confirm the change. Refresh and try again.')).toBeVisible();
});

it('says when the hub has no clusters', async () => {
  renderAt('/clusters', serviceWith([]));
  expect(await screen.findByRole('heading', { name: 'No clusters' })).toBeVisible();
  expect(screen.getByText(/The hub has no managed clusters yet/)).toBeVisible();
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
  expect(alert).toHaveTextContent('the AI Grid backend is unavailable; try again');
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
  // Not a member: says so, with no provisioning and no role.
  expect(sydney).not.toHaveTextContent('provisioned');
  expect(within(sydney).getByText('Not added')).toBeVisible();
  expect(sydney).not.toHaveTextContent('Combined');
  expect(within(table).getAllByText('Provisioned')).toHaveLength(3);
  expect(within(table).getAllByText('Combined')).toHaveLength(3);
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
  expect(within(table).getByRole('row', { name: /^edge-1 / })).toHaveTextContent('MaaS (ingress)');
  expect(within(table).getByRole('row', { name: /^gpu-1 / })).toHaveTextContent('Inference');
  const former = within(table).getByRole('row', { name: /^former / });
  expect(former).toHaveTextContent('Not added');
  expect(former).not.toHaveTextContent('Combined');
  const missing = screen.getByTestId('missing-role-no-role');
  expect(missing).toHaveTextContent('No role');
  await user.hover(missing);
  expect(await screen.findByText(/doesn't install OpenShift AI or MaaS on it/)).toBeInTheDocument();
  expect(screen.getByTestId('missing-role-odd-role')).toHaveTextContent('No role');
  // The header explains the three roles, without sorting the table.
  const names = () =>
    within(table)
      .getAllByRole('row')
      .slice(2)
      .map((r) => r.querySelector('td')?.textContent);
  const before = names();
  await user.click(within(table).getByRole('button', { name: 'About cluster roles' }));
  expect(await screen.findByText('Serves models behind a MaaS (ingress) cluster.')).toBeVisible();
  expect(names()).toEqual(before);
});

it('sorts by role: clusters outside AI Grid, then members without a role, then by role', async () => {
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
  expect(names()).toEqual(['b-outside', 'a-no-role', 'd-combined', 'c-inference', 'e-ingress']);
  await user.click(sortButton);
  expect(names()).toEqual(['e-ingress', 'c-inference', 'd-combined', 'a-no-role', 'b-outside']);
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
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('User could not be loaded'));
  // site4 is both the name and the location, so find its row rather than the text.
  expect(await screen.findByRole('row', { name: /^site4 / })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Actions for / })).not.toBeInTheDocument();
});

it('shows the not-available state on a backend without the RPC', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  service.enrollCluster = async () => {
    throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
  };
  renderAt('/clusters', service);
  const modal = await add(user, 'site4');
  expect(await within(modal).findByText('Unable to add the cluster')).toBeInTheDocument();
  expect(
    within(modal).getByText('Adding clusters to AI Grid is not available on this backend yet.'),
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
  // One status line; the state and the message are in its tooltip.
  expect(within(row).getByText('Unknown')).toBeInTheDocument();
  expect(within(row).queryByText('Importing')).not.toBeInTheDocument();
  await user.hover(within(row).getByText('Unknown'));
  expect(await screen.findByText('Importing: Import of the managed cluster is in progress')).toBeInTheDocument();
});

it('offers only Remove from AI Grid for a member', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await user.click(await screen.findByRole('button', { name: 'Actions for site1' }));
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Remove from AI Grid']);
});

it('offers Add to AI Grid only for ready, offline or unknown clusters', async () => {
  const withState = (name: string, state: NonNullable<GridCluster['state']>): GridCluster => ({
    ...cluster(name, 'Unknown'),
    state,
  });
  renderAt(
    '/clusters',
    serviceWith([
      cluster('is-ready', 'Ready'),
      cluster('is-offline', 'Offline'),
      cluster('is-unknown', 'Unknown'),
      withState('is-detaching', 'Detaching'),
      withState('is-importfailed', 'Import failed'),
      withState('is-notaccepted', 'Not accepted'),
      withState('is-pendingimport', 'Pending import'),
      withState('is-importing', 'Importing'),
    ]),
  );
  await screen.findByTestId('clusters-table');
  const user = userEvent.setup();
  const addItem = async (name: string) => {
    await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
    const item = screen.getByRole('menuitem', { name: 'Add to AI Grid' });
    return item;
  };
  for (const name of ['is-ready', 'is-offline', 'is-unknown']) {
    expect(await addItem(name)).not.toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');
  }
  // The others say why they can't be added yet.
  for (const name of ['is-detaching', 'is-importfailed', 'is-pendingimport', 'is-importing']) {
    const item = await addItem(name);
    expect(item).toHaveAttribute('aria-disabled', 'true');
    await user.hover(item);
    expect(await screen.findByText(/once it has imported it/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
  }
  const notAccepted = await addItem('is-notaccepted');
  expect(notAccepted).toHaveAttribute('aria-disabled', 'true');
  await user.hover(notAccepted);
  expect(
    await screen.findByText("The hub hasn't accepted this cluster yet. Accept it in ACM, then add it to AI Grid."),
  ).toBeInTheDocument();
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

it('shows no GPUs for a cluster whose capacity has none, and sorts by GPU count', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  expect(screen.getByTestId('cluster-gpu-capacity-site4')).toHaveTextContent('—');
  await user.click(screen.getByRole('button', { name: 'Capacity' }));
  const names = screen
    .getAllByRole('row')
    .slice(2)
    .map((r) => r.textContent?.split(' ')[0]);
  expect(names[0]).toMatch(/^site4/);
});

it('groups the columns as the details page does, wraps them, and has Data center and Region but no Hub column', async () => {
  renderAt('/clusters', serviceWith(hubClusters()));
  const table = await screen.findByTestId('clusters-table');
  const [groups, columns] = within(table).getAllByRole('row').slice(0, 2);
  // Nested column headers (UX review): Cluster, AI Grid and GPUs, as on the details page.
  expect(
    within(groups)
      .getAllByRole('columnheader')
      .map((h) => h.textContent)
      .filter((t) => t !== 'Actions'),
  ).toEqual(['Cluster', 'AI Grid', 'GPUs']);
  const headers = within(columns).getAllByRole('columnheader');
  expect(headers.map((h) => h.textContent)).toEqual([
    'Name',
    'Cluster Status',
    'Data center',
    'Region',
    'AI Grid Status',
    'Location label',
    'Role',
    'Capacity',
    'Configuration',
  ]);
  for (const header of headers) {
    expect(header).toHaveClass('pf-m-wrap');
  }
  // The two Status columns read Status on screen, under their groups; their sort buttons say which.
  expect(within(columns).getByRole('button', { name: 'Cluster Status' })).toBeInTheDocument();
  expect(within(columns).getByRole('button', { name: 'AI Grid Status' })).toBeInTheDocument();
  expect(within(columns).getAllByText('Status')).toHaveLength(2);
  expect(within(table).getByRole('columnheader', { name: /^Role/ })).not.toHaveClass('pf-m-hidden');
  // A cluster the hub hasn't accepted says so under Connection, so there is no Hub column.
  expect(within(table).queryByRole('columnheader', { name: 'Hub' })).not.toBeInTheDocument();
  // The OpenShift version is on the details page, leaving room for GPUs and Capacity.
  expect(within(table).queryByRole('columnheader', { name: 'OpenShift' })).not.toBeInTheDocument();
  // The actions column stays in view: it sticks to the right edge of the scrolling table.
  expect(within(groups).getByRole('columnheader', { name: 'Actions' })).toHaveClass('pf-v6-c-table__sticky-cell');
});

it('says when the search matches no cluster, and clears it from the table', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  await user.click(screen.getByRole('textbox', { name: 'Filter clusters' }));
  await user.paste('no-such-cluster');
  expect(screen.getByRole('heading', { name: 'No results found' })).toBeVisible();
  expect(screen.getByText('Change the filter to see more clusters.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
  expect(await screen.findByRole('row', { name: /^site1 / })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Filter clusters' })).toHaveValue('');
});

it('reloads the cluster in the open dialog after a conflict, keeping the choices, so the next Add works', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters', service);
  await pick(user, 'site4', 'Add to AI Grid');
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

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(
    await within(modal).findByText('This cluster changed since you opened this dialog. Check it and try again.'),
  ).toBeVisible();
  expect(within(modal).queryByText(/resource version/)).not.toBeInTheDocument();
  expect(within(modal).getByRole('textbox', { name: 'Location label' })).toHaveValue('us-east');
  expect(within(modal).getByRole('combobox', { name: 'Role' })).toHaveValue('Inference');

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('site4 added to AI Grid')).toBeVisible();
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
  await pick(user, 'site4', 'Add to AI Grid');
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

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(
    await within(modal).findByText(
      'Someone else changed the location label or role of this cluster since you opened this dialog. The dialog now shows theirs; check them and try again.',
    ),
  ).toBeVisible();
  expect(within(modal).getByRole('textbox', { name: 'Location label' })).toHaveValue('eu-west');
  expect(within(modal).getByRole('combobox', { name: 'Role' })).toHaveValue('MaaS (ingress)');

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('site4 added to AI Grid')).toBeVisible();
  expect(enroll).toHaveBeenCalledTimes(2);
  expect(enroll.mock.calls[1][1]).toEqual({ location: 'eu-west', role: 'ingress' });
});

it('says so when the cluster changed and could not be loaded again', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters', service);
  await pick(user, 'site4', 'Add to AI Grid');
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

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(
    await within(modal).findByText(
      "This cluster changed since you opened this dialog, and the console couldn't load it again. Cancel, refresh the list, and try again.",
    ),
  ).toBeVisible();
});

it('returns focus to the row’s menu button when the dialog it opened closes', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await pick(user, 'site4', 'Add to AI Grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByTestId('cluster-membership-modal')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Actions for site4' })).toHaveFocus());
});

it("shows each cluster's data center and region apart, or what to fix", async () => {
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
  expect(await screen.findByTestId('cluster-data-center-named')).toHaveTextContent(/^Columbus DC2$/);
  // The cloud region is the Region column, never the data center.
  const inRegion = screen.getByRole('row', { name: /^in-region / });
  expect(screen.queryByTestId('cluster-data-center-in-region')).not.toBeInTheDocument();
  expect(within(inRegion).getByRole('cell', { name: 'us-east-2' })).toBeVisible();
  const wrong = screen.getByTestId('cluster-data-center-wrong');
  expect(wrong).toHaveTextContent('Position not readable');
  await user.hover(wrong);
  expect(await screen.findByText('ai-grid/latitude "40,7" is not a decimal number of degrees')).toBeInTheDocument();
  expect(within(screen.getByRole('row', { name: /^nowhere / })).getAllByText('—').length).toBeGreaterThan(0);
});
