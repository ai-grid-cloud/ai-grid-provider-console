// One Perses dashboard from the hub, rendered with Perses's own React components, as
// odh-dashboard's Observability page does (packages/observability). Loaded lazily: Perses, its
// MUI theme and its chart library add about 1 MB (gzipped) that no other page needs.
import { useMemo, useState } from 'react';
import { Flex, FlexItem } from '@patternfly/react-core';
import { ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChartsProvider, SnackbarProvider } from '@perses-dev/components';
import type { BuiltinVariableDefinition, DashboardResource } from '@perses-dev/client';
import {
  DataQueriesProvider,
  PluginRegistry,
  TimeRangeControls,
  TimeRangeProviderWithQueryParams,
  useInitialRefreshInterval,
  useInitialTimeRange,
  usePluginBuiltinVariableDefinitions,
} from '@perses-dev/plugin-system';
import {
  Dashboard,
  DashboardProvider,
  DashboardStickyToolbar,
  DatasourceStoreProvider,
  PanelFocusProvider,
  VariableProviderWithQueryParams,
} from '@perses-dev/dashboards';
import { QueryParamProvider } from 'use-query-params';
import { ReactRouter6Adapter } from 'use-query-params/adapters/react-router-6';
import { type PageTheme, usePageTheme } from './pageTheme';
import { RelayDatasourceApi } from './persesDatasourceApi';
import { pluginLoader } from './persesPlugins';
import { patternFlyTheme } from './persesTheme';

// PatternFly's look for Perses, as odh-dashboard and the OpenShift console's monitoring plugin do:
// one for each of PatternFly's themes, built the first time the page shows in it.
const themes: Partial<Record<PageTheme, ReturnType<typeof patternFlyTheme>>> = {};
const themeFor = (mode: PageTheme) => (themes[mode] ??= patternFlyTheme(mode));
const datasourceApi = new RelayDatasourceApi();
// One cache for the page: switching tabs back reuses the answers until they're refetched.
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 0 } } });

type Props = { dashboard: DashboardResource };

/**
 * The built-in variables Perses's own dashboard view defines (dashboards ViewDashboard): the
 * dashboard's name and project, and those the plugins add (such as Prometheus's $__interval). A
 * query or link that uses them, like ACM's `project=$__project`, gets their values.
 */
const useBuiltinVariables = (dashboard: DashboardResource): BuiltinVariableDefinition[] => {
  const { data: pluginBuiltins } = usePluginBuiltinVariableDefinitions();
  const { name, project } = dashboard.metadata;
  return useMemo(
    () => [
      {
        kind: 'BuiltinVariable',
        spec: {
          name: '__dashboard',
          value: () => name,
          source: 'Dashboard',
          display: { name: '__dashboard', description: 'The name of the current dashboard', hidden: true },
        },
      },
      {
        kind: 'BuiltinVariable',
        spec: {
          name: '__project',
          value: () => project,
          source: 'Dashboard',
          display: { name: '__project', description: 'The name of the current dashboard project', hidden: true },
        },
      },
      ...(pluginBuiltins ?? []),
    ],
    [name, project, pluginBuiltins],
  );
};

/**
 * The dashboard inside Perses's plugin registry: its time range and variables, kept in the URL
 * (start, end, refresh, var-<name>) as Perses's own view and odh-dashboard keep them, so a reload or
 * a link with var-<name> opens it as it was.
 */
const DashboardBody: React.FC<Props> = ({ dashboard }) => {
  const [timeZone, setTimeZone] = useState('local');
  const initialTimeRange = useInitialTimeRange(dashboard.spec.duration || '1h');
  const initialRefreshInterval = useInitialRefreshInterval(dashboard.spec.refreshInterval || '0s');
  const builtinVariables = useBuiltinVariables(dashboard);
  return (
    <TimeRangeProviderWithQueryParams
      initialTimeRange={initialTimeRange}
      initialRefreshInterval={initialRefreshInterval}
    >
      <VariableProviderWithQueryParams
        initialVariableDefinitions={dashboard.spec.variables}
        builtinVariableDefinitions={builtinVariables}
      >
        <DatasourceStoreProvider dashboardResource={dashboard} datasourceApi={datasourceApi}>
          <DataQueriesProvider definitions={[]}>
            <DashboardProvider initialState={{ isEditMode: false, dashboardResource: dashboard }}>
              {/* One row: the dashboard's variables on the left, its time controls on the right, both
                  on the row's bottom edge so the inputs line up. */}
              <Flex
                justifyContent={{ default: 'justifyContentSpaceBetween' }}
                alignItems={{ default: 'alignItemsFlexEnd' }}
                flexWrap={{ default: 'wrap' }}
              >
                <FlexItem grow={{ default: 'grow' }} className="pf-v6-u-pb-sm">
                  {/* The padding offsets the toolbar's own margin-bottom: -8px, which lets the select
                      hang 8px below the edge this row aligns on. */}
                  <DashboardStickyToolbar initialVariableIsSticky={false} />
                </FlexItem>
                <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
                  <FlexItem>Time period:</FlexItem>
                  {/* As odh-dashboard's HeaderTimeRangeControls: no zoom buttons and no refresh-interval
                      picker, whose fixed options (Off to 60s) can't show a dashboard's own interval
                      such as ACM's 5m. That interval still applies; the refresh button refreshes now. */}
                  <TimeRangeControls
                    showTimeRangeSelector
                    showRefreshButton
                    showRefreshInterval={false}
                    showCustomTimeRange
                    showZoomButtons={false}
                    timeZone={timeZone}
                    onTimeZoneChange={(option) => setTimeZone(option.value)}
                  />
                </Flex>
              </Flex>
              <Dashboard />
            </DashboardProvider>
          </DataQueriesProvider>
        </DatasourceStoreProvider>
      </VariableProviderWithQueryParams>
    </TimeRangeProviderWithQueryParams>
  );
};

/** The dashboard's time range, refresh, variables and panels, in the page's light or dark theme. */
const PersesDashboardView: React.FC<Props> = ({ dashboard }) => {
  const { muiTheme, chartsTheme } = themeFor(usePageTheme());
  return (
    <QueryClientProvider client={queryClient}>
      <QueryParamProvider adapter={ReactRouter6Adapter}>
        <ThemeProvider theme={muiTheme}>
          <ChartsProvider chartsTheme={chartsTheme}>
            <SnackbarProvider anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} variant="default">
              <PluginRegistry pluginLoader={pluginLoader}>
                <PanelFocusProvider>
                  <DashboardBody dashboard={dashboard} />
                </PanelFocusProvider>
              </PluginRegistry>
            </SnackbarProvider>
          </ChartsProvider>
        </ThemeProvider>
      </QueryParamProvider>
    </QueryClientProvider>
  );
};

export default PersesDashboardView;
