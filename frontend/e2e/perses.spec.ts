import { expect, test } from './fixtures';
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
            { x: 0, y: 0, width: 8, height: 8, content: { $ref: '#/spec/panels/requests' } },
            { x: 8, y: 0, width: 16, height: 8, content: { $ref: '#/spec/panels/latency' } },
          ],
        },
      },
    ],
  },
});
const injectedFailure = 'Compatibility test injected failure';
// The relay's own answer when Perses is slower than PERSES_TIMEOUT, in the shape the BFF sends
// (bff/internal/perses, writeError): Perses's own {"message": "..."}.
const relayTimeout = "the hub's Perses did not answer in time";
const dashboards = [
  dashboard('dashboard-1-fleet-admin', 'Fleet health'),
  dashboard('dashboard-2-usage-admin', 'Token usage'),
];
// Each cluster's series counts up from its base to the base plus 9 over the queried range, so the
// stat panel's last value is the base plus 9. One sample per step from the first step boundary, as
// Prometheus answers: Perses places samples on the query's steps, and a step without one is a gap.
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
    // The browser logs each 500, 504 and 401 this test injects into a Perses query, and the query
    // layer logs the injected failure. Any other failed request still counts.
    const injected = /^Failed to load resource:.*(?:401|500|504)/.test(msg.text());
    if (injected && msg.location().url.includes('/perses/api/proxy/')) return;
    if (msg.text().includes(injectedFailure) || msg.text().includes(relayTimeout)) return;
    errors.push(msg.text());
  });
  const config = structuredClone(configExample.body);
  config.data.monitoring = { enabled: true, persesProject: 'ai-grid' };
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
      if (responseStatus === 504) return route.fulfill({ status: 504, json: { message: relayTimeout } });
      if (responseStatus !== 200)
        return route.fulfill({
          status: responseStatus,
          json: { status: 'error', errorType: 'server_error', error: injectedFailure },
        });
      const start = Number(params.get('start')) || Date.now() / 1000 - 3600;
      const end = Number(params.get('end')) || Date.now() / 1000;
      const step = Number(params.get('step')) || 60;
      const first = Math.ceil(start / step) * step;
      const samples = Math.max(1, Math.floor((end - first) / step) + 1);
      const selected = (params.get('query') || '').includes('site-b') ? 'site-b' : 'site-a';
      const result = {
        metric: { __name__: 'compat_metric', cluster: selected },
        values: Array.from({ length: samples }, (_, i) => [
          first + i * step,
          String(seriesBase[selected] + Math.round(((points - 1) * i) / Math.max(1, samples - 1))),
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

  await test.step('hovering the time series shows its tooltip', async () => {
    // Perses finds the series near the cursor from ECharts' y axis scale (TimeSeriesTooltip's
    // nearby-series), which reads that scale's internals: a new ECharts can leave the tooltip empty.
    await page.getByRole('region', { name: 'Latency' }).locator('canvas').hover();
    await expect(page.getByLabel(/series showing (as bold )?in tooltip/).first()).toContainText('compat_metric');
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

  await test.step("the relay's timeout shows its message, not [object Object]", async () => {
    responseStatus = 504;
    const before = queries.length;
    await refresh.click();
    await expect.poll(() => queries.length).toBeGreaterThan(before);
    await expect(page.getByText(relayTimeout).first()).toBeVisible();
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    responseStatus = 200;
    await refresh.click();
    await expect(page.getByText(lastValue('site-a'), { exact: true })).toBeVisible();
    await expect(page.getByText(relayTimeout)).toHaveCount(0);
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

// The AI grid cluster dashboard's shape (ai-grid-cluster-gitops
// apps/ai-grid-o11y/manifests/perses-dashboard-cluster.yaml): a multi-select cluster variable with
// All, and hidden CLUSTER_DETAILS_* text variables that its Markdown panel prints in a PatternFly
// horizontal description list, written as HTML with PatternFly's classes.
const detailNames = ['INFRASTRUCTURE_PROVIDER', 'OPENSHIFT_VERSION', 'CHANNEL', 'API_SERVER'];
const detailsMarkup = [
  '<dl class="pf-v6-c-description-list pf-m-auto-column-widths pf-m-horizontal">',
  ...detailNames.map(
    (name) =>
      `<div class="pf-v6-c-description-list__group"><dt class="pf-v6-c-description-list__term"><span class="pf-v6-c-description-list__text">${name}</span></dt><dd class="pf-v6-c-description-list__description"><div class="pf-v6-c-description-list__text">\${CLUSTER_DETAILS_${name}}</div></dd></div>`,
  ),
  '</dl>',
].join('\n');
const clusterDashboard = {
  kind: 'Dashboard',
  metadata: { name: 'dashboard-0-cluster-admin', project: 'ai-grid' },
  spec: {
    display: { name: 'Cluster' },
    duration: '1h',
    refreshInterval: '0s',
    variables: [
      {
        kind: 'ListVariable',
        spec: {
          name: 'cluster_name',
          display: { name: 'Cluster' },
          allowMultiple: true,
          allowAllValue: true,
          customAllValue: '.*',
          defaultValue: '$__all',
          plugin: { kind: 'PrometheusLabelValuesVariable', spec: { labelName: 'cluster' } },
        },
      },
      ...detailNames.map((name) => ({
        kind: 'TextVariable',
        spec: { name: `CLUSTER_DETAILS_${name}`, value: 'N/A', display: { name, hidden: true } },
      })),
    ],
    panels: {
      details: {
        kind: 'Panel',
        spec: {
          display: { name: 'Cluster details' },
          plugin: {
            kind: 'Markdown',
            spec: { text: detailsMarkup },
          },
        },
      },
    },
    layouts: [
      {
        kind: 'Grid',
        spec: { items: [{ x: 0, y: 0, width: 24, height: 6, content: { $ref: '#/spec/panels/details' } }] },
      },
    ],
  },
};

test("fills in the cluster details panel from the selected cluster's claims", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push('Uncaught: ' + error.message));
  const config = structuredClone(configExample.body);
  config.data.monitoring = { enabled: true, persesProject: 'ai-grid' };
  await page.route('**/api/v1/user', (route) => route.fulfill({ json: userExample.body }));
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: config }));
  // Clusters/List over Connect, as the backend answers it: site-a with the claims ACM writes.
  const claim = (name: string, value: string) => ({ name, value });
  await page.route('**/ai_grid.v1.Clusters/List**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'site-a',
            status: {
              clusterClaims: [
                claim('platform.open-cluster-management.io', 'AWS'),
                claim('version.openshift.io', '4.21.36'),
                claim('apiserverurl.openshift.io', 'https://api.site-a.example.com:6443'),
              ],
            },
          },
        ],
        size: 1,
        total: 1,
      },
    }),
  );
  await page.route('**/perses/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/dashboards')) return route.fulfill({ json: [clusterDashboard] });
    if (url.pathname.includes('/api/v1/projects/ai-grid/datasources')) return route.fulfill({ json: [datasource] });
    if (url.pathname.includes('/api/v1/globaldatasources')) return route.fulfill({ json: [] });
    if (url.pathname.includes('/label/cluster/values'))
      return route.fulfill({ json: { status: 'success', data: ['site-a', 'site-b'] } });
    errors.push(`Unhandled fixture: ${route.request().method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { message: 'No fixture' } });
  });

  // The details list's term and value of a detail.
  const detail = (name: string) => {
    const group = page.locator('.pf-v6-c-description-list__group').filter({ hasText: name });
    return { term: group.locator('dt'), value: group.locator('dd') };
  };

  // Opened directly: no other page has loaded PatternFly's description list styles first.
  await page.goto('/monitoring');
  for (const name of detailNames) {
    await expect(detail(name).value).toHaveText('Select one cluster');
  }
  await test.step('the details are laid out as a horizontal description list', async () => {
    await expect(page.locator('dl.pf-v6-c-description-list')).toHaveCSS('display', 'grid');
    for (const name of detailNames) {
      const term = await detail(name).term.boundingBox();
      const value = await detail(name).value.boundingBox();
      expect(term && value && value.x > term.x + term.width && Math.abs(value.y - term.y) < 4).toBe(true);
    }
  });

  await page.goto('/monitoring?var-cluster_name=site-a');
  await expect(detail('INFRASTRUCTURE_PROVIDER').value).toHaveText('AWS');
  await expect(detail('OPENSHIFT_VERSION').value).toHaveText('4.21.36');
  await expect(detail('CHANNEL').value).toHaveText('Not available');
  await expect(detail('API_SERVER').value).toHaveText('https://api.site-a.example.com:6443');
  expect(errors).toEqual([]);
});

// A bar chart as the AI grid model dashboard's "Response time distribution" draws one: a bar per
// series, named from a label value, which here holds characters HTML gives a meaning to.
const bucketName = '<b>p99</b> & Fast <1s';
const barDashboard = {
  kind: 'Dashboard',
  metadata: { name: 'dashboard-1-model-admin', project: 'ai-grid' },
  spec: {
    display: { name: 'Model' },
    duration: '1h',
    refreshInterval: '0s',
    variables: [],
    panels: {
      latency: {
        kind: 'Panel',
        spec: {
          display: { name: 'Response time distribution' },
          plugin: { kind: 'BarChart', spec: { calculation: 'last', sort: 'asc' } },
          queries: [
            {
              kind: 'TimeSeriesQuery',
              spec: {
                plugin: {
                  kind: 'PrometheusTimeSeriesQuery',
                  spec: { query: 'latency_requests', seriesNameFormat: '{{bucket}}' },
                },
              },
            },
          ],
        },
      },
    },
    layouts: [
      {
        kind: 'Grid',
        spec: { items: [{ x: 0, y: 0, width: 24, height: 8, content: { $ref: '#/spec/panels/latency' } }] },
      },
    ],
  },
};

test('draws a bar chart, and shows a bar name in its tooltip as written', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push('Uncaught: ' + error.message));
  const config = structuredClone(configExample.body);
  config.data.monitoring = { enabled: true, persesProject: 'ai-grid' };
  await page.route('**/api/v1/user', (route) => route.fulfill({ json: userExample.body }));
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: config }));
  await page.route('**/perses/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/dashboards')) return route.fulfill({ json: [barDashboard] });
    if (url.pathname.includes('/api/v1/projects/ai-grid/datasources')) return route.fulfill({ json: [datasource] });
    if (url.pathname.includes('/api/v1/globaldatasources')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/api/v1/query_range')) {
      const params = request.method() === 'POST' ? new URLSearchParams(request.postData() || '') : url.searchParams;
      const end = Number(params.get('end')) || Date.now() / 1000;
      const result = {
        metric: { __name__: 'latency_requests', bucket: bucketName },
        values: [
          [end - 60, '40'],
          [end, '42'],
        ],
      };
      return route.fulfill({ json: { status: 'success', data: { resultType: 'matrix', result: [result] } } });
    }
    errors.push(`Unhandled fixture: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { message: 'No fixture' } });
  });

  await page.goto('/monitoring');
  await expect(page.getByText('Response time distribution', { exact: true })).toBeVisible();
  const chart = page.locator('canvas').first();
  await expect(chart).toBeVisible();
  // The one bar ends up across the middle of the chart, but ECharts grows it from zero: move over the
  // middle until the bar is under the pointer and its tooltip shows.
  const box = (await chart.boundingBox())!;
  const tooltip = page.getByText(bucketName, { exact: true });
  let nudge = 0;
  await expect
    .poll(async () => {
      nudge = 1 - nudge;
      await page.mouse.move(box.x + box.width / 2 + nudge, box.y + box.height / 2);
      return tooltip.isVisible();
    })
    .toBe(true);
  // The name's own <b> is text, not an element of the tooltip.
  await expect(page.locator('b').getByText('p99', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// A panel whose plugin the console doesn't bundle (persesPlugins.ts), as cluster 1's Models dashboard
// had with a BarChart. Perses's panel loads its plugin with throwOnError, so the panel shows the
// load error. When that option doesn't reach TanStack Query (Perses 0.56.0-beta.0 passes v4's
// useErrorBoundary, which v5 ignores), PanelContent mounts PanelPluginLoader, whose observer refetches
// the failed plugin on mount, which shows PanelContent's skeleton and unmounts it, and so on: the
// panel never leaves its skeleton, and the loop keeps the page's main thread busy.
test('a panel whose plugin is not bundled shows the load error, and the tabs still switch', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push('Uncaught: ' + error.message));
  const models = dashboard('dashboard-2-models-admin', 'Models');
  const [grid] = models.spec.layouts;
  const unbundled = {
    ...models,
    spec: {
      ...models.spec,
      panels: {
        ...models.spec.panels,
        distribution: {
          kind: 'Panel',
          spec: { display: { name: 'Distribution' }, plugin: { kind: 'NotBundledChart', spec: {} }, queries: [query] },
        },
      },
      layouts: [
        {
          ...grid,
          spec: {
            items: [
              ...grid.spec.items,
              { x: 0, y: 8, width: 24, height: 8, content: { $ref: '#/spec/panels/distribution' } },
            ],
          },
        },
      ],
    },
  };
  const config = structuredClone(configExample.body);
  config.data.monitoring = { enabled: true, persesProject: 'ai-grid' };
  config.data.fakeBackend = true;
  await page.route('**/api/v1/user', (route) => route.fulfill({ json: userExample.body }));
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: config }));
  await page.route('**/perses/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/dashboards'))
      return route.fulfill({ json: [dashboard('dashboard-1-fleet-admin', 'Fleet health'), unbundled] });
    if (url.pathname.includes('/api/v1/projects/ai-grid/datasources')) return route.fulfill({ json: [datasource] });
    if (url.pathname.includes('/api/v1/globaldatasources')) return route.fulfill({ json: [] });
    if (url.pathname.includes('/label/cluster/values'))
      return route.fulfill({ json: { status: 'success', data: ['site-a', 'site-b'] } });
    if (url.pathname.endsWith('/api/v1/query_range') || url.pathname.endsWith('/api/v1/query')) {
      const now = Math.floor(Date.now() / 1000);
      const result = { metric: { __name__: 'compat_metric', cluster: 'site-a' }, values: [[now, '42']] };
      return route.fulfill({ json: { status: 'success', data: { resultType: 'matrix', result: [result] } } });
    }
    errors.push(`Unhandled fixture: ${route.request().method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { message: 'No fixture' } });
  });

  await page.goto('/monitoring');
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  const distribution = page.getByRole('region', { name: 'Distribution' });
  await expect(distribution.getByText("A NotBundledChart plugin for kind 'Panel' is not installed")).toBeVisible();
  await expect(distribution.getByLabel('Loading...')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Requests' }).getByText('42', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Fleet health', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Fleet health', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Requests' }).getByText('42', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Distribution' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// A variable whose values the dashboard lists itself (StaticListVariable), as cluster 1's Usage
// dashboard's view_by. Without its plugin in persesPlugins.ts the select shows no values. The
// options show each value's label; the queries use the value.
test('a static list variable offers its values and queries with the selected one', async ({ page }) => {
  const errors: string[] = [];
  const queries: string[] = [];
  page.on('pageerror', (error) => errors.push('Uncaught: ' + error.message));
  const usage = dashboard('dashboard-2-usage-admin', 'Usage');
  const viewBy = {
    kind: 'ListVariable',
    spec: {
      name: 'view_by',
      display: { name: 'View by' },
      allowMultiple: false,
      allowAllValue: false,
      defaultValue: 'model',
      plugin: {
        kind: 'StaticListVariable',
        spec: {
          values: [
            { value: 'model', label: 'Model' },
            { value: 'organization', label: 'Organization' },
          ],
        },
      },
    },
  };
  const byQuery = {
    kind: 'TimeSeriesQuery',
    spec: { plugin: { kind: 'PrometheusTimeSeriesQuery', spec: { query: 'sum by ($view_by) (compat_metric)' } } },
  };
  const { requests } = usage.spec.panels;
  const withViewBy = {
    ...usage,
    spec: {
      ...usage.spec,
      variables: [...usage.spec.variables, viewBy],
      panels: { ...usage.spec.panels, requests: { ...requests, spec: { ...requests.spec, queries: [byQuery] } } },
    },
  };
  const config = structuredClone(configExample.body);
  config.data.monitoring = { enabled: true, persesProject: 'ai-grid' };
  config.data.fakeBackend = true;
  await page.route('**/api/v1/user', (route) => route.fulfill({ json: userExample.body }));
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: config }));
  await page.route('**/perses/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/dashboards')) return route.fulfill({ json: [withViewBy] });
    if (url.pathname.includes('/api/v1/projects/ai-grid/datasources')) return route.fulfill({ json: [datasource] });
    if (url.pathname.includes('/api/v1/globaldatasources')) return route.fulfill({ json: [] });
    if (url.pathname.includes('/label/cluster/values'))
      return route.fulfill({ json: { status: 'success', data: ['site-a', 'site-b'] } });
    if (url.pathname.endsWith('/api/v1/query_range') || url.pathname.endsWith('/api/v1/query')) {
      const params = request.method() === 'POST' ? new URLSearchParams(request.postData() || '') : url.searchParams;
      queries.push(params.get('query') ?? '');
      const now = Math.floor(Date.now() / 1000);
      const result = { metric: { __name__: 'compat_metric' }, values: [[now, '42']] };
      return route.fulfill({ json: { status: 'success', data: { resultType: 'matrix', result: [result] } } });
    }
    errors.push(`Unhandled fixture: ${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { message: 'No fixture' } });
  });

  await page.goto('/monitoring');
  const select = page.getByRole('combobox', { name: 'View by', exact: true });
  await expect(select).toHaveValue('Model');
  await expect.poll(() => queries).toContain('sum by (model) (compat_metric)');
  await select.click();
  await expect(page.getByRole('option')).toHaveText(['Model', 'Organization']);
  await page.getByRole('option', { name: 'Organization', exact: true }).click();
  await expect(select).toHaveValue('Organization');
  await expect.poll(() => queries).toContain('sum by (organization) (compat_metric)');
  expect(errors).toEqual([]);
});
