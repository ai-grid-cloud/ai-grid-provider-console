// Adapted from ai-grid-prototype's VisionFleetMap: same Leaflet pin styling.
// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridFleetMap.tsx at 62319b8.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Flex } from '@patternfly/react-core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { FleetCluster } from './GridFleetView';
import type { TileLayerConfig } from './tiles';

type Props = {
  clusters: FleetCluster[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** The basemap; undefined while the console config loads, null when it could not be read. */
  tiles: TileLayerConfig | null | undefined;
  /** The list's search or filter is what left the map empty, not missing coordinates. */
  isFiltered?: boolean;
};

const initialView: L.LatLngExpression = [45, -40];
const initialZoom = 3;
/** Fitting one or two sites stops here, so the map keeps the countries around them. */
const maxFitZoom = 4;

/** Each status's colour: PatternFly's status icon colours, so pins match the status labels. */
const statusColor: Record<FleetCluster['status'], string> = {
  Ready: 'var(--pf-t--global--icon--color--status--success--default)',
  Offline: 'var(--pf-t--global--icon--color--status--danger--default)',
  Unknown: 'var(--pf-t--global--icon--color--subtle)',
};

/** A pin keeps its status colour when selected (the legend's colours); selection shows as a larger ring. */
const pinColor = (cluster: FleetCluster) => statusColor[cluster.status];

/** Which status a shared pin shows: the worst among its clusters. */
const statusRank: Record<FleetCluster['status'], number> = { Ready: 0, Unknown: 1, Offline: 2 };

/** "Site name · cluster name": the site's name, else the cloud region, else the cluster's name alone. */
const pinLabel = (c: FleetCluster) => {
  const site = c.siteName || c.region || c.site;
  return site ? `${site} · ${c.name}` : c.name;
};

const isMapped = (c: FleetCluster) => c.latitude !== undefined && c.longitude !== undefined;

/**
 * What the pins show; the pins are redrawn only when it changes. JSON keeps a missing site name
 * apart from an empty one (the labels treat them differently) and can't mix up field boundaries.
 */
const pinsSignature = (clusters: FleetCluster[]) =>
  JSON.stringify(
    clusters.filter(isMapped).map((c) => [c.name, c.latitude, c.longitude, c.status, c.siteName, c.region, c.site]),
  );

export const GridFleetMap: React.FC<Props> = ({ clusters, selected, onSelect, tiles, isFiltered }) => {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const lastBounds = useRef('');
  const select = useRef(onSelect);
  // The parent builds a new clusters array on every render; the pins follow its content, so
  // re-renders don't remove the pin under the pointer or close its label.
  const latestClusters = useRef(clusters);
  useLayoutEffect(() => {
    select.current = onSelect;
    latestClusters.current = clusters;
  });
  const signature = pinsSignature(clusters);
  const [tileError, setTileError] = useState(tiles === null);
  const [outlineError, setOutlineError] = useState(false);

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
    if (!map.current || !tileUrl) {
      return;
    }
    const tileLayer = L.tileLayer(tileUrl, { attribution: tileAttribution, maxZoom: 16 })
      .on('tileerror', () => setTileError(true))
      .addTo(map.current);
    return () => {
      tileLayer.remove();
    };
  }, [tilesUnavailable, tileUrl, tileAttribution]);

  // With no tile server configured, draw the bundled Natural Earth land outline under the pins; if it
  // can't load, the map says it has no basemap.
  useEffect(() => {
    if (tileUrl !== '') {
      return;
    }
    let land: L.GeoJSON | undefined;
    let cancelled = false;
    // A JSON import types each "type" field as string, not as a GeoJSON literal, so the data is cast.
    void import('./ne_110m_land.json')
      .then(({ default: data }) => {
        if (cancelled || !map.current) {
          return;
        }
        land = L.geoJSON(data as unknown as GeoJSON.FeatureCollection, {
          interactive: false,
          style: { className: 'fleet-map-land' },
        })
          .addTo(map.current)
          .bringToBack();
      })
      .catch(() => setOutlineError(true));
    return () => {
      cancelled = true;
      land?.remove();
    };
  }, [tileUrl]);

  useEffect(() => {
    if (!map.current || !layer.current) {
      return;
    }
    const group = layer.current;
    group.clearLayers();
    const bounds = L.latLngBounds([]);
    const mapped = latestClusters.current.filter(isMapped);
    // Clusters at one position share a pin (two clusters in one cloud region get the region's
    // position): its colour is the worst status among them, its label names each, and a click
    // lists them to choose from.
    const spots = new Map<string, FleetCluster[]>();
    for (const c of mapped) {
      const key = `${c.latitude},${c.longitude}`;
      spots.set(key, [...(spots.get(key) ?? []), c]);
    }
    spots.forEach((unsorted) => {
      const here = [...unsorted].sort((x, y) => x.name.localeCompare(y.name));
      const [first] = here;
      const latLng: L.LatLngExpression = [first.latitude!, first.longitude!];
      const focusedCluster = here.find((c) => c.name === selected);
      const focused = focusedCluster !== undefined;
      const worst = here.reduce((w, c) => (statusRank[c.status] > statusRank[w.status] ? c : w), first);
      const color = pinColor(worst);
      const shared = here.length > 1;
      const marker = L.circleMarker(latLng, {
        radius: focused ? 11 : shared ? 9 : 7,
        color,
        weight: focused ? 4 : 2,
        fillColor: color,
        fillOpacity: focused ? 0.6 : 0.35,
        opacity: 0.85,
        className: focused ? 'fleet-pin fleet-pin--selected' : 'fleet-pin',
      });
      // Text nodes avoid interpreting cluster metadata as HTML.
      const tooltip = document.createElement('span');
      if (focusedCluster && !shared) {
        tooltip.textContent = `${pinLabel(focusedCluster)} · ${focusedCluster.status}`;
      } else if (shared) {
        tooltip.textContent = `${here.length} clusters here: ${here.map(pinLabel).join(', ')}`;
      } else {
        tooltip.textContent = pinLabel(first);
      }
      // Only the selected pin keeps its label; the others show theirs on hover, so labels don't cover pins.
      marker.bindTooltip(tooltip, { direction: 'top', opacity: 1, permanent: focused }).addTo(group);
      if (shared) {
        const list = document.createElement('div');
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', `${here.length} clusters here`);
        for (const c of here) {
          const item = document.createElement('div');
          item.setAttribute('role', 'listitem');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'pf-v6-c-button pf-m-link pf-m-inline';
          button.textContent = `${pinLabel(c)} · ${c.status}`;
          button.addEventListener('click', () => {
            marker.closePopup();
            select.current(c.name);
          });
          item.appendChild(button);
          list.appendChild(item);
        }
        // Wide enough for "site name · cluster name · status" on one line.
        marker.bindPopup(list, { minWidth: 240 });
      } else {
        marker.on('click', () => select.current(first.name));
      }
      bounds.extend(latLng);
    });
    const signature = mapped.map((c) => `${c.name}:${c.latitude}:${c.longitude}`).join('|');
    if (signature !== lastBounds.current) {
      if (mapped.length) {
        map.current.fitBounds(bounds.pad(0.35), { maxZoom: maxFitZoom, animate: false });
      } else if (!isFiltered) {
        // A filter that matches nothing leaves the view where it was.
        map.current.setView(initialView, initialZoom);
      }
      lastBounds.current = signature;
    }
    map.current.invalidateSize();
  }, [signature, selected, isFiltered]);

  return (
    <div className="fleet-map">
      <div ref={container} className="fleet-map__leaflet" role="region" aria-label="AI Grid map of clusters" />
      {(tileError || (outlineError && tileUrl === '')) && (
        <p className="fleet-map__overlay fleet-map__overlay--notice">
          {tileError ? 'Unable to load the map' : 'No map is configured'}. Cluster pins and the cluster list are still
          available.
        </p>
      )}
      {!clusters.some(isMapped) && (
        <p className="fleet-map__overlay fleet-map__overlay--empty">
          {isFiltered ? 'No clusters match the search or filter.' : 'No cluster has a map position yet.'}
        </p>
      )}
      <Flex
        component="ul"
        aria-label="Pin colors"
        className="fleet-map__overlay fleet-map__overlay--legend"
        spaceItems={{ default: 'spaceItemsMd' }}
      >
        {(Object.keys(statusColor) as FleetCluster['status'][]).map((status) => (
          <Flex
            component="li"
            key={status}
            alignItems={{ default: 'alignItemsCenter' }}
            spaceItems={{ default: 'spaceItemsXs' }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <circle
                cx="6"
                cy="6"
                r="4.5"
                stroke={statusColor[status]}
                strokeWidth="2"
                fill={statusColor[status]}
                fillOpacity="0.35"
              />
            </svg>
            <span>{status}</span>
          </Flex>
        ))}
      </Flex>
    </div>
  );
};
