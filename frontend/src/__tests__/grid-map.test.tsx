// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/grid.test.tsx at 62319b8 (the map cases).
// The PoC's demo clusters become the console's fixture clusters: demo-new-york is site2 and
// demo-brussels is site3, whose placement location is its name. The real-Leaflet cases are in
// GridFleetMap.test.tsx, because this file mocks the map (A31).
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { ModelClusterStatusSchema, ModelPhase, ModelState } from '../gen/ai_grid/v1/model_type_pb';
import { ServiceError } from '../api/ConsoleService';
import { fakeClients } from '../api/connect/testing';
import { MockConsoleService } from '../api/MockConsoleService';
import { tileLayerConfig } from '../pages/grid/tiles';
import { toManagedCluster } from './connectClusters';
import { modelsOf } from './connectModels';
import { renderAt } from './render';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/grid/AiGridPage';
import '../pages/clusters/ClusterDetailsPage';
import '../pages/monitoring/MonitoringPage';
import { TestApp } from './TestApp';

/** Places a model of the Models API on these clusters, as Models/List reports it. */
const placeOn = (service: MockConsoleService, id: string, clusters: string[], displayName?: string) => {
  const model = modelsOf(service).find(id);
  model.status!.placement!.selectedClusters = clusters;
  model.status!.clusters = [];
  if (displayName) model.metadata!.annotations['openshift.io/display-name'] = displayName;
};

// Exercise the page and drawer without a browser map renderer or external tiles.
vi.mock('../pages/grid/GridFleetMap', () => ({
  GridFleetMap: ({ clusters, onSelect }: { clusters: Array<{ name: string }>; onSelect: (name: string) => void }) => (
    <div aria-label="AI grid map of clusters">
      {clusters.map((c) => (
        <button key={c.name} onClick={() => onSelect(c.name)}>{`Map pin ${c.name}`}</button>
      ))}
    </div>
  ),
}));

it('uses the reference map-and-drawer layout and opens cluster details from a pin', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  const summary = await screen.findByLabelText('AI grid summary');
  expect(summary).toBeVisible();
  expect(within(summary).getByText('Sites')).toBeVisible();
  expect(screen.queryByText(/simulated/)).not.toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Map pin site3' }));
  expect(screen.getByRole('heading', { name: 'site3' })).toBeVisible();
  expect(screen.getByText('50.8503, 4.3517')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  expect(screen.getByRole('button', { name: 'View site2 details' })).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'Filter by site' })).not.toBeInTheDocument();
});

it('links to the Monitoring page from its header', async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid', new MockConsoleService());
  await user.click(await screen.findByRole('link', { name: 'View monitoring' }));
  // The mock console relays to no Perses.
  expect(await screen.findByRole('heading', { name: 'Monitoring is not set up for this console' })).toBeVisible();
});

it('opens the drawer on the cluster or model a link names', async () => {
  const service = new MockConsoleService();
  const view = renderAt('/ai-grid?cluster=site3', service);
  expect(await screen.findByRole('heading', { name: 'site3' })).toBeVisible();
  view.unmount();
  renderAt('/ai-grid?model=granite-3-8b', service);
  expect(await screen.findByRole('heading', { name: 'Granite 3.3 8B Instruct' })).toBeVisible();
});

it('filters the drawer and map by availability while retaining inventory summaries', async () => {
  const service = new MockConsoleService();
  service.clusters[1] = { ...service.clusters[1], status: 'Unavailable' };
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  await screen.findByRole('button', { name: 'View site2 details' });
  await user.click(
    within(screen.getByRole('group', { name: 'Filter cluster availability' })).getByRole('button', {
      name: 'Unavailable',
    }),
  );
  expect(screen.getByRole('button', { name: 'View site2 details' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'View site3 details' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Map pin site3' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('AI grid summary')).toBeVisible();
});

it('switches between clusters and models and follows placement cross-links', async () => {
  const service = new MockConsoleService();
  const model = { displayName: 'Granite 3.3 8B Instruct' };
  placeOn(service, 'granite-3-8b', ['site3']);
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  // A card is one control; its models are links in the cluster's details.
  await user.click(await screen.findByRole('button', { name: 'View site3 details' }));
  await user.click(await screen.findByRole('button', { name: model.displayName }));
  expect(screen.getByRole('heading', { name: 'Model configuration' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'site3' }));
  expect(screen.getByRole('heading', { name: 'Cluster' })).toBeVisible();
  // Each term names its source: Site the site name annotation, Site ID the ai-grid/site label.
  const details = screen.getByLabelText('Cluster', { selector: 'dl' });
  expect(details).toHaveTextContent('SiteBrussels');
  expect(details).toHaveTextContent('Site IDbrussels');
  expect(details).toHaveTextContent('Location labelsite3');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('heading', { name: 'Model configuration' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  await user.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Models' }));
  expect(screen.getByRole('heading', { name: 'Models' })).toBeVisible();
  expect(screen.getByText('Clusters: site3')).toBeVisible();
  expect(screen.queryByText('GPU utilization')).not.toBeInTheDocument();
  expect(screen.queryByText('Fleet metrics')).not.toBeInTheDocument();
});

it('places a model on the clusters its placement chose, by name, when they share one location', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  // As on the dev hub: two members, site-a and site-b, both labelled location=us-east, and a model
  // the backend placed on site-b (status.placement.selected_clusters).
  const [first, second] = service.clusters;
  service.clusters = [
    { ...first, name: 'site-a', location: 'us-east', siteName: 'Site A' },
    { ...second, name: 'site-b', location: 'us-east', siteName: 'Site B' },
  ];
  placeOn(service, 'granite-3-8b', ['site-b'], 'Granite 8B Instruct');
  renderAt('/ai-grid', service);
  await user.click(await screen.findByRole('button', { name: 'View site-a details' }));
  expect(screen.getByText('No models on this cluster.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Granite 8B Instruct' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  await user.click(screen.getByRole('button', { name: 'View site-b details' }));
  await user.click(screen.getByRole('button', { name: 'Granite 8B Instruct' }));
  expect(screen.getByRole('button', { name: 'site-b' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'site-a' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  await user.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Models' }));
  expect(screen.getByText('Clusters: site-b')).toBeVisible();
});

it('uses the configured tile URL, or none for the bundled land outline', () => {
  expect(tileLayerConfig({ mapTileUrl: '', mapTileAttribution: '' })).toEqual({ url: '', attribution: '' });
  expect(
    tileLayerConfig({ mapTileUrl: 'https://tiles.example.com/{z}/{x}/{y}.png', mapTileAttribution: 'Example tiles' }),
  ).toEqual({ url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: 'Example tiles' });
});

it('shows the not-available page, like Models, when the backend has no Clusters/List', async () => {
  const service = new MockConsoleService();
  // A backend whose Clusters service has no List: every Clusters method answers Unimplemented.
  renderAt('/ai-grid', service, fakeClients({}).transport);
  expect(
    await screen.findByRole('heading', { name: 'The AI grid map is not available on this AI grid backend' }),
  ).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'AI grid' })).toBeVisible();
  // No map, no summary, and nothing to refresh or switch to.
  expect(screen.queryByRole('region', { name: 'AI grid summary' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'AI grid map and drawer' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'View monitoring' })).not.toBeInTheDocument();
});

it('drops the map for the not-available page when a later answer is Unimplemented', async () => {
  const service = new MockConsoleService();
  const list = service.listClusters;
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  expect(await screen.findByRole('region', { name: 'AI grid map and drawer' })).toBeVisible();
  service.listClusters = () =>
    Promise.reject(new ServiceError(501, 'The AI grid backend does not support this operation.'));
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(
    await screen.findByRole('heading', { name: 'The AI grid map is not available on this AI grid backend' }),
  ).toBeVisible();
  expect(screen.queryByRole('region', { name: 'AI grid map and drawer' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'AI grid summary' })).not.toBeInTheDocument();
  service.listClusters = list;
});

it('shows the backend error, not the not-available page, when the clusters fail otherwise', async () => {
  const service = new MockConsoleService();
  vi.spyOn(service, 'listClusters').mockRejectedValue(
    new ServiceError(503, 'The AI grid backend is unavailable. Try again.'),
  );
  renderAt('/ai-grid', service);
  expect(await screen.findByText('Unable to load AI grid clusters')).toBeVisible();
  expect(screen.getByText('The AI grid backend is unavailable. Try again.')).toBeVisible();
  expect(screen.queryByText('The AI grid map is not available on this AI grid backend')).not.toBeInTheDocument();
  // Nothing to switch to or refresh from the header: the error's Retry loads again.
  expect(screen.queryByRole('link', { name: 'View monitoring' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
});

it('shows only the AI grid members, and when the console read them', async () => {
  const service = new MockConsoleService();
  renderAt('/ai-grid', service);
  expect(await screen.findByRole('button', { name: 'View site1 details' })).toBeVisible();
  // site4 is on the hub with coordinates, but not an AI grid member.
  expect(screen.queryByRole('button', { name: 'Map pin site4' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'View site4 details' })).not.toBeInTheDocument();
  expect(screen.getByText(/^Updated/)).toBeVisible();
});

it('shows a model by its state, not "Deployment saved"', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  const model = { state: 'Ready' };
  renderAt('/ai-grid', service);
  await user.click(within(await screen.findByRole('group', { name: 'Show' })).getByRole('button', { name: 'Models' }));
  expect((await screen.findAllByText(model.state)).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Deployment saved/)).not.toBeInTheDocument();
});

it("shows a model's state, as the Models list does, on its card and in its panel, never the phase", async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  const model = { displayName: 'Granite 3.3 8B Instruct' };
  // The phase says site1 failed; the state, from the same cluster, says it is starting.
  const granite = modelsOf(service).find('granite-3-8b');
  granite.status!.phase = ModelPhase.FAILED;
  granite.status!.message = 'Failed on site1';
  granite.status!.state = ModelState.STARTING;
  granite.status!.clusters = [
    create(ModelClusterStatusSchema, {
      cluster: 'site1',
      phase: ModelPhase.FAILED,
      state: ModelState.STARTING,
      deploymentMessage: 'Deployment does not have minimum availability.',
    }),
  ];
  renderAt('/ai-grid', service);
  await user.click(within(await screen.findByRole('group', { name: 'Show' })).getByRole('button', { name: 'Models' }));
  const card = screen.getByRole('button', { name: `View ${model.displayName} details` }).closest('.pf-v6-c-card');
  expect(within(card as HTMLElement).getByText('Starting')).toBeVisible();
  expect(card).not.toHaveTextContent('Failed');
  await user.click(screen.getByRole('button', { name: `View ${model.displayName} details` }));
  expect(screen.getByRole('heading', { name: model.displayName })).toBeVisible();
  const status = screen.getByTestId('model-phase');
  expect(status).toHaveTextContent(/^Starting$/);
  await user.hover(within(status).getByText('Starting'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(
    /^site1: Starting\. Deployment does not have minimum availability\.$/,
  );
});

it('keeps the map, its selection and its models when a refresh fails', async () => {
  const service = new MockConsoleService();
  const model = { displayName: 'Granite 3.3 8B Instruct' };
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  await user.click(await screen.findByRole('button', { name: 'Map pin site1' }));
  expect(screen.getByRole('heading', { name: 'site1' })).toBeVisible();
  expect(screen.getByRole('button', { name: model.displayName })).toBeVisible();
  const failed = new ServiceError(503, 'Service unavailable.');
  vi.spyOn(service, 'listClusters').mockRejectedValue(failed);
  vi.spyOn(modelsOf(service), 'list').mockImplementation(() => {
    throw new ConnectError('Service unavailable.', Code.Unavailable);
  });
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Showing the last loaded AI grid clusters')).toBeVisible();
  expect(screen.getByText('Unable to load models')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'site1' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Map pin site1' })).toBeVisible();
  expect(screen.getByRole('button', { name: model.displayName })).toBeVisible();
});

it("explains, in a help popover, where a cluster's models come from", async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid', new MockConsoleService());
  await user.click(await screen.findByRole('button', { name: 'Map pin site1' }));
  expect(screen.queryByText(/whose placement chose/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'More about models on this cluster' }));
  expect(await screen.findByText(/^Models deployed to this cluster\./)).toBeVisible();
});

it('says no clusters match and clears the search and filter', async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: 'Filter clusters' }));
  await user.paste('zzz');
  expect(screen.getByText('No results found')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
  expect(screen.getByRole('button', { name: 'View site1 details' })).toBeVisible();
});

it('names the page like every other page, with no status chips over the map', async () => {
  const service = new MockConsoleService();
  service.clusters[1] = { ...service.clusters[1], status: 'Unavailable' };
  renderAt('/ai-grid', service);
  expect(await screen.findByRole('heading', { name: 'AI grid', level: 1 })).toBeVisible();
  expect(screen.queryByText('site2: Unavailable')).not.toBeInTheDocument();
});

it('does not call a failed model available for subscriptions', async () => {
  const service = new MockConsoleService();
  const model = { displayName: 'Granite 3.3 8B Instruct' };
  modelsOf(service).find('granite-3-8b').status!.phase = ModelPhase.FAILED;
  const user = userEvent.setup();
  renderAt('/ai-grid', service);
  await user.click(await screen.findByRole('button', { name: 'Map pin site1' }));
  await user.click(screen.getByRole('button', { name: model.displayName }));
  expect(screen.getByRole('heading', { name: 'Model configuration' })).toBeVisible();
  expect(screen.queryByText('Available for subscriptions')).not.toBeInTheDocument();
});

it('exposes the map area and the fleet summary as named regions', async () => {
  renderAt('/ai-grid', new MockConsoleService());
  expect(await screen.findByRole('region', { name: 'AI grid map and drawer' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'AI grid summary' })).toBeVisible();
});

it('keeps the URL in step with the drawer, and clears it when the drawer closes', async () => {
  let search = '';
  const Probe = () => {
    search = useLocation().search;
    return null;
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/ai-grid']}>
      <Probe />
      <TestApp service={new MockConsoleService()} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Map pin site3' }));
  expect(search).toBe('?cluster=site3');
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  expect(search).toBe('');
});

it("links to the selected cluster's details page, as the Clusters list does", async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid', new MockConsoleService());
  await user.click(await screen.findByRole('button', { name: 'View site3 details' }));
  expect(screen.getByRole('link', { name: 'View cluster details' })).toHaveAttribute('href', '/clusters/site3');
  await user.click(screen.getByRole('button', { name: 'Clusters' }));
  await user.click(screen.getByRole('button', { name: 'View site2 details' }));
  await user.click(screen.getByRole('link', { name: 'View cluster details' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'site2' })).toBeVisible();
});

it.each([
  ['clusters', 'The total number of OpenShift clusters in the AI grid.'],
  ['sites', 'The number of different sites or cloud regions where clusters in the AI grid are located.'],
  ['models', 'The total number of models in the AI grid.'],
])('says what the %s count counts in a help popover', async (card, help) => {
  const user = userEvent.setup();
  renderAt('/ai-grid', new MockConsoleService());
  await user.click(await screen.findByRole('button', { name: `More about the ${card} count` }));
  expect(await screen.findByText(help)).toBeVisible();
});

it('closes the drawer when the AI grid nav link drops the cluster from the URL', async () => {
  const user = userEvent.setup();
  renderAt('/ai-grid?cluster=site2', new MockConsoleService());
  expect(await screen.findByRole('heading', { name: 'site2' })).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'AI grid' }));
  expect(screen.queryByRole('heading', { name: 'site2' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View site2 details' })).toBeVisible();
});

it("drops the Back trail when a link moves the drawer to something the trail wasn't built for", async () => {
  const service = new MockConsoleService();
  const model = { displayName: 'Granite 3.3 8B Instruct' };
  placeOn(service, 'granite-3-8b', ['site3']);
  let navigate: NavigateFunction = () => undefined;
  const Probe = () => {
    navigate = useNavigate();
    return null;
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/ai-grid?cluster=site3']}>
      <Probe />
      <TestApp service={service} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: model.displayName }));
  expect(screen.getByRole('button', { name: 'Back' })).toBeVisible();
  // A link elsewhere opens site2: Back would have led to site3, which isn't where the user came from.
  act(() => navigate('/ai-grid?cluster=site2'));
  expect(await screen.findByRole('heading', { name: 'site2' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clusters' })).toBeVisible();
});

it("counts the members that aren't on the map, whatever the reason, and links to how to place them", async () => {
  const service = new MockConsoleService();
  const [first, second, third] = service.clusters;
  service.clusters = [
    first,
    { ...second, latitude: undefined, longitude: undefined },
    { ...third, latitude: undefined, longitude: undefined },
  ];
  // The mock's clusters carry no problem; one member's annotations are wrong.
  const clusters = await service.listClusters();
  const transport = fakeClients({
    clusters: {
      list: async () => {
        const items = clusters.map(toManagedCluster);
        items[2].status!.location!.problem = 'ai-grid/longitude "4,35" is not a decimal number of degrees';
        return { items, size: items.length, total: items.length };
      },
    },
  }).transport;
  renderAt('/ai-grid', service, transport);
  // One inline alert for both reasons: the drawer names each cluster's problem.
  const note = await screen.findByTestId('clusters-not-on-map');
  expect(within(note).getByRole('heading', { name: /2 clusters not shown/ })).toBeVisible();
  expect(note).toHaveTextContent('Clusters are excluded from the map when their positions are missing or invalid.');
  expect(within(note).getByRole('link', { name: "How to set a cluster's position" })).toBeVisible();
});
