// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridPage.tsx at 62319b8: the map at
// /ai-grid and, with `monitoring`, the dashboards at /monitoring when the console relays to no
// Perses (MonitoringPage shows the hub's Perses dashboards otherwise). The PoC's loading, error, and refresh
// state becomes useServiceData, and a failed load is a LoadError. A backend without Grid/GetOverview
// (501) gets the console's not-available page, as Models and Subscriptions do.
import { useEffect, useState } from 'react';
import { Alert, Flex, PageSection, Stack, ToggleGroup, ToggleGroupItem } from '@patternfly/react-core';
import { Link } from 'react-router-dom';
import type { ConsoleService } from '../../api/ConsoleService';
import { ServiceError } from '../../api/ConsoleService';
import type { GridService } from '../../api/grid';
import type { ModelsService } from '../../api/models';
import type { OrganizationsService } from '../../api/organizations';
import type { GridOverview, GridRange, ManagedModel, Organization } from '../../api/types';
import { LoadError } from '../../components/LoadError';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { RefreshButton } from '../../components/RefreshButton';
import { RelativeTime } from '../../components/RelativeTime';
import { SubtleText } from '../../components/SubtleText';
import { useServiceData } from '../../hooks/useServiceData';
import { GridFleetView } from './GridFleetView';
import { ObservabilityPanel } from './ObservabilityPanel';
import { tileLayerConfig } from './tiles';

type Props = {
  service: GridService &
    ModelsService &
    Pick<OrganizationsService, 'listOrganizations'> &
    Pick<ConsoleService, 'getConfig'>;
  monitoring?: boolean;
};

const modelsErrorOf = (err: Error) =>
  err instanceof ServiceError && err.isNotImplemented ? 'Models are not available on this backend yet.' : err.message;

const organizationsErrorOf = (err: Error) =>
  err instanceof ServiceError && err.isNotImplemented
    ? 'Organizations are not available on this backend yet.'
    : 'Unable to load organization identities.';

const ranges: GridRange[] = ['1h', '6h', '24h'];

export const GridPage: React.FC<Props> = ({ service, monitoring = false }) => {
  // On /monitoring the metrics answer below carries the clusters too, so only the map asks for them alone.
  const [inventory, inventoryLoaded, inventoryError, refreshOverview] = useServiceData<GridOverview | undefined>(
    () => (monitoring ? Promise.resolve(undefined) : service.getGridOverview('1h', { includeMetrics: false })),
    undefined,
  );
  const [models, , modelsLoadError, refreshModels] = useServiceData<ManagedModel[]>(() => service.listModels(), []);
  const [config, , configError] = useServiceData(() => service.getConfig(), undefined, 0);
  const [organizations, , organizationsLoadError, refreshOrganizations] = useServiceData<Organization[]>(
    () => (monitoring ? service.listOrganizations() : Promise.resolve([])),
    [],
  );
  const [range, setRange] = useState<GridRange>('1h');
  // Each metrics response carries the range it was asked for, so a slow answer for an earlier
  // range is never shown as the current one.
  const [metricsData, metricsLoaded, metricsLoadError, refreshMetrics] = useServiceData<
    { overview: GridOverview; range: GridRange } | undefined
  >(
    () =>
      monitoring
        ? service.getGridOverview(range).then((overview) => ({ overview, range }))
        : Promise.resolve(undefined),
    undefined,
  );
  const metricsCurrent = metricsData?.range === range;
  const data = monitoring ? metricsData?.overview : inventory;
  const loaded = monitoring ? metricsLoaded : inventoryLoaded;
  // The backend has no Grid/GetOverview: the page is the not-available state, with nothing to refresh
  // or switch to, even if an earlier answer is still held (a backend redeployed without it).
  const loadError = monitoring ? metricsLoadError : inventoryError;
  const notServed = loadError instanceof ServiceError && loadError.isNotImplemented;
  // Otherwise a failed range keeps the last answer's clusters; the panel shows the metrics error.
  const error = notServed || !monitoring ? loadError : data ? undefined : metricsLoadError;
  // A new range, or a late answer for an old one, asks again for the current range.
  useEffect(() => {
    if (monitoring && metricsLoaded && !metricsCurrent && !notServed) {
      void refreshMetrics();
    }
  }, [monitoring, range, metricsData, metricsLoaded, metricsCurrent, notServed, refreshMetrics]);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      refreshOverview(),
      refreshModels(),
      ...(monitoring ? [refreshOrganizations(), refreshMetrics()] : []),
    ]);
    setRefreshing(false);
  };

  // Until the config loads there is no basemap; if it can't be read, the map says tiles are unavailable. An empty tile URL draws the bundled land outline.
  const tiles = config ? tileLayerConfig(config) : configError ? null : undefined;
  const modelsError = modelsLoadError && modelsErrorOf(modelsLoadError);

  const metricsSource = metricsData?.overview.metricsSource;

  // One toolbar row: the time range (Monitoring), when the data was read, refresh, and the other view.
  const toolbar = (
    <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }}>
      {monitoring && (
        <ToggleGroup aria-label="Time range" isCompact>
          {ranges.map((r) => (
            <ToggleGroupItem
              key={r}
              text={`Last ${r}`}
              buttonId={`obs-range-${r}`}
              isSelected={range === r}
              onChange={() => setRange(r)}
            />
          ))}
        </ToggleGroup>
      )}
      {data?.updatedAt && (
        <SubtleText>
          Updated <RelativeTime time={data.updatedAt} />
        </SubtleText>
      )}
      <RefreshButton onRefresh={() => void refresh()} isRefreshing={!loaded || refreshing} />
      <Link to={monitoring ? '/ai-grid' : '/monitoring'}>{monitoring ? 'View AI Grid map' : 'View monitoring'}</Link>
    </Flex>
  );

  return (
    <>
      <PageHeader
        title={monitoring ? 'Monitoring' : 'AI Grid'}
        description={
          monitoring
            ? 'Cluster availability, gateway performance and resource use across AI Grid.'
            : 'Where the AI Grid clusters are, and which models they serve.'
        }
        headerAction={notServed ? undefined : toolbar}
      />
      {!error && !loaded ? (
        <PageLoading label="Loading AI Grid" />
      ) : (
        <PageSection isFilled>
          <Stack hasGutter>
            {error && (
              <LoadError
                subject="AI Grid clusters"
                error={error}
                notAvailableTitle={`${monitoring ? 'Monitoring' : 'AI Grid'} is not available on this backend yet`}
              />
            )}
            {data && !notServed && (
              <>
                {data.demo && (
                  <Alert isInline variant="info" title="Demo data">
                    {monitoring
                      ? 'Inventory and metrics on this page are simulated.'
                      : 'Inventory on this page is simulated.'}
                  </Alert>
                )}
                {monitoring && !data.demo && metricsSource === 'demo' && (
                  <Alert isInline variant="info" title="Simulated monitoring metrics">
                    Thanos is not configured. Charts show generated demo data; cluster inventory comes from the
                    configured backend.
                  </Alert>
                )}
                {!monitoring && (
                  <GridFleetView clusters={data.clusters} models={models} modelsError={modelsError} tiles={tiles} />
                )}
                {monitoring && (
                  <ObservabilityPanel
                    clusters={data.clusters}
                    models={models}
                    modelsError={modelsError}
                    organizations={organizations}
                    organizationsError={organizationsLoadError && organizationsErrorOf(organizationsLoadError)}
                    metrics={metricsCurrent ? metricsData.overview.metrics : []}
                    loading={!metricsLoaded || (!metricsCurrent && !metricsLoadError)}
                    error={metricsLoadError && 'Unable to load metrics for this selection. Please retry.'}
                    simulated={metricsSource === 'demo'}
                    range={range}
                  />
                )}
              </>
            )}
          </Stack>
        </PageSection>
      )}
    </>
  );
};
