// The map with real Leaflet (review focus 5). grid-map.test.tsx mocks the map, so these
// cases live in their own file (A31).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import L from 'leaflet';
import { seedClusters } from '../api/MockConsoleService';
import { GridFleetMap } from '../pages/grid/GridFleetMap';

const tiles = { url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: 'Example tiles' };
const members = seedClusters().filter((c) => c.aiGridEnabled);

/** How many pins the map drew. */
const pinsDrawn = (marker: { mock: { calls: unknown[] } }) => marker.mock.calls.length;

it('keeps pins when tiles fail', () => {
  const tileLayer = vi.spyOn(L, 'tileLayer');
  const { container } = render(<GridFleetMap clusters={members} selected={null} onSelect={() => {}} tiles={tiles} />);
  expect(tileLayer).toHaveBeenCalledWith(tiles.url, expect.objectContaining({ attribution: tiles.attribution }));
  expect(screen.queryByText(/Basemap tiles unavailable/)).not.toBeInTheDocument();

  act(() => {
    tileLayer.mock.results[0].value.fire('tileerror');
  });

  expect(
    screen.getByText('Basemap tiles unavailable. Cluster pins and the cluster list remain available.'),
  ).toBeInTheDocument();
  // Counted on the page after the error, so a pin the error removed fails the test.
  expect(container.querySelectorAll('path.fleet-pin')).toHaveLength(3);
  expect(screen.queryByText('No cluster has a map position yet.')).not.toBeInTheDocument();
});

it('labels only the selected pin, which keeps its status colour; the others label on hover', () => {
  const marker = vi.spyOn(L, 'circleMarker');
  render(<GridFleetMap clusters={members} selected="site3" onSelect={() => {}} tiles={tiles} />);
  expect(screen.getByText('Brussels · site3 · Ready')).toBeInTheDocument();
  expect(screen.queryByText('San Francisco')).not.toBeInTheDocument();
  const selected = marker.mock.calls.find(([, options]) => options?.radius === 11);
  expect(selected?.[1]).toMatchObject({
    color: 'var(--pf-t--global--icon--color--status--success--default)',
    weight: 4,
  });
});

it('fits the pins without zooming in past the region around them', () => {
  const fitBounds = vi.spyOn(L.Map.prototype, 'fitBounds');
  render(<GridFleetMap clusters={members.slice(0, 1)} selected={null} onSelect={() => {}} tiles={tiles} />);
  expect(fitBounds).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxZoom: 4 }));
});

it('says a filter, not missing coordinates, emptied the map', () => {
  render(<GridFleetMap clusters={[]} selected={null} onSelect={() => {}} tiles={tiles} isFiltered />);
  expect(screen.getByText('No clusters match the search or filter.')).toBeInTheDocument();
});

it('draws the bundled land outline instead of tiles without a tile URL', async () => {
  const tileLayer = vi.spyOn(L, 'tileLayer');
  const geoJSON = vi.spyOn(L, 'geoJSON');
  const marker = vi.spyOn(L, 'circleMarker');
  render(<GridFleetMap clusters={members} selected={null} onSelect={() => {}} tiles={{ url: '', attribution: '' }} />);
  await waitFor(() => expect(geoJSON).toHaveBeenCalledTimes(1));
  expect(tileLayer).not.toHaveBeenCalled();
  expect(geoJSON).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'FeatureCollection' }),
    expect.objectContaining({ interactive: false, style: { className: 'fleet-map-land' } }),
  );
  const land = geoJSON.mock.results[0].value as L.GeoJSON;
  expect(land.getLayers().length).toBeGreaterThan(100);
  expect(screen.queryByText(/basemap/i)).not.toBeInTheDocument();
  expect(pinsDrawn(marker)).toBe(3);
});

it('draws no land outline when tiles are configured', async () => {
  const geoJSON = vi.spyOn(L, 'geoJSON');
  render(<GridFleetMap clusters={members} selected={null} onSelect={() => {}} tiles={tiles} />);
  await act(() => import('../pages/grid/ne_110m_land.json'));
  expect(geoJSON).not.toHaveBeenCalled();
});

it('draws no land outline when tiles are configured while it loads', async () => {
  const geoJSON = vi.spyOn(L, 'geoJSON');
  const consoleError = vi.spyOn(console, 'error');
  const { rerender } = render(
    <GridFleetMap clusters={members} selected={null} onSelect={() => {}} tiles={{ url: '', attribution: '' }} />,
  );
  rerender(<GridFleetMap clusters={members} selected={null} onSelect={() => {}} tiles={tiles} />);
  await act(() => import('../pages/grid/ne_110m_land.json'));
  expect(geoJSON).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
});

it('says there is no basemap when the land outline fails to load', async () => {
  vi.resetModules();
  vi.doMock('../pages/grid/ne_110m_land.json', () => {
    throw new Error('chunk failed to load');
  });
  try {
    const { GridFleetMap: Map } = await import('../pages/grid/GridFleetMap');
    render(<Map clusters={members} selected={null} onSelect={() => {}} tiles={{ url: '', attribution: '' }} />);
    expect(
      await screen.findByText('No basemap configured. Cluster pins and the cluster list remain available.'),
    ).toBeInTheDocument();
  } finally {
    vi.doUnmock('../pages/grid/ne_110m_land.json');
  }
});

it('explains a map without coordinates', () => {
  const unmapped = members.map(({ latitude: _lat, longitude: _lng, ...c }) => c);
  const marker = vi.spyOn(L, 'circleMarker');
  render(<GridFleetMap clusters={unmapped} selected={null} onSelect={() => {}} tiles={tiles} />);
  expect(screen.getByText('No cluster has a map position yet.')).toBeInTheDocument();
  expect(pinsDrawn(marker)).toBe(0);
});

it('keeps its pins through a re-render with the same clusters, and redraws when they change', () => {
  const marker = vi.spyOn(L, 'circleMarker');
  const props = { selected: null, onSelect: () => {}, tiles };
  const { rerender } = render(<GridFleetMap clusters={members} {...props} />);
  const drawn = pinsDrawn(marker);
  expect(drawn).toBe(members.filter((c) => c.latitude !== undefined).length);
  // The fleet view passes a new array on every render; the same clusters keep the same pins, so
  // the pin under the pointer and its label stay.
  const pin = marker.mock.results[0].value as L.CircleMarker;
  act(() => {
    pin.openTooltip();
  });
  rerender(<GridFleetMap clusters={members.map((c) => ({ ...c }))} {...props} />);
  expect(pinsDrawn(marker)).toBe(drawn);
  // The same pin, still on the map, with its label still open.
  expect(pin.isTooltipOpen()).toBe(true);
  expect(screen.getByText(`${members[0].siteName} · ${members[0].name}`)).toBeInTheDocument();
  // A changed status is a change the pins show.
  rerender(<GridFleetMap clusters={members.map((c, i) => (i ? c : { ...c, status: 'Offline' }))} {...props} />);
  expect(pinsDrawn(marker)).toBe(2 * drawn);
});

it('redraws a label when a site name goes from missing to empty', () => {
  const marker = vi.spyOn(L, 'circleMarker');
  const props = { selected: null, onSelect: () => {}, tiles };
  const [first, ...rest] = members;
  const { rerender } = render(<GridFleetMap clusters={[{ ...first, siteName: undefined }, ...rest]} {...props} />);
  const drawn = pinsDrawn(marker);
  // The label falls back to the site only when the name is missing, so an empty name is a change.
  rerender(<GridFleetMap clusters={[{ ...first, siteName: '' }, ...rest]} {...props} />);
  expect(pinsDrawn(marker)).toBe(2 * drawn);
});

it('gives clusters at one position one pin, which names each and lists them to choose from', async () => {
  const marker = vi.spyOn(L, 'circleMarker');
  const onSelect = vi.fn();
  const [a, b, c] = members;
  // Two clusters in one cloud region get the region's position.
  const here = { latitude: 40.42, longitude: -82.91, siteName: undefined, site: undefined, region: 'us-east-2' };
  render(
    <GridFleetMap
      clusters={[{ ...a, ...here }, { ...b, ...here, status: 'Offline' }, c]}
      selected={null}
      onSelect={onSelect}
      tiles={tiles}
    />,
  );
  expect(pinsDrawn(marker)).toBe(2);
  const shared = marker.mock.results.find((r) => (r.value as L.CircleMarker).getLatLng().lat === 40.42)!
    .value as L.CircleMarker;
  // The worst status of the two colours the pin.
  expect(shared.options.color).toBe('var(--pf-t--global--icon--color--status--danger--default)');
  act(() => {
    shared.openTooltip();
  });
  expect(screen.getByText(`2 clusters here: us-east-2 · ${a.name}, us-east-2 · ${b.name}`)).toBeInTheDocument();
  act(() => {
    shared.openPopup();
  });
  const list = await screen.findByRole('list', { name: '2 clusters here' });
  // The popup lists the clusters, so the tooltip that summarises them steps aside.
  expect(shared.isTooltipOpen()).toBe(false);
  await userEvent.setup().click(within(list).getByRole('button', { name: `us-east-2 · ${b.name} · Offline` }));
  expect(onSelect).toHaveBeenCalledWith(b.name);
});
