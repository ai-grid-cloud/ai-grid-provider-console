// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridPage.tsx at 62319b8: the map at
// /ai-grid and, with `monitoring`, the dashboards at /monitoring. The PoC's loading, error, and refresh
// state becomes useServiceData, and a failed load is a LoadError, so a backend without the RPC shows
// not-available.
import { useEffect, useState } from 'react';
import { Alert, Button, Label, PageSection, Title, ToggleGroup, ToggleGroupItem } from '@patternfly/react-core';
import { Link } from 'react-router-dom';
import type { ConsoleService } from '../../api/ConsoleService';
import { ServiceError } from '../../api/ConsoleService';
import type { GridService } from '../../api/grid';
import type { ModelsService } from '../../api/models';
import type { OrganizationsService } from '../../api/organizations';
import type { GridOverview, GridRange, ManagedModel, Organization } from '../../api/types';
import { LoadError } from '../../components/LoadError';
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
    { range: GridRange; overview: GridOverview } | undefined
  >(
    () =>
      monitoring
        ? service.getGridOverview(range).then((overview) => ({ range, overview }))
        : Promise.resolve(undefined),
    undefined,
  );
  const metricsCurrent = metricsData?.range === range;
  const data = monitoring ? metricsData?.overview : inventory;
  const loaded = monitoring ? metricsLoaded : inventoryLoaded;
  // A failed range keeps the last answer's clusters; the panel shows the metrics error.
  const error = monitoring ? (data ? undefined : metricsLoadError) : inventoryError;
  // A new range, or a late answer for an old one, asks again for the current range.
  useEffect(() => {
    if (monitoring && metricsLoaded && !metricsCurrent) {
      void refreshMetrics();
    }
  }, [monitoring, range, metricsData, metricsLoaded, metricsCurrent, refreshMetrics]);
  const [refreshing, setRefreshing] = useState(false);
  const loading = !loaded || refreshing;

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      refreshOverview(),
      refreshModels(),
      ...(monitoring ? [refreshOrganizations(), refreshMetrics()] : []),
    ]);
    setRefreshing(false);
  };

  // Until the config loads there is no basemap; if it can't be read, the map says tiles are unavailable.
  const tiles = config ? tileLayerConfig(config) : configError ? null : undefined;
  const modelsError = modelsLoadError && modelsErrorOf(modelsLoadError);

  const metricsSource = metricsData?.overview.metricsSource ?? 'thanos';

  return (
    <>
      {monitoring && (
        <PageSection>
          <div className="observability-header">
            <div>
              <Title headingLevel="h1" size="3xl">
                Observability dashboard
              </Title>
              <p>Monitor cluster availability, gateway performance, and infrastructure resource usage.</p>
            </div>
            <div className="observability-time-controls">
              <span>Time period:</span>
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
            </div>
          </div>
        </PageSection>
      )}
      <PageSection>
        <div className="grid-toolbar">
          {!monitoring && <Label color="grey">AI Grid</Label>}
          <Button variant="secondary" onClick={() => void refresh()} isDisabled={loading}>
            Refresh
          </Button>
          <Link to={monitoring ? '/ai-grid' : '/monitoring'}>{monitoring ? 'View AI Grid' : 'View monitoring'}</Link>
        </div>
        {error && <LoadError subject="AI Grid clusters" error={error} />}
        {loading && <p role="status">Loading AI Grid…</p>}
        {data && !error && (
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
                Thanos is not configured. Charts show generated demo data; cluster inventory comes from the configured
                backend.
              </Alert>
            )}
            <p className="grid-source">
              {data.inventorySource && <>Inventory: {data.inventorySource.toUpperCase()} · </>}
              Retrieved {data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '—'}
              {monitoring && <> · Metrics: {metricsSource === 'demo' || data.demo ? 'Demo' : 'Thanos'}</>}
            </p>
            {!monitoring && (
              <GridFleetView
                clusters={data.clusters}
                models={modelsLoadError ? [] : models}
                modelsError={modelsError}
                tiles={tiles}
              />
            )}
            {monitoring && (
              <ObservabilityPanel
                clusters={data.clusters}
                models={modelsLoadError ? [] : models}
                modelsError={modelsError}
                organizations={organizationsLoadError ? [] : organizations}
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
      </PageSection>
    </>
  );
};
