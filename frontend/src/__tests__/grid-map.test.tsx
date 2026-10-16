// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/grid.test.tsx at 62319b8 (the map cases).
// The PoC's demo clusters become the console's fixture clusters: demo-new-york is site2 and
// demo-brussels is site3, whose placement location is its name. The monitoring cases belong to
// Task 11. The real-Leaflet cases are in GridFleetMap.test.tsx, because this file mocks the map (A31).
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceError } from '../api/ConsoleService';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL, tileLayerConfig } from '../pages/grid/tiles';
import { serviceOnPr12Json } from './pr12Json';
import { renderAt } from './render';

// Exercise the page and drawer without a browser map renderer or external tiles.
vi.mock('../pages/grid/GridFleetMap', () => ({
  GridFleetMap: ({ clusters, onSelect }: { clusters: Array<{ name: string }>; onSelect: (name: string) => void }) => (
    <div aria-label="AI Grid map of clusters">
      {clusters.map((c) => (
        <button key={c.name} onClick={() => onSelect(c.name)}>{`Map pin ${c.name}`}</button>
      ))}
    </div>
  ),
}));

it('uses the reference map-and-drawer layout and opens cluster details from a pin', async () => {
  const service = new MockConsoleService();
  // The PoC's browser demo is the only source that sets demo; the BFF never does.
  const overview = service.getGridOverview;
  vi.spyOn(service, 'getGridOverview').mockImplementation(async (...args) => ({
    ...(await overview(...args)),
    demo: true,
  }));
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  expect(await screen.findByText('Inventory on this page is simulated.')).toBeVisible();
  expect(screen.getByLabelText('Fleet summary')).toBeVisible();
  await user.click(await screen.findByRole('button', { name: 'Map pin site3' }));
  expect(screen.getByRole('heading', { name: 'site3' })).toBeVisible();
  expect(screen.getByText('50.8503, 4.3517')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  expect(screen.getByRole('button', { name: 'View site2 details' })).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'Filter by site' })).not.toBeInTheDocument();
});

it('filters the drawer and map by availability while retaining inventory summaries', async () => {
  const service = new MockConsoleService();
  service.clusters[1] = { ...service.clusters[1], status: 'Offline' };
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  await screen.findByRole('button', { name: 'View site2 details' });
  await user.click(
    within(screen.getByRole('group', { name: 'Filter cluster availability' })).getByRole('button', {
      name: 'Offline',
    }),
  );
  expect(screen.getByRole('button', { name: 'View site2 details' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'View site3 details' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Map pin site3' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Fleet summary')).toBeVisible();
});

it('switches between clusters and models and follows placement cross-links', async () => {
  const service = new MockConsoleService();
  const [model] = service.models;
  service.models = [{ ...model, locations: ['site3'] }];
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  await screen.findByRole('button', { name: 'View site3 details' });
  const card = screen.getByRole('button', { name: 'View site3 details' }).closest('article')!;
  await user.click(await within(card).findByRole('button', { name: model.displayName ?? model.name }));
  expect(screen.getByRole('heading', { name: 'Model configuration' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Brussels · site3' }));
  expect(screen.getByRole('heading', { name: 'Site and cluster' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('heading', { name: 'Model configuration' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  await user.click(
    within(screen.getByRole('group', { name: 'Grid object type' })).getByRole('button', { name: 'Models' }),
  );
  expect(screen.getByRole('heading', { name: 'Models' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Brussels · site3' })).toBeVisible();
  expect(screen.queryByText('GPU utilization')).not.toBeInTheDocument();
  expect(screen.queryByText('Fleet metrics')).not.toBeInTheDocument();
});

it("follows placement cross-links on PR 12's model JSON", async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid', serviceOnPr12Json());
  const card = (await screen.findByRole('button', { name: 'View site-paris-1 details' })).closest('article')!;
  await user.click(await within(card).findByRole('button', { name: 'Granite 8B Instruct' }));
  expect(screen.getByRole('heading', { name: 'Model configuration' })).toBeVisible();
  expect(screen.getByText('paris')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Paris DC1 · site-paris-1' }));
  expect(screen.getByRole('heading', { name: 'Site and cluster' })).toBeVisible();
});

it('uses the configured tile URL, or the PoC Esri basemap', () => {
  expect(tileLayerConfig({ mapTileUrl: '', mapTileAttribution: '' })).toEqual({
    url: DEFAULT_TILE_URL,
    attribution: DEFAULT_TILE_ATTRIBUTION,
  });
  expect(DEFAULT_TILE_URL).toBe(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  );
  expect(
    tileLayerConfig({ mapTileUrl: 'https://tiles.example.com/{z}/{x}/{y}.png', mapTileAttribution: 'Example tiles' }),
  ).toEqual({ url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: 'Example tiles' });
});

it('shows not-available when the backend has no grid overview', async () => {
  const service = new MockConsoleService();
  vi.spyOn(service, 'getGridOverview').mockRejectedValue(
    new ServiceError(501, 'the AI Grid backend does not support this operation yet'),
  );
  renderAt('/ai-grid', service);
  expect(await screen.findByText('AI Grid clusters are not available on this backend yet')).toBeInTheDocument();
});

it('shows the map when the backend leaves the inventory and metrics sources out', async () => {
  // The BFF omits inventorySource, metricsSource and a metric's status when the backend doesn't set them.
  const json = {
    updatedAt: '2026-10-16T12:00:00.000Z',
    demo: false,
    clusters: [
      {
        name: 'site-paris-1',
        aiGridEnabled: true,
        provisioned: true,
        status: 'ready',
        latitude: 48.8566,
        longitude: 2.3522,
      },
    ],
    metrics: [{ key: 'requests', label: 'Requests', unit: 'req/s', points: [] }],
  };
  const fetchFn = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ data: json }), { headers: { 'Content-Type': 'application/json' } }),
    );
  const service = new MockConsoleService();
  service.getGridOverview = (...args) => new HttpConsoleService(fetchFn).getGridOverview(...args);
  renderAt('/ai-grid', service);
  expect(await screen.findByRole('button', { name: 'Map pin site-paris-1' })).toBeInTheDocument();
  expect(screen.getByText(/Retrieved/)).not.toHaveTextContent('Inventory:');
});

it('shows the page when the backend sends no updated time', async () => {
  // The BFF omits updatedAt when the backend doesn't send one.
  const json = {
    demo: false,
    clusters: [
      {
        name: 'site-paris-1',
        aiGridEnabled: true,
        provisioned: true,
        status: 'ready',
        latitude: 48.8566,
        longitude: 2.3522,
      },
    ],
    metrics: [],
  };
  const fetchFn = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ data: json }), { headers: { 'Content-Type': 'application/json' } }),
    );
  const service = new MockConsoleService();
  service.getGridOverview = (...args) => new HttpConsoleService(fetchFn).getGridOverview(...args);
  renderAt('/ai-grid', service);
  expect(await screen.findByRole('button', { name: 'Map pin site-paris-1' })).toBeInTheDocument();
  expect(screen.getByText(/Retrieved/)).toHaveTextContent('Retrieved —');
  expect(screen.getByText(/Retrieved/)).not.toHaveTextContent('Invalid Date');
});

it('shows a model by its phase, not "Deployment saved"', async () => {
  const user = userEvent.setup();
  const service = serviceOnPr12Json();
  const [model] = await service.listModels();
  renderAt('/ai-grid', service);
  await user.click(
    within(await screen.findByRole('group', { name: 'Grid object type' })).getByRole('button', { name: 'Models' }),
  );
  expect((await screen.findAllByText(model.phase!)).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Deployment saved/)).not.toBeInTheDocument();
});
