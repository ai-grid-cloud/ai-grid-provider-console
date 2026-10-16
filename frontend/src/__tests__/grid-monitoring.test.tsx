// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/grid.test.tsx at 62319b8 (the monitoring cases).
// The PoC's tenants become the fixture organizations acme-robotics and globex-research, and its demo
// clusters demo-san-francisco and demo-new-york become the fixture clusters site1 and site2.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MockConsoleService, seedOrganizations } from '../api/MockConsoleService';
import { serviceOnPr12Json } from './pr12Json';
import { renderAt } from './render';

/** The mock with the PoC test's two organizations. */
const withOrganizations = () => {
  const service = new MockConsoleService();
  service.organizations = seedOrganizations().filter((o) => ['acme-robotics', 'globex-research'].includes(o.name));
  return service;
};

it('labels metric simulation independently of real backend inventory in Monitoring', async () => {
  const service = withOrganizations();
  const value = await service.getGridOverview('1h');
  vi.spyOn(service, 'getGridOverview').mockResolvedValue({
    ...value,
    demo: false,
    inventorySource: 'git',
    metricsSource: 'demo',
  });
  renderAt('/monitoring', service);
  expect(await screen.findByText('Simulated monitoring metrics')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'GPU utilization' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Gateway request rate' })).toBeVisible();
});

it('updates monitoring chart windows through time controls', async () => {
  const service = withOrganizations();
  const query = vi.spyOn(service, 'getGridOverview');
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  const chart = await screen.findByRole('img', { name: 'Gateway request rate over time' });
  expect(Number(chart.getAttribute('data-end')) - Number(chart.getAttribute('data-start'))).toBe(3600);
  await user.click(within(screen.getByRole('group', { name: 'Time range' })).getByRole('button', { name: 'Last 24h' }));
  await waitFor(() => {
    const c = screen.getByRole('img', { name: 'Gateway request rate over time' });
    expect(Number(c.getAttribute('data-end')) - Number(c.getAttribute('data-start'))).toBe(86400);
  });
  expect(screen.queryByRole('combobox', { name: 'Filter by site' })).not.toBeInTheDocument();
  expect(query).toHaveBeenCalledWith('24h');
});

it('provides reference-style tabs, expandable chart sections, and a working model selector', async () => {
  const service = withOrganizations();
  const models = await service.listModels();
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'GPU utilization over time' });
  expect(screen.getByRole('heading', { name: 'Observability dashboard' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cluster resource overview' }));
  expect(screen.queryByRole('img', { name: 'GPU utilization over time' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Usage' }));
  expect(await screen.findByRole('img', { name: 'Token consumption by organization' })).toBeVisible();
  const usage = screen.getByRole('table', { name: 'Organization usage' });
  expect(within(usage).getByText('acme-robotics', { selector: 'td' })).toBeVisible();
  expect(within(usage).getByText('globex-research', { selector: 'td' })).toBeVisible();
  expect(screen.queryByText('NorthSummit Bank')).not.toBeInTheDocument();
  expect(
    screen.getByRole('img', { name: 'Token consumption by organization' }).querySelectorAll('[data-kind="cached"]'),
  ).toHaveLength(2);
  expect(screen.queryByText('Quota utilization')).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Quota used' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Models' }));
  const selector = screen.getByRole('combobox', { name: 'Select model deployment' });
  await user.selectOptions(selector, models[0].name);
  expect(within(screen.getByRole('table', { name: 'Model deployments' })).getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('img', { name: 'Request queue length over time' })).toBeVisible();
  expect(screen.getByRole('img', { name: 'P90 Time to first token (TTFT) over time' })).toBeVisible();
  expect(screen.queryByRole('tab', { name: 'Gateway' })).not.toBeInTheDocument();
});

it('shows all sites without a selector and recalculates overview totals for the time window', async () => {
  const service = withOrganizations();
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  const overview = () => screen.getByText('Requests in window').closest('.observability-stat-card')!.textContent;
  const first = overview();
  await user.click(screen.getByRole('button', { name: 'Last 24h' }));
  await waitFor(() => expect(overview()).not.toBe(first));
  expect(screen.queryByRole('combobox', { name: 'Filter by site' })).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'San Francisco' })).toBeVisible();
  expect(screen.getByRole('cell', { name: 'New York' })).toBeVisible();
});

it('changes simulated model charts with model selection and organization usage with the time window', async () => {
  const service = withOrganizations();
  const models = await service.listModels();
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  await user.click(screen.getByRole('tab', { name: 'Models' }));
  const queue = () =>
    screen.getByRole('img', { name: 'Request queue length over time' }).querySelector('path')!.getAttribute('d');
  const all = queue();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Select model deployment' }), models[0].name);
  expect(queue()).not.toBe(all);
  await user.click(screen.getByRole('tab', { name: 'Usage' }));
  const chart = () => screen.getByRole('img', { name: 'Token consumption by organization' });
  const before = screen.getByRole('table', { name: 'Organization usage' }).textContent;
  const beforeHeight = chart().querySelector('[data-kind="input"]')!.getAttribute('height');
  await user.click(screen.getByRole('button', { name: 'Last 6h' }));
  await waitFor(() => expect(screen.getByRole('table', { name: 'Organization usage' }).textContent).not.toBe(before));
  expect(chart()).toBeVisible();
  expect(chart().querySelector('[data-kind="input"]')!.getAttribute('height')).not.toBe(beforeHeight);
  expect(screen.getByText(/Total consumption:.*Last 6h/)).toBeVisible();
});

it('asks for the overview once per load: the metrics answer carries the clusters', async () => {
  const service = withOrganizations();
  const query = vi.spyOn(service, 'getGridOverview');
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  expect(screen.getByRole('cell', { name: 'San Francisco' })).toBeVisible();
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith('1h');
});

it('never shows a late answer for an earlier range as the current one', async () => {
  const service = withOrganizations();
  const overview = service.getGridOverview;
  let releaseHour = () => {};
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  // The next 1h answer is held back until after the 24h one has arrived.
  vi.spyOn(service, 'getGridOverview').mockImplementation(async (range, opts) => {
    if (range === '1h' && opts === undefined) {
      await new Promise<void>((resolve) => (releaseHour = resolve));
    }
    return overview(range, opts);
  });
  await user.click(screen.getByRole('button', { name: 'Last 6h' }));
  await user.click(screen.getByRole('button', { name: 'Last 1h' }));
  await user.click(screen.getByRole('button', { name: 'Last 24h' }));
  const span = () => {
    const c = screen.getByRole('img', { name: 'Gateway request rate over time' });
    return Number(c.getAttribute('data-end')) - Number(c.getAttribute('data-start'));
  };
  await waitFor(() => expect(span()).toBe(86400));
  releaseHour();
  // The late answer makes the page ask again for 24h instead of showing the 1h window.
  await waitFor(() => expect(service.getGridOverview).toHaveBeenCalledTimes(4));
  expect(service.getGridOverview).toHaveBeenLastCalledWith('24h');
  await waitFor(() => expect(span()).toBe(86400));
});

it('loads organization usage when opened from the map', async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid', withOrganizations());
  await user.click(await screen.findByRole('link', { name: 'View monitoring' }));
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  await user.click(screen.getByRole('tab', { name: 'Usage' }));
  const usage = await screen.findByRole('table', { name: 'Organization usage' });
  expect(within(usage).getByText('acme-robotics', { selector: 'td' })).toBeVisible();
});

it("lists PR 12's models with their target sites", async () => {
  const user = userEvent.setup();
  renderAt('/monitoring', serviceOnPr12Json());
  await user.click(await screen.findByRole('tab', { name: 'Models' }));
  const table = screen.getByRole('table', { name: 'Model deployments' });
  const granite = within(table).getByText('Granite 8B Instruct').closest('tr')!;
  expect(granite).toHaveTextContent('Paris DC1');
});
