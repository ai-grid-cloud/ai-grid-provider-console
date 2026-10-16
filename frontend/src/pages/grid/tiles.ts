// The PoC's basemap (GridFleetMap.tsx:6-7 at 62319b8). Used when MAP_TILE_URL is empty.
export const DEFAULT_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
export const DEFAULT_TILE_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Esri, TomTom, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors';

export type TileLayerConfig = { url: string; attribution: string };

export const tileLayerConfig = (config: { mapTileUrl: string; mapTileAttribution: string }): TileLayerConfig =>
  config.mapTileUrl
    ? { url: config.mapTileUrl, attribution: config.mapTileAttribution }
    : { url: DEFAULT_TILE_URL, attribution: DEFAULT_TILE_ATTRIBUTION };
