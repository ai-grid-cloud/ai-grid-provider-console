import { Suspense, lazy, useEffect, useState } from 'react';
import { Alert, AlertActionCloseButton, Stack, Tab, TabTitleText, Tabs } from '@patternfly/react-core';
import { CubesIcon } from '@patternfly/react-icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ConsoleService } from '../../api/ConsoleService';
import { ServiceError } from '../../api/ConsoleService';
import { monitoringLinkFor, monitoringTabs } from '../../api/monitoring';
import type { DashboardResource } from '@perses-dev/client';
import type { ConsoleConfig, MonitoringExtraProject } from '../../api/types';
import { EmptyListState } from '../../components/states/EmptyListState';
import { PageStateSection } from '../../components/states/PageStateSection';
import { useConsoleSession } from '../../context/useConsoleSession';
import { PageLoading } from '../../components/PageLoading';
import { useServiceData } from '../../hooks/useServiceData';
import { GridPage } from '../grid/GridPage';
import { RelayDatasourceApi } from './persesDatasourceApi';

const PersesDashboardView = lazy(() => import('./PersesDashboardView'));

type Props = { service: ConsoleService };

/**
 * The hub's Perses dashboards as tabs, when the BFF relays to a Perses (docs/plan/bff-api.md, "The
 * Perses relay"): one tab per `dashboard-*` PersesDashboard in the configured project, then one per
 * dashboard the chart lists from other projects (such as ACM observability's) that is there and
 * readable, selected with `?dashboard=`. The monitoring team writes the dashboards; the console only
 * shows them.
 */
const PersesMonitoring: React.FC<{ service: ConsoleService; project: string; extra: MonitoringExtraProject[] }> = ({
  service,
  project,
  extra,
}) => {
  // The main project's failure is the page's; another project's dashboard that fails to load only
  // loses its tab, with a warning, unless it's a 401, which the session check below needs.
  const [loadedTabs, loaded, error, refresh] = useServiceData(
    async () => {
      const wanted = extra.flatMap((p) => p.dashboards.map((d) => ({ project: p.project, ...d })));
      const [main, others] = await Promise.all([
        service.listMonitoringDashboards(project),
        Promise.allSettled(wanted.map((w) => service.getMonitoringDashboard(w.project, w.name))),
      ]);
      const shown: { dashboard: DashboardResource; title?: string }[] = [];
      const failed: string[] = [];
      others.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          if (result.value) shown.push({ dashboard: result.value, title: wanted[i].title });
        } else if (result.reason instanceof ServiceError && result.reason.status === 401) {
          throw result.reason;
        } else {
          failed.push(wanted[i].title || wanted[i].name);
        }
      });
      return { tabs: monitoringTabs(main, shown), failed };
    },
    { tabs: [], failed: [] },
    0,
  );
  const { tabs, failed } = loadedTabs;
  const [datasourceApi] = useState(() => new RelayDatasourceApi(extra));
  // The relay's 401 may be Perses's own refusal (RelayedError), so it asks the console to check.
  const { checkSession } = useConsoleSession();
  useEffect(() => {
    if (error instanceof ServiceError && error.status === 401) {
      checkSession?.();
    }
  }, [error, checkSession]);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // A link inside a dashboard to a page of another app (such as the OpenShift console's Perses
  // viewer, which ACM's dashboards link to), which would be this console's 404.
  const [unreachableLink, setUnreachableLink] = useState<string>();
  const asked = params.get('dashboard');
  const selected = tabs.find((t) => t.key === asked) ?? tabs[0];

  const body = () => {
    if (!selected) {
      return (
        <EmptyListState title="No dashboards" icon={CubesIcon}>
          To show a dashboard here, add a Perses dashboard whose name starts with <code>dashboard-</code> to the{' '}
          {project} project.
        </EmptyListState>
      );
    }
    return (
      <Stack hasGutter>
        <Tabs
          activeKey={selected.key}
          // A new tab starts from its own time range and variables: Perses's query parameters go.
          onSelect={(_event, key) => setParams({ dashboard: String(key) })}
          aria-label="Dashboards"
          data-testid="monitoring-tabs"
        >
          {tabs.map((t) => (
            <Tab key={t.key} eventKey={t.key} title={<TabTitleText>{t.title}</TabTitleText>} />
          ))}
        </Tabs>
        {failed.length > 0 && (
          <Alert isInline variant="warning" title="Some dashboards could not be loaded">
            {failed.join(', ')}. Refresh the page to try again.
          </Alert>
        )}
        {unreachableLink && (
          <Alert
            isInline
            variant="info"
            title="Link not available in this console"
            actionClose={<AlertActionCloseButton onClose={() => setUnreachableLink(undefined)} />}
          >
            The dashboard links to <code>{unreachableLink}</code>, which this console does not provide. Only links to
            other monitoring dashboards open here.
          </Alert>
        )}
        {/* Links in a dashboard are the dashboard author's: one to a page of this console's (another tab)
            opens here; a relative one to any other page would be this console's 404. Links to other
            sites, and clicks with a modifier key, are left alone. */}
        <div
          onClick={(event) => {
            const href = (event.target as HTMLElement).closest('a')?.getAttribute('href');
            if (
              !href ||
              !href.startsWith('/') ||
              href.startsWith('//') ||
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            event.preventDefault();
            const to = monitoringLinkFor(href, tabs, selected.dashboard.metadata.project);
            setUnreachableLink(to ? undefined : href);
            if (to) navigate(to);
          }}
        >
          <Suspense fallback={<PageLoading label="Loading dashboard" />}>
            <PersesDashboardView key={selected.key} dashboard={selected.dashboard} datasourceApi={datasourceApi} />
          </Suspense>
        </div>
      </Stack>
    );
  };

  return (
    <PageStateSection
      title="Monitoring"
      description="View monitoring dashboards for the AI Grid clusters."
      loaded={loaded}
      error={error}
      onRetry={() => void refresh()}
      subject="Dashboards"
      loadingLabel="Loading dashboards"
    >
      {body()}
    </PageStateSection>
  );
};

/** /monitoring: the hub's Perses dashboards when the BFF relays to a Perses, else the AI Grid overview's metrics. */
export const MonitoringPage: React.FC<Props> = ({ service }) => {
  const [config, loaded, error, refresh] = useServiceData<ConsoleConfig | undefined>(
    () => service.getConfig(),
    undefined,
    0,
  );
  // Without the configuration the page can't tell whether the console has a Perses: say so rather
  // than fall back to the overview's metrics. The header stays while it loads.
  if (!config) {
    return (
      <PageStateSection
        title="Monitoring"
        loaded={loaded}
        error={error}
        onRetry={() => void refresh()}
        subject="Monitoring"
        object="console settings"
        loadingLabel="Loading monitoring"
      />
    );
  }
  if (config.monitoring.enabled) {
    return (
      <PersesMonitoring
        service={service}
        project={config.monitoring.persesProject}
        extra={config.monitoring.extraDashboards ?? []}
      />
    );
  }
  return <GridPage key="monitoring" service={service} monitoring />;
};
