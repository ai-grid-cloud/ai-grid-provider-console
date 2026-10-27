// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/clusters.test.tsx at 62319b8.
// The PoC drives a fake ACM Hub through its backend; here the same cases run on
// MockConsoleService, and the BFF's PATCH is covered by bff/internal/api tests.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceError } from '../api/ConsoleService';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import type { GridCluster } from '../api/types';
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
  renderAt('/', service);
  const table = await screen.findByTestId('clusters-table');
  const nav = screen.getByRole('navigation', { name: 'Console sections' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['AI Grid', 'Monitoring', 'Clusters', 'Organizations', 'Models', 'Subscriptions']);
  // A member links to its AI Grid drawer and shows its provisioning; one status line each.
  const member = within(table).getByRole('link', { name: 'cluster-a' }).closest('tr')!;
  expect(within(table).getByRole('link', { name: 'cluster-a' })).toHaveAttribute('href', '/ai-grid?cluster=cluster-a');
  expect(within(member).getByText('Provisioned')).toBeInTheDocument();
  const offline = within(table).getByText('cluster-c').closest('tr')!;
  expect(offline).toHaveTextContent('Offline');
  expect(within(offline).queryByRole('link')).not.toBeInTheDocument();
  expect(within(offline).getAllByText('—').length).toBeGreaterThan(0);
  await add(user, 'cluster-b');
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
  expect(screen.queryByTestId('cluster-membership-modal')).not.toBeInTheDocument();
  const enrolled = service.clusters.find((c) => c.name === 'cluster-b')!;
  expect(enrolled.labels).toEqual({ location: 'site2', 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference' });
  expect(enrolled.location).toBe('site2');
  await user.type(screen.getByRole('textbox', { name: 'Search clusters' }), 'cluster-c');
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
  await user.click(within(modal).getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('cluster-a removed from AI Grid')).toBeVisible();
  const removed = service.clusters.find((c) => c.name === 'cluster-a')!;
  expect(removed.labels).toEqual({ 'ai-grid/provisioned': 'true', location: 'site1' });
  expect(
    within(screen.getByTestId('clusters-table')).queryByRole('link', { name: 'cluster-a' }),
  ).not.toBeInTheDocument();
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

it('warns about a member without a location, and asks for a location and role before adding', async () => {
  const user = userEvent.setup();
  const service = serviceWith([
    cluster('no-location-member', 'Ready', { 'ai-grid/enabled': 'true' }),
    cluster('no-location', 'Ready'),
    cluster('local-cluster', 'Ready'),
  ]);
  renderAt('/clusters', service);
  expect(await screen.findByTestId('missing-location-no-location-member')).toHaveTextContent('No location');
  await pick(user, 'no-location', 'Add to AI Grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  // Nothing is written until both are given; each field says why and describes its error.
  const location = within(modal).getByRole('textbox', { name: 'Location' });
  const role = within(modal).getByRole('combobox', { name: 'Role' });
  expect(location).toHaveAttribute('aria-invalid', 'true');
  expect(role).toHaveAttribute('aria-invalid', 'true');
  expect(location).toHaveAccessibleDescription(/^Required\./);
  expect(role).toHaveAccessibleDescription(/^Required\./);
  await user.type(location, 'us east');
  expect(location).toHaveAccessibleDescription(/Use up to 63 letters/);
  expect(service.clusters[1].labels).toEqual({});
  await user.click(within(modal).getByRole('button', { name: 'Cancel' }));
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
  expect(await screen.findByText('the AI Grid backend is unavailable; try again')).toBeVisible();
  expect(screen.queryByText('No managed clusters')).not.toBeInTheDocument();
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
  expect(await screen.findByRole('link', { name: 'cluster-b' })).toBeInTheDocument();
  service.clusters[1] = cluster('cluster-b', 'Ready', { location: 'site2' });
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.queryByRole('link', { name: 'cluster-b' })).not.toBeInTheDocument());
});

it('shows the role and location Add wrote while the list reloads', async () => {
  const service = serviceWith([cluster('cluster-b', 'Ready')]);
  const list = service.listClusters;
  const user = userEvent.setup();
  renderAt('/clusters', service);
  await pick(user, 'cluster-b', 'Add to AI Grid');
  // The reload after Add hasn't answered yet, so the table still holds the list from before.
  let answer: () => void = () => {};
  service.listClusters = () => new Promise((resolve) => (answer = () => resolve(list())));
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.type(within(modal).getByRole('textbox', { name: 'Location' }), 'paris');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
  const row = within(screen.getByTestId('clusters-table')).getByRole('row', { name: /^cluster-b / });
  expect(row).toHaveTextContent('Inference');
  expect(row).toHaveTextContent('paris');
  expect(screen.queryByTestId('missing-role-cluster-b')).not.toBeInTheDocument();
  expect(screen.queryByTestId('missing-location-cluster-b')).not.toBeInTheDocument();
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
    // A poll answers with the list from before the change; then the reload after Add hangs.
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
    let older: () => void = () => {};
    service.listClusters = () => new Promise((resolve) => (older = () => resolve(before)));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    let latest: () => void = () => {};
    service.listClusters = () => new Promise((resolve) => (latest = () => resolve(list())));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => older());
    expect(row()).toHaveTextContent('Inference');
    // The latest reload's answer replaces it: someone changed the role in the meantime.
    service.clusters[0] = {
      ...service.clusters[0],
      labels: { ...service.clusters[0].labels, 'ai-grid/role': 'ingress' },
    };
    await act(async () => latest());
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
  expect(await within(modal).findByText('Unable to add the cluster')).toBeVisible();
  expect(within(modal).getByText('The Hub did not confirm the change. Refresh and try again.')).toBeVisible();
});

it('shows the PoC empty state', async () => {
  renderAt('/clusters', serviceWith([]));
  expect(await screen.findByText('No managed clusters')).toBeInTheDocument();
  expect(screen.getByText('No ManagedClusters are available.')).toBeInTheDocument();
});

it('shows the seeded clusters with location, status and provisioning, and no site or region', async () => {
  renderAt('/clusters', new MockConsoleService());
  const table = await screen.findByTestId('clusters-table');
  const sydney = within(table).getByRole('row', { name: /^site4 / });
  // site4 is both the name and the location.
  expect(within(sydney).getAllByText('site4')).toHaveLength(2);
  expect(sydney).toHaveTextContent('Ready');
  // Its ai-grid/site and ai-grid/region labels aren't shown.
  expect(sydney).not.toHaveTextContent('sydney');
  expect(sydney).not.toHaveTextContent('asia-pacific');
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
  expect(within(table).getByRole('row', { name: /^edge-1 / })).toHaveTextContent('Ingress');
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
      .slice(1)
      .map((r) => r.querySelector('td')?.textContent);
  const before = names();
  await user.click(within(table).getByRole('button', { name: 'About cluster roles' }));
  expect(await screen.findByText('Serves models behind an ingress cluster.')).toBeVisible();
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
      .slice(1)
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

// PR 12's cluster JSON through HttpConsoleService, as GET /api/v1/clusters sends it.
const serviceOnClusterJson = (clusters: unknown[]) => {
  const service = new MockConsoleService();
  const fetchFn = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: clusters }), { headers: { 'Content-Type': 'application/json' } }),
    );
  service.listClusters = () => new HttpConsoleService(fetchFn).listClusters();
  return service;
};

it('shows Unknown for a cluster without a status', async () => {
  // The shipped backend reports no state, so PR 12's BFF omits status.
  renderAt('/clusters', serviceOnClusterJson([{ name: 'bare', aiGridEnabled: false, provisioned: false }]));
  const row = await screen.findByRole('row', { name: /^bare / });
  expect(within(row).getByText('Unknown')).toBeInTheDocument();
  expect(row).not.toHaveTextContent('provisioned');
});

it('shows the ACM state for an importing cluster', async () => {
  const user = userEvent.setup();
  renderAt(
    '/clusters',
    serviceOnClusterJson([
      {
        name: 'site-berlin-1',
        aiGridEnabled: false,
        provisioned: false,
        status: 'importing',
        statusMessage: 'Import of the managed cluster is in progress',
      },
    ]),
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

it('wraps the headers, shows Role, and has no Hub, Site or Region column', async () => {
  renderAt('/clusters', serviceWith(hubClusters()));
  const table = await screen.findByTestId('clusters-table');
  for (const header of within(table)
    .getAllByRole('columnheader')
    .filter((h) => h.textContent !== 'Actions')) {
    expect(header).toHaveClass('pf-m-wrap');
  }
  expect(within(table).getByRole('columnheader', { name: /^Role/ })).not.toHaveClass('pf-m-hidden');
  // A cluster the hub hasn't accepted says so under Connection. Site and Region are out of scope
  // until geography is (after the MVP).
  for (const name of ['Hub', 'Site', 'Region']) {
    expect(within(table).queryByRole('columnheader', { name })).not.toBeInTheDocument();
  }
  expect(within(table).getByRole('columnheader', { name: 'OpenShift' })).not.toHaveClass('pf-m-hidden');
  // The hub's connection to the cluster, not its AI Grid provisioning, which has its own column.
  expect(within(table).getByRole('columnheader', { name: /^Connection/ })).toBeInTheDocument();
});

it('says when the search matches no cluster, and clears it from the table', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  await user.type(screen.getByRole('textbox', { name: 'Search clusters' }), 'no-such-cluster');
  expect(screen.getByRole('heading', { name: 'No results found' })).toBeVisible();
  expect(screen.getByText('Change the search to see more clusters.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
  expect(await screen.findByRole('row', { name: /^site1 / })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Search clusters' })).toHaveValue('');
});

it('reloads the cluster in the open dialog after a conflict, keeping the choices, so the next Add works', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters', service);
  await pick(user, 'site4', 'Add to AI Grid');
  const modal = await screen.findByTestId('cluster-membership-modal');
  const location = within(modal).getByRole('textbox', { name: 'Location' });
  await user.clear(location);
  await user.type(location, 'us-east');
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
  expect(within(modal).getByRole('textbox', { name: 'Location' })).toHaveValue('us-east');
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
  const location = within(modal).getByRole('textbox', { name: 'Location' });
  await user.clear(location);
  await user.type(location, 'us-east');
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
      'Someone else changed the location or role of this cluster since you opened this dialog. The dialog now shows theirs; check them and try again.',
    ),
  ).toBeVisible();
  expect(within(modal).getByRole('textbox', { name: 'Location' })).toHaveValue('eu-west');
  expect(within(modal).getByRole('combobox', { name: 'Role' })).toHaveValue('Ingress');

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
  const location = within(modal).getByRole('textbox', { name: 'Location' });
  await user.clear(location);
  await user.type(location, 'us-east');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  const index = service.clusters.findIndex((c) => c.name === 'site4');
  const before = service.clusters[index];
  service.clusters[index] = { ...before, resourceVersion: String(Number(before.resourceVersion) + 1) };
  vi.spyOn(service, 'listClusters').mockRejectedValueOnce(new Error('network down'));

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
