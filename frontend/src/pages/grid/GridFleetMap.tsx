// Adapted from ai-grid-prototype's VisionFleetMap: same Leaflet basemap and pin styling.
// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridFleetMap.tsx at 62319b8.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GridCluster } from '../../api/types';
import type { TileLayerConfig } from './tiles';

type Props = {
  clusters: GridCluster[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** The basemap; undefined while the console config loads, null when it could not be read. */
  tiles: TileLayerConfig | null | undefined;
};

const initialView: L.LatLngExpression = [45, -40];
const initialZoom = 3;

const pinColor = (cluster: GridCluster, focused: boolean) =>
  focused ? '#0066cc' : cluster.status === 'Ready' ? '#3d7317' : cluster.status === 'Offline' ? '#ee0000' : '#6a6e73';

const isMapped = (c: GridCluster) => c.latitude !== undefined && c.longitude !== undefined;

export const GridFleetMap: React.FC<Props> = ({ clusters, selected, onSelect, tiles }) => {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const lastBounds = useRef('');
  const select = useRef(onSelect);
  useLayoutEffect(() => {
    select.current = onSelect;
  });
  const [tileError, setTileError] = useState(tiles === null);

  useEffect(() => {
    if (!container.current) {
      return;
    }
    const instance = L.map(container.current, { scrollWheelZoom: true, attributionControl: true }).setView(
      initialView,
      initialZoom,
    );
    map.current = instance;
    layer.current = L.layerGroup().addTo(instance);
    const observer = new ResizeObserver(() => instance.invalidateSize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      layer.current = null;
      lastBounds.current = '';
    };
  }, []);

  const tileUrl = tiles?.url;
  const tileAttribution = tiles?.attribution;
  const tilesUnavailable = tiles === null;
  // A new tile source starts without an error, or with one when there is no source.
  const tileKey = `${tilesUnavailable}|${tileUrl}|${tileAttribution}`;
  const [tileErrorKey, setTileErrorKey] = useState(tileKey);
  if (tileErrorKey !== tileKey) {
    setTileErrorKey(tileKey);
    setTileError(tilesUnavailable);
  }
  useEffect(() => {
    if (!map.current || tileUrl === undefined) {
      return;
    }
    const tileLayer = L.tileLayer(tileUrl, { attribution: tileAttribution, maxZoom: 16 })
      .on('tileerror', () => setTileError(true))
      .addTo(map.current);
    return () => {
      tileLayer.remove();
    };
  }, [tilesUnavailable, tileUrl, tileAttribution]);

  useEffect(() => {
    if (!map.current || !layer.current) {
      return;
    }
    const group = layer.current;
    group.clearLayers();
    const bounds = L.latLngBounds([]);
    const mapped = clusters.filter(isMapped);
    mapped.forEach((cluster) => {
      // Separate co-located cluster pins so each remains selectable.
      const siblings = mapped
        .filter((c) => c.latitude === cluster.latitude && c.longitude === cluster.longitude)
        .sort((a, b) => a.name.localeCompare(b.name));
      const i = siblings.findIndex((c) => c.name === cluster.name);
      const angle = (i * 2 * Math.PI) / siblings.length;
      const offset = siblings.length > 1 ? 0.12 : 0;
      const latLng: L.LatLngExpression = [
        cluster.latitude! + Math.sin(angle) * offset,
        cluster.longitude! + Math.cos(angle) * offset,
      ];
      const focused = selected === cluster.name;
      const color = pinColor(cluster, focused);
      const marker = L.circleMarker(latLng, {
        radius: focused ? 10 : 7,
        color,
        weight: focused ? 3 : 2,
        fillColor: color,
        fillOpacity: 0.35,
        opacity: 0.85,
      });
      // A text node avoids interpreting cluster metadata as HTML.
      const tooltip = document.createElement('span');
      tooltip.textContent = focused
        ? `${cluster.siteName ?? cluster.site ?? 'Site unassigned'} · ${cluster.name} · ${cluster.status}`
        : (cluster.siteName ?? cluster.site ?? cluster.name);
      marker
        .bindTooltip(tooltip, { direction: 'top', opacity: 1, permanent: true })
        .on('click', () => select.current(cluster.name))
        .addTo(group);
      bounds.extend(latLng);
    });
    const signature = mapped.map((c) => `${c.name}:${c.latitude}:${c.longitude}`).join('|');
    if (signature !== lastBounds.current) {
      if (mapped.length) {
        map.current.fitBounds(bounds.pad(0.35), { maxZoom: 6, animate: false });
      } else {
        map.current.setView(initialView, initialZoom);
      }
      lastBounds.current = signature;
    }
    map.current.invalidateSize();
  }, [clusters, selected]);

  return (
    <div className="vision-fleet-map">
      <div ref={container} className="vision-fleet-map__leaflet" aria-label="AI Grid map of clusters" />
      {tileError && (
        <p className="fleet-map-notice">
          Basemap tiles unavailable. Cluster pins and the cluster list remain available.
        </p>
      )}
      {!clusters.some(isMapped) && (
        <p className="vision-fleet-map__empty">
          No mapped clusters. Add site coordinates to ManagedCluster annotations.
        </p>
      )}
      <div className="vision-fleet-map__legend">
        <span className="fleet-legend-ready">Available</span>
        <span className="fleet-legend-offline">Unavailable</span>
        <span className="fleet-legend-unknown">Unknown</span>
      </div>
    </div>
  );
};
