import { test, expect } from '@playwright/test';
import configExample from '../../mock/examples/get-config.json' with { type: 'json' };
import userExample from '../../mock/examples/get-user.json' with { type: 'json' };

const datasource = {
  kind: 'Datasource',
  metadata: { name: 'prometheus', project: 'ai-grid' },
  spec: { default: true, plugin: { kind: 'PrometheusDatasource', spec: {} } },
};
const query = {
  kind: 'TimeSeriesQuery',
  spec: { plugin: { kind: 'PrometheusTimeSeriesQuery', spec: { query: 'compat_metric{cluster="$cluster"}' } } },
};
const dashboard = (name: string, title: string) => ({
  kind: 'Dashboard',
  metadata: { name, project: 'ai-grid' },
  spec: {
    display: { name: title },
    duration: '1h',
    refreshInterval: '0s',
    variables: [
      {
        kind: 'ListVariable',
        spec: {
          name: 'cluster',
          display: { name: 'Cluster' },
          allowMultiple: false,
          allowAllValue: false,
          defaultValue: 'site-a',
          plugin: { kind: 'PrometheusLabelValuesVariable', spec: { labelName: 'cluster' } },
        },
      },
    ],
    panels: {
      requests: {
        kind: 'Panel',
        spec: {
          display: { name: 'Requests' },
          plugin: {
            kind: 'StatChart',
            spec: { calculation: 'last-number', format: { unit: 'decimal' }, legendMode: 'off' },
          },
          queries: [query],
        },
      },
      latency: {
        kind: 'Panel',
        spec: { display: { name: 'Latency' }, plugin: { kind: 'TimeSeriesChart', spec: {} }, queries: [query] },
      },
    },
    layouts: [
      {
        kind: 'Grid',
        spec: {
          items: [
            { x: 0, y: 0, width: 8, height: 4, content: { $ref: '#/spec/panels/requests' } },
            { x: 8, y: 0, width: 16, height: 4, content: { $ref: '#/spec/panels/latency' } },
          ],
        },
      },
    ],
  },
});
const injectedFailure = 'Compatibility test injected failure';
const dashboards = [dashboard('dashboard-1-fleet', 'Fleet health'), dashboard('dashboard-2-usage', 'Token usage')];
// Each cluster's series counts up from its base over ten points, so the stat panel's last value
// is the base plus 9.
const seriesBase = { 'site-a': 42, 'site-b': 72 };
const points = 10;
const lastValue = (cluster: keyof typeof seriesBase) => String(seriesBase[cluster] + points - 1);

test('real Perses panels remain compatible with the shared Query runtime', async ({ page }) => {
  const errors: string[] = [];
  const queries: { query: string; start: string; end: string }[] = [];
  let userReads = 0;
  let responseStatus = 200;
  page.on('pageerror', (error) => errors.push('Uncaught: ' + error.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // The browser logs each 500 and 401 this test injects into a Perses query, and the query
    // layer logs the injected failure. Any other failed request still counts.
    const injected = /^Failed to load resource:.*(?:401|500)/.test(msg.text());
    if (injected && msg.location().url.includes('/perses/api/proxy/')) return;
    if (msg.text().includes(injectedFailure)) return;
    errors.push(msg.text());
  });
  const config = structuredClone(configExample.body);
  config.data.monitoring = { enabled: true, persesProject: 'ai-grid', extraDashboards: [] };
  config.data.fakeBackend = true;
  const user = userExample.body;
  await page.route('**/api/v1/user', (route) => {
    userReads++;
    return route.fulfill({ json: user });
  });
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: config }));
  await page.route('**/perses/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/dashboards')) return route.fulfill({ json: dashboards });
    if (url.pathname.includes('/api/v1/projects/ai-grid/datasources')) return route.fulfill({ json: [datasource] });
    if (url.pathname.includes('/api/v1/globaldatasources')) return route.fulfill({ json: [] });
    if (url.pathname.includes('/label/cluster/values'))
      return route.fulfill({ json: { status: 'success', data: ['site-a', 'site-b'] } });
    if (url.pathname.endsWith('/api/v1/query_range') || url.pathname.endsWith('/api/v1/query')) {
      const params = request.method() === 'POST' ? new URLSearchParams(request.postData() || '') : url.searchParams;
      queries.push({
        query: params.get('query') ?? '',
        start: params.get('start') ?? '',
        end: params.get('end') ?? '',
      });
      if (responseStatus !== 200)
        return route.fulfill({
          status: responseStatus,
          json: { status: 'error', errorType: 'server_error', error: injectedFailure },
        });
      const start = Number(params.get('start')) || Date.now() / 1000 - 3600;
      const end = Number(params.get('end')) || Date.now() / 1000;
      const selected = (params.get('query') || '').includes('site-b') ? 'site-b' : 'site-a';
      const result = {
        metric: { __name__: 'compat_metric', cluster: selected },
        values: Array.from({ length: points }, (_, i) => [
          start + ((end - start) * i) / (points - 1),
          String(seriesBase[selected] + i),
        ]),
      };
      return route.fulfill({ json: { status: 'success', data: { resultType: 'matrix', result: [result] } } });
    }
    errors.push(`Unhandled fixture: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { message: 'No fixture' } });
  });
  const refresh = page.getByRole('button', { name: /Refresh/ });

  await test.step('renders the stat and time-series panels', async () => {
    await page.goto('/monitoring');
    await expect(page.getByRole('tab', { name: 'Fleet health' })).toBeVisible();
    await expect.poll(() => queries.length).toBeGreaterThan(0);
    await expect(page.getByText('Requests', { exact: true })).toBeVisible();
    await expect(page.getByText('Latency', { exact: true })).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
  });

  await test.step('a variable change queries again', async () => {
    await page.getByRole('combobox', { name: 'Cluster', exact: true }).click();
    await page.getByRole('option', { name: 'site-b', exact: true }).click();
    await expect.poll(() => queries.some((q) => q.query.includes('site-b'))).toBe(true);
    await expect(page.getByText(lastValue('site-b'), { exact: true })).toBeVisible();
  });

  await test.step('a time range change and a manual refresh query again', async () => {
    let before = queries.length;
    await page.getByRole('combobox', { name: /Select time range/ }).click();
    await page.getByRole('option', { name: 'Last 6 hours', exact: true }).click();
    // A closed menu that stays mounted takes the next click (CI run 40586365237).
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect.poll(() => queries.length).toBeGreaterThan(before);
    await expect
      .poll(() => Math.round(Number(queries[queries.length - 1].end) - Number(queries[queries.length - 1].start)))
      .toBe(21600);
    before = queries.length;
    await refresh.click();
    await expect.poll(() => queries.length).toBeGreaterThan(before);
  });

  await test.step('tabs and the dark theme render the panels', async () => {
    await page.getByRole('tab', { name: 'Token usage', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Token usage', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Fleet health', exact: true }).click();
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/pf-v6-theme-dark/);
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  await test.step('the refresh interval from the URL queries again', async () => {
    await page.goto('/monitoring?refresh=1s');
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
    const before = queries.length;
    await expect.poll(() => queries.length).toBeGreaterThan(before);
    await page.goto('/monitoring?refresh=0s');
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
    expect(errors.splice(0)).toEqual([]);
  });

  await test.step('a failed query shows its error and recovers', async () => {
    responseStatus = 500;
    const before = queries.length;
    await refresh.click();
    await expect.poll(() => queries.length).toBeGreaterThan(before);
    await expect(page.getByText(injectedFailure).first()).toBeVisible();
    responseStatus = 200;
    await refresh.click();
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
    await expect(page.getByText(injectedFailure)).toHaveCount(0);
  });

  await test.step('a 401 checks the session and recovers', async () => {
    responseStatus = 401;
    const userBefore = userReads;
    await refresh.click();
    await expect.poll(() => userReads).toBeGreaterThan(userBefore);
    await expect(page.getByRole('tab', { name: 'Fleet health' })).toBeVisible();
    responseStatus = 200;
    await refresh.click();
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
  });

  expect(errors).toEqual([]);
});
