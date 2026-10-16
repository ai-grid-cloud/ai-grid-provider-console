// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/clusters.test.tsx at 62319b8.
// The PoC drives a fake ACM Hub through its backend; here the same cases run on
// MockConsoleService, and the BFF's PATCH is covered by bff/internal/api tests.
import { screen, waitFor, within } from '@testing-library/react';
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
    hubAcceptsClient: true,
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
  const member = within(table).getByText('cluster-a').closest('tr')!;
  expect(member).toHaveTextContent('AI Grid Member');
  expect(within(member).queryByRole('button')).not.toBeInTheDocument();
  const offline = within(table).getByText('cluster-c').closest('tr')!;
  expect(offline).toHaveTextContent('Offline');
  expect(offline).toHaveTextContent('Not enrolled');
  await user.click(screen.getByRole('button', { name: 'Add cluster-b to AI Grid' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Add cluster-b to AI Grid' })).not.toBeInTheDocument(),
  );
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
  const enrolled = service.clusters.find((c) => c.name === 'cluster-b')!;
  expect(enrolled.labels).toEqual({ location: 'site2', 'ai-grid/enabled': 'true' });
  expect(enrolled.location).toBe('site2');
  await user.type(screen.getByRole('textbox', { name: 'Search clusters' }), 'cluster-c');
  expect(within(screen.getByTestId('clusters-table')).queryByText('cluster-a')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add cluster-c to AI Grid' })).toBeEnabled();
});

it('keeps an unenrolled cluster on patch failure and allows a retry', async () => {
  const service = serviceWith(hubClusters());
  const enroll = service.enrollCluster;
  service.enrollCluster = async () => {
    throw new ServiceError(403, 'The backend does not have permission to list or patch ACM ManagedClusters.');
  };
  const user = userEvent.setup();
  renderAt('/clusters', service);
  await user.click(await screen.findByRole('button', { name: 'Add cluster-b to AI Grid' }));
  expect(
    await screen.findByText('The backend does not have permission to list or patch ACM ManagedClusters.'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add cluster-b to AI Grid' })).toBeEnabled();
  expect(service.clusters[1].labels['ai-grid/enabled']).toBeUndefined();
  service.enrollCluster = enroll;
  await user.click(screen.getByRole('button', { name: 'Add cluster-b to AI Grid' }));
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
  await user.click(await screen.findByRole('button', { name: 'Add cluster-b to AI Grid' }));
  expect(await screen.findByText('cluster-b added to AI Grid')).toBeVisible();
  service.clusters[1] = cluster('cluster-b', 'Ready', { location: 'site2' });
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('button', { name: 'Add cluster-b to AI Grid' })).toBeEnabled();
});

it('rejects a response that does not confirm membership', async () => {
  const service = serviceWith(hubClusters());
  service.enrollCluster = async (c) => cluster(c.name, 'Ready');
  const user = userEvent.setup();
  renderAt('/clusters', service);
  await user.click(await screen.findByRole('button', { name: 'Add cluster-b to AI Grid' }));
  expect(await screen.findByText('Unable to add cluster-b to AI Grid')).toBeVisible();
  expect(screen.getByText('The Hub did not confirm AI Grid membership. Refresh and try again.')).toBeVisible();
});

it('shows the PoC empty state', async () => {
  renderAt('/clusters', serviceWith([]));
  expect(await screen.findByText('No managed clusters')).toBeInTheDocument();
  expect(screen.getByText('No ManagedClusters are available.')).toBeInTheDocument();
});

it('shows the seeded clusters with status, provisioning and site', async () => {
  renderAt('/clusters', new MockConsoleService());
  const table = await screen.findByTestId('clusters-table');
  const sydney = within(table).getByRole('row', { name: /^site4 / });
  expect(sydney).toHaveTextContent('sydney');
  expect(sydney).toHaveTextContent('asia-pacific');
  expect(sydney).toHaveTextContent('Ready');
  expect(sydney).toHaveTextContent('Not provisioned');
  expect(within(table).getAllByText('Member')).toHaveLength(3);
});

it('hides write actions from a viewer', async () => {
  const service = new MockConsoleService({ username: 'viewer', groups: [], isProviderAdmin: false });
  renderAt('/clusters', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('viewer'));
  // site4 is both the name and the location, so find its row rather than the text.
  expect(await screen.findByRole('row', { name: /^site4 / })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add .* to AI Grid/ })).not.toBeInTheDocument();
});

it('shows the not-available state on a backend without the RPC', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  service.enrollCluster = async () => {
    throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
  };
  renderAt('/clusters', service);
  await user.click(await screen.findByRole('button', { name: 'Add site4 to AI Grid' }));
  expect(await screen.findByText('Unable to add site4 to AI Grid')).toBeInTheDocument();
  expect(screen.getByText('Adding clusters to AI Grid is not available on this backend yet.')).toBeInTheDocument();
});

it('paginates the list like the PoC', async () => {
  renderAt('/clusters', new MockConsoleService());
  expect(await screen.findByTestId('clusters-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(2);
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
  expect(row).toHaveTextContent('Not provisioned');
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
  expect(within(row).getByText('Unknown')).toBeInTheDocument();
  expect(within(row).getByText('Importing')).toBeInTheDocument();
  await user.hover(within(row).getByText('Unknown'));
  expect(await screen.findByText('Import of the managed cluster is in progress')).toBeInTheDocument();
});

it("doesn't offer Add to AI Grid for a member", async () => {
  renderAt('/clusters', new MockConsoleService());
  const member = await screen.findByRole('row', { name: /^site1 / });
  expect(within(member).queryByRole('button', { name: /Add .* to AI Grid/ })).not.toBeInTheDocument();
  expect(member).toHaveTextContent('AI Grid Member');
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
  for (const name of ['is-ready', 'is-offline', 'is-unknown']) {
    expect(screen.getByRole('button', { name: `Add ${name} to AI Grid` })).toBeInTheDocument();
  }
  for (const name of ['is-detaching', 'is-importfailed', 'is-notaccepted', 'is-pendingimport', 'is-importing']) {
    expect(screen.queryByRole('button', { name: `Add ${name} to AI Grid` })).not.toBeInTheDocument();
  }
});

it('wraps the headers and keeps Site, Region and Hub for wide screens only', async () => {
  renderAt('/clusters', serviceWith(hubClusters()));
  const table = await screen.findByTestId('clusters-table');
  for (const header of within(table).getAllByRole('columnheader')) {
    expect(header).toHaveClass('pf-m-wrap');
  }
  for (const name of ['Site', 'Region', 'Hub']) {
    expect(within(table).getByRole('columnheader', { name })).toHaveClass('pf-m-hidden', 'pf-m-visible-on-2xl');
  }
  expect(within(table).getByRole('columnheader', { name: 'OpenShift' })).not.toHaveClass('pf-m-hidden');
});
