// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridPage.tsx at 62319b8: the map at
// /ai-grid and, with `monitoring`, the dashboards at /monitoring when the console relays to no
// Perses (MonitoringPage shows the hub's Perses dashboards otherwise). The PoC's loading, error, and refresh
// state becomes useServiceData, and a failed load is a LoadError. The map's clusters come from
// AiGridPage (Clusters/List over Connect); the dashboards' from Grid/GetOverview. A backend without
// the RPC (501) gets the console's not-available page, as Models and Subscriptions do.
import { useEffect, useRef, useState } from 'react';
import { Alert, Flex, Stack, ToggleGroup, ToggleGroupItem } from '@patternfly/react-core';
import { Link } from 'react-router-dom';
import type { ConsoleService } from '../../api/ConsoleService';
import { ServiceError } from '../../api/ConsoleService';
import type { GridService } from '../../api/grid';
import type { OrganizationsService } from '../../api/organizations';
import type { GridOverview, GridRange, Organization } from '../../api/types';
import { useModelList } from '../models/useModels';
import type { FleetCluster } from './GridFleetView';
import { RefreshButton } from '../../components/RefreshButton';
import { RelativeTime } from '../../components/RelativeTime';
import { SubtleText } from '../../components/SubtleText';
import { PageStateSection } from '../../components/states/PageStateSection';
import { useConsoleSession } from '../../context/useConsoleSession';
import { useServiceData } from '../../hooks/useServiceData';
import { GridFleetView } from './GridFleetView';
import { ObservabilityPanel } from './ObservabilityPanel';
import { tileLayerConfig } from './tiles';

type Props = {
  service: GridService & Pick<OrganizationsService, 'listOrganizations'> & Pick<ConsoleService, 'getConfig'>;
  monitoring?: boolean;
  /** The map's AI Grid members, loaded by AiGridPage; unused with `monitoring`. */
  map?: MapInventory;
};

/** The map's clusters: the AI Grid members, when they were read, and how to read them again. */
export type MapInventory = {
  /** Absent until they have been read; a failed reload keeps the last ones. */
  clusters?: FleetCluster[];
  loaded: boolean;
  error?: Error;
  /** When the console last read them (ms since the epoch). */
  updatedAt?: number;
  refresh: () => Promise<unknown>;
};

const noMap: MapInventory = { loaded: true, refresh: async () => undefined };

const modelsErrorOf = (err: Error) =>
  err instanceof ServiceError && err.isNotImplemented
    ? 'Models are not available on this AI Grid backend.'
    : err.message;

const organizationsErrorOf = (err: Error) =>
  err instanceof ServiceError && err.isNotImplemented
    ? 'Organizations are not available on this AI Grid backend.'
    : 'Unable to load organizations.';

const ranges: GridRange[] = ['1h', '6h', '24h'];
const rangeLabels: Record<GridRange, string> = { '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours' };

export const GridPage: React.FC<Props> = ({ service, monitoring = false, map = noMap }) => {
  const { data: models, error: modelsLoadError, refresh: refreshModels } = useModelList();
  const { config, configError } = useConsoleSession();
  const [organizations, , organizationsLoadError, refreshOrganizations] = useServiceData<Organization[]>(
    () => (monitoring ? service.listOrganizations() : Promise.resolve([])),
    [],
  );
  const [range, setRange] = useState<GridRange>('1h');
  // Each metrics response carries the range it was asked for, so a slow answer for an earlier
  // range is never shown as the current one. The range last asked for decides whether a new one
  // needs asking: a failed answer for the current range is shown with its Retry, not asked again.
  const askedRange = useRef<GridRange>(undefined);
  const [metricsData, metricsLoaded, metricsLoadError, refreshMetrics] = useServiceData<
    { overview: GridOverview; range: GridRange } | undefined
  >(() => {
    if (!monitoring) return Promise.resolve(undefined);
    askedRange.current = range;
    return service.getGridOverview(range).then((overview) => ({ overview, range }));
  }, undefined);
  const metricsCurrent = metricsData?.range === range;
  const data = monitoring ? metricsData?.overview : map.clusters && map;
  const loaded = monitoring ? metricsLoaded : map.loaded;
  // The backend has no Grid/GetOverview (or, for the map, Clusters/List): the page is the
  // not-available state, with nothing to refresh or switch to, even if an earlier answer is still
  // held (a backend redeployed without it).
  const loadError = monitoring ? metricsLoadError : map.error;
  const notServed = loadError instanceof ServiceError && loadError.isNotImplemented;
  // Otherwise a failed range keeps the last answer's clusters; the panel shows the metrics error.
  const error = notServed || !monitoring ? loadError : data ? undefined : metricsLoadError;
  // A new range, or a late answer for an old one, asks again for the current range.
  useEffect(() => {
    if (monitoring && metricsLoaded && askedRange.current !== range && !notServed) {
      void refreshMetrics();
    }
  }, [monitoring, range, metricsData, metricsLoaded, metricsCurrent, notServed, refreshMetrics]);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      ...(monitoring ? [] : [map.refresh()]),
      refreshModels(),
      ...(monitoring ? [refreshOrganizations(), refreshMetrics()] : []),
    ]);
    setRefreshing(false);
  };

  // Until the config loads there is no basemap; if it can't be read, the map says tiles are unavailable. An empty tile URL draws the bundled land outline.
  const tiles = config ? tileLayerConfig(config) : configError ? null : undefined;
  const modelsError = modelsLoadError && modelsErrorOf(modelsLoadError);

  const metricsSource = metricsData?.overview.metricsSource;
  const updatedAt = monitoring
    ? metricsData?.overview.updatedAt
    : map.updatedAt
      ? new Date(map.updatedAt).toISOString()
      : undefined;
  const demo = monitoring && !!metricsData?.overview.demo;

  // One toolbar row: the time range (Monitoring), when the data was read, refresh, and the other view.
  const toolbar = (
    <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }}>
      {monitoring && (
        <ToggleGroup aria-label="Time range" isCompact>
          {ranges.map((r) => (
            <ToggleGroupItem
              key={r}
              text={rangeLabels[r]}
              buttonId={`obs-range-${r}`}
              isSelected={range === r}
              onChange={() => setRange(r)}
            />
          ))}
        </ToggleGroup>
      )}
      {updatedAt && (
        <SubtleText>
          Updated <RelativeTime time={updatedAt} />
        </SubtleText>
      )}
      <RefreshButton onRefresh={() => void refresh()} isRefreshing={!loaded || refreshing} />
      <Link to={monitoring ? '/ai-grid' : '/monitoring'}>{monitoring ? 'View AI Grid map' : 'View monitoring'}</Link>
    </Flex>
  );

  return (
    <PageStateSection
      title={monitoring ? 'Monitoring' : 'AI Grid'}
      description={
        monitoring
          ? 'Cluster availability, gateway performance, and resource use across AI Grid.'
          : 'View the locations of AI Grid clusters and the models they serve.'
      }
      headerAction={toolbar}
      loaded={loaded}
      error={error}
      onRetry={() => void refresh()}
      subject={monitoring ? 'Monitoring' : 'AI Grid'}
      object={monitoring ? 'metrics' : 'AI Grid clusters'}
      notAvailableTitle={`${monitoring ? 'Monitoring' : 'The AI Grid map'} is not available on this AI Grid backend`}
      loadingLabel={monitoring ? 'Loading monitoring' : 'Loading AI Grid'}
    >
      <Stack hasGutter>
        {data && (
          <>
            {demo && (
              <Alert isInline variant="info" title="Sample data">
                The clusters and metrics on this page are sample data.
              </Alert>
            )}
            {monitoring && !demo && metricsSource === 'demo' && (
              <Alert isInline variant="info" title="Sample metrics">
                Metrics are not configured, so the charts show sample data. The cluster list comes from the AI Grid
                backend.
              </Alert>
            )}
            {!monitoring && (
              <GridFleetView clusters={data.clusters ?? []} models={models} modelsError={modelsError} tiles={tiles} />
            )}
            {monitoring && metricsData && (
              <ObservabilityPanel
                clusters={metricsData.overview.clusters}
                models={models}
                modelsError={modelsError}
                organizations={organizations}
                organizationsError={organizationsLoadError && organizationsErrorOf(organizationsLoadError)}
                metrics={metricsCurrent ? metricsData.overview.metrics : []}
                loading={!metricsLoaded || (!metricsCurrent && !metricsLoadError)}
                error={metricsLoadError?.message}
                onRetry={() => void refreshMetrics()}
                simulated={metricsSource === 'demo'}
                range={range}
              />
            )}
          </>
        )}
      </Stack>
    </PageStateSection>
  );
};
