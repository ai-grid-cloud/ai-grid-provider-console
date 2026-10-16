// The map with real Leaflet (review focus 5). grid-map.test.tsx mocks the map, so these
// cases live in their own file (A31).
import { act, render, screen } from '@testing-library/react';
import L from 'leaflet';
import { seedClusters } from '../api/MockConsoleService';
import { GridFleetMap } from '../pages/grid/GridFleetMap';
import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL } from '../pages/grid/tiles';

const tiles = { url: DEFAULT_TILE_URL, attribution: DEFAULT_TILE_ATTRIBUTION };
const members = seedClusters().filter((c) => c.aiGridEnabled);

afterEach(() => vi.restoreAllMocks());

it('keeps pins when tiles fail', () => {
  const tileLayer = vi.spyOn(L, 'tileLayer');
  render(<GridFleetMap clusters={members} selected={null} onSelect={() => {}} tiles={tiles} />);
  expect(tileLayer).toHaveBeenCalledWith(
    DEFAULT_TILE_URL,
    expect.objectContaining({ attribution: DEFAULT_TILE_ATTRIBUTION }),
  );
  expect(screen.queryByText(/Basemap tiles unavailable/)).not.toBeInTheDocument();

  act(() => {
    tileLayer.mock.results[0].value.fire('tileerror');
  });

  expect(
    screen.getByText('Basemap tiles unavailable. Cluster pins and the cluster list remain available.'),
  ).toBeInTheDocument();
  for (const site of ['San Francisco', 'New York', 'Brussels']) {
    expect(screen.getByText(site)).toBeInTheDocument();
  }
  expect(
    screen.queryByText('No mapped clusters. Add site coordinates to ManagedCluster annotations.'),
  ).not.toBeInTheDocument();
});

it('explains a map without coordinates', () => {
  const unmapped = members.map(({ latitude: _lat, longitude: _lng, ...c }) => c);
  render(<GridFleetMap clusters={unmapped} selected={null} onSelect={() => {}} tiles={tiles} />);
  expect(
    screen.getByText('No mapped clusters. Add site coordinates to ManagedCluster annotations.'),
  ).toBeInTheDocument();
  expect(screen.queryByText('San Francisco')).not.toBeInTheDocument();
});
