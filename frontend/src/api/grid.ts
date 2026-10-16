import type { GridOverview, GridRange } from './types';

/** The Grid area: the fleet overview behind the map and monitoring pages. */
export interface GridService {
  /**
   * AI Grid members and, unless `includeMetrics` is false, the gateway and GPU metrics
   * for the range ending now. `site` keeps only the clusters labelled `ai-grid/site: <site>`.
   */
  getGridOverview(range: GridRange, opts?: { site?: string; includeMetrics?: boolean }): Promise<GridOverview>;
}
