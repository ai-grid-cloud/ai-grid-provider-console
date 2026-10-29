// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/grid.test.tsx at 62319b8 (the monitoring cases).
// The PoC's tenants become the fixture organizations acme-robotics and globex-research, and its demo
// clusters demo-san-francisco and demo-new-york become the fixture clusters site1 and site2.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceError } from '../api/ConsoleService';
import { MockConsoleService, seedOrganizations } from '../api/MockConsoleService';
import { serviceOnBffExamples } from './bffExamples';
import { renderAt } from './render';
import { modelsOf } from './connectModels';
import { titleOf, toModelView } from '../pages/models/modelView';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/grid/GridPage';
import '../pages/monitoring/MonitoringPage';

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
  expect(await screen.findByText('Sample metrics')).toBeVisible();
  // Each chart's title carries its unit.
  expect(screen.getByRole('heading', { name: 'GPU utilization (%)' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Gateway request rate (req/s)' })).toBeVisible();
});

it('updates monitoring chart windows through time controls', async () => {
  const service = withOrganizations();
  const query = vi.spyOn(service, 'getGridOverview');
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  const chart = await screen.findByRole('img', { name: 'Gateway request rate over time' });
  expect(Number(chart.getAttribute('data-end')) - Number(chart.getAttribute('data-start'))).toBe(3600);
  await user.click(
    within(screen.getByRole('group', { name: 'Time range' })).getByRole('button', { name: 'Last 24 hours' }),
  );
  await waitFor(() => {
    const c = screen.getByRole('img', { name: 'Gateway request rate over time' });
    expect(Number(c.getAttribute('data-end')) - Number(c.getAttribute('data-start'))).toBe(86400);
  });
  expect(screen.queryByRole('combobox', { name: 'Filter by site' })).not.toBeInTheDocument();
  expect(query).toHaveBeenCalledWith('24h');
});

it('provides Clusters, Models and Usage tabs, plain section headings, and a working model selector', async () => {
  const service = withOrganizations();
  const models = modelsOf(service).models.map(toModelView);
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'GPU utilization over time' });
  expect(screen.getByRole('heading', { name: 'Monitoring', level: 1 })).toBeVisible();
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Clusters', 'Models', 'Usage']);
  expect(screen.getByRole('heading', { name: 'Cluster resources' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Cluster resources' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Usage' }));
  expect(await screen.findByRole('img', { name: 'Token consumption by organization' })).toBeVisible();
  const usage = screen.getByRole('grid', { name: 'Organization usage' });
  expect(within(usage).getByRole('link', { name: 'acme-robotics' })).toBeVisible();
  expect(within(usage).getByRole('link', { name: 'globex-research' })).toBeVisible();
  expect(screen.queryByText('NorthSummit Bank')).not.toBeInTheDocument();
  expect(
    screen.getByRole('img', { name: 'Token consumption by organization' }).querySelectorAll('[data-kind="cached"]'),
  ).toHaveLength(2);
  expect(screen.queryByText('Quota utilization')).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Quota used' })).not.toBeInTheDocument();
  // No raw organization IDs; the names link to the organizations.
  expect(screen.queryByRole('columnheader', { name: 'Organization ID' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Models' }));
  await user.click(screen.getByRole('combobox', { name: 'Select model' }));
  await user.click(screen.getByRole('option', { name: titleOf(models[0]) }));
  expect(within(screen.getByRole('grid', { name: 'Models' })).getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('img', { name: 'Request queue length over time' })).toBeVisible();
  expect(screen.getByRole('img', { name: 'P90 Time to first token (TTFT) over time' })).toBeVisible();
  expect(screen.queryByRole('tab', { name: 'Gateway' })).not.toBeInTheDocument();
});

it('shows all sites without a selector and recalculates overview totals for the time window', async () => {
  const service = withOrganizations();
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  const overview = () => screen.getByText('Requests').closest('.pf-v6-c-card')!.textContent;
  const first = overview();
  await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
  await waitFor(() => expect(overview()).not.toBe(first));
  expect(screen.queryByRole('combobox', { name: 'Filter by site' })).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'San Francisco' })).toBeVisible();
  expect(screen.getByRole('cell', { name: 'New York' })).toBeVisible();
});

it('shows the request count in the window as a whole number', async () => {
  const service = withOrganizations();
  const value = await service.getGridOverview('1h');
  const points = [
    { timestamp: 0, value: 1.1 },
    { timestamp: 3, value: 1.1 },
  ];
  vi.spyOn(service, 'getGridOverview').mockResolvedValue({
    ...value,
    metrics: value.metrics.map((m) => (m.key === 'requests' ? { ...m, status: 'ok' as const, points } : m)),
  });
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  const card = screen.getByText('Requests').closest('.pf-v6-c-card')!;
  expect(card.textContent).toBe('Requests3');
});

it('changes simulated model charts with model selection and organization usage with the time window', async () => {
  const service = withOrganizations();
  const models = modelsOf(service).models.map(toModelView);
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  await user.click(screen.getByRole('tab', { name: 'Models' }));
  const queue = () =>
    screen.getByRole('img', { name: 'Request queue length over time' }).querySelector('path')!.getAttribute('d');
  const all = queue();
  await user.click(screen.getByRole('combobox', { name: 'Select model' }));
  await user.click(screen.getByRole('option', { name: titleOf(models[0]) }));
  expect(queue()).not.toBe(all);
  await user.click(screen.getByRole('tab', { name: 'Usage' }));
  const chart = () => screen.getByRole('img', { name: 'Token consumption by organization' });
  const before = screen.getByRole('grid', { name: 'Organization usage' }).textContent;
  const beforeWidth = chart().querySelector('[data-kind="input"]')!.getAttribute('width');
  await user.click(screen.getByRole('button', { name: 'Last 6 hours' }));
  await waitFor(() => expect(screen.getByRole('grid', { name: 'Organization usage' }).textContent).not.toBe(before));
  expect(chart()).toBeVisible();
  expect(chart().querySelector('[data-kind="input"]')!.getAttribute('width')).not.toBe(beforeWidth);
  expect(screen.getByText(/tokens in the last 6h$/)).toBeVisible();
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
  await user.click(screen.getByRole('button', { name: 'Last 6 hours' }));
  await user.click(screen.getByRole('button', { name: 'Last hour' }));
  await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
  const span = () => {
    const c = screen.getByRole('img', { name: 'Gateway request rate over time' });
    return Number(c.getAttribute('data-end')) - Number(c.getAttribute('data-start'));
  };
  await waitFor(() => expect(span()).toBe(86400));
  await act(async () => releaseHour());
  // The late answer is dropped: the 24h window stays, and the page has no reason to ask again.
  expect(span()).toBe(86400);
  expect(service.getGridOverview).toHaveBeenCalledTimes(3);
  expect(service.getGridOverview).toHaveBeenLastCalledWith('24h');
});

it('loads organization usage when opened from the map', async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid', withOrganizations());
  await user.click(await screen.findByRole('link', { name: 'View monitoring' }));
  await screen.findByRole('img', { name: 'Gateway request rate over time' });
  await user.click(screen.getByRole('tab', { name: 'Usage' }));
  const usage = await screen.findByRole('grid', { name: 'Organization usage' });
  expect(within(usage).getByRole('link', { name: 'acme-robotics' })).toBeVisible();
});

it('lists the models with the sites their placement chose', async () => {
  const user = userEvent.setup();
  const service = serviceOnBffExamples();
  // A model of the Models API placed at the example clusters' location (status.placement.locations).
  const granite = modelsOf(service).find('granite-3-8b');
  granite.metadata!.annotations['openshift.io/display-name'] = 'Granite 8B Instruct';
  granite.status!.placement!.locations = ['paris'];
  renderAt('/monitoring', service);
  await user.click(await screen.findByRole('tab', { name: 'Models' }));
  const table = screen.getByRole('grid', { name: 'Models' });
  // The Models page's words: the name shown, then the model users request.
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['Name', 'Model', 'Target sites', 'Replicas', 'Status']);
  const row = within(table).getByText('Granite 8B Instruct').closest('tr')!;
  expect(row).toHaveTextContent('Paris DC1');
});

it('explains the target sites in a help popover', async () => {
  const user = userEvent.setup();
  renderAt('/monitoring', withOrganizations());
  await user.click(await screen.findByRole('tab', { name: 'Models' }));
  await user.click(screen.getByRole('button', { name: 'More about models' }));
  expect(
    await screen.findByText(/^Target sites are the sites of the clusters selected for each model\./),
  ).toBeVisible();
});

it('does not name Thanos when the backend reports no metrics source', async () => {
  const service = withOrganizations();
  const value = await service.getGridOverview('1h');
  vi.spyOn(service, 'getGridOverview').mockResolvedValue({ ...value, demo: false, metricsSource: undefined });
  renderAt('/monitoring', service);
  expect(await screen.findByRole('img', { name: 'Gateway request rate over time' })).toBeVisible();
  expect(screen.queryByText(/Thanos/)).not.toBeInTheDocument();
});

it('names the clusters table', async () => {
  renderAt('/monitoring', withOrganizations());
  expect(await screen.findByRole('grid', { name: 'Clusters' })).toBeVisible();
});

it('drops the dashboard for the not-available page when a later answer is 501', async () => {
  const service = withOrganizations();
  const serve = service.getGridOverview.bind(service);
  vi.spyOn(service, 'getGridOverview')
    .mockImplementationOnce(serve)
    .mockRejectedValue(new ServiceError(501, 'The AI Grid backend does not support this operation.'));
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  expect(await screen.findByRole('grid', { name: 'Clusters' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Last 6 hours' }));
  expect(
    await screen.findByRole('heading', { name: 'Monitoring is not available on this AI Grid backend' }),
  ).toBeVisible();
  expect(screen.queryByRole('grid', { name: 'Clusters' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Last 24 hours' })).not.toBeInTheDocument();
});

it('names a failed overview for what it is, hides its controls and offers Retry', async () => {
  const service = withOrganizations();
  const serve = service.getGridOverview.bind(service);
  const overview = vi
    .spyOn(service, 'getGridOverview')
    .mockRejectedValueOnce(new ServiceError(503, 'Service unavailable.'))
    .mockImplementation(serve);
  const user = userEvent.setup();
  renderAt('/monitoring', service);
  expect(await screen.findByRole('heading', { name: 'Unable to load metrics' })).toBeVisible();
  expect(screen.queryByText(/AI Grid clusters/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Last 6 hours' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('grid', { name: 'Clusters' })).toBeVisible();
  expect(overview).toHaveBeenCalledTimes(2);
});

it('keeps its header while the console settings load', async () => {
  const service = withOrganizations();
  service.getConfig = () => new Promise(() => undefined);
  renderAt('/monitoring', service);
  expect(await screen.findByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
  expect(screen.getByRole('progressbar', { name: 'Loading monitoring' })).toBeVisible();
});

it('shows the not-available page, like Models, when the backend has no overview', async () => {
  const service = withOrganizations();
  const overview = vi
    .spyOn(service, 'getGridOverview')
    .mockRejectedValue(new ServiceError(501, 'The AI Grid backend does not support this operation.'));
  const clusters = vi.spyOn(service, 'listClusters');
  renderAt('/monitoring', service);
  expect(
    await screen.findByRole('heading', { name: 'Monitoring is not available on this AI Grid backend' }),
  ).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
  // No tabs, no time range and nothing to refresh.
  expect(screen.queryByRole('grid', { name: 'Clusters' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Last 6 hours' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  // One request: the not-available answer isn't asked again for a range, and the Clusters list isn't
  // asked at all. A refetch would start in the effects of the render above; flush them.
  await act(async () => {});
  expect(overview).toHaveBeenCalledTimes(1);
  expect(clusters).not.toHaveBeenCalled();
});
