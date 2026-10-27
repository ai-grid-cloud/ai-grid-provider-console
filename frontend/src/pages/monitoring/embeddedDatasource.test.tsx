import { useEffect, useState } from 'react';
import { render, screen } from '@testing-library/react';
import type { DashboardResource } from '@perses-dev/client';
import { DatasourceStoreProvider } from '@perses-dev/dashboards';
import { PluginRegistry, useDatasourceStore } from '@perses-dev/plugin-system';
import { afterEach, expect, it, vi } from 'vitest';
import { RelayDatasourceApi } from './persesDatasourceApi';

// The datasource lookup needs no plugin (the plugin packages don't load under vitest).
const pluginLoader = {
  getInstalledPlugins: () => Promise.resolve([]),
  importPluginModule: () => Promise.resolve({}),
};

afterEach(() => vi.unstubAllGlobals());

// A dashboard that defines its own datasource, as a dashboard author may.
const dashboard = {
  kind: 'Dashboard',
  metadata: { project: 'ai-grid', name: 'dashboard-1-fleet' },
  spec: {
    duration: '1h',
    variables: [],
    panels: {},
    layouts: [],
    datasources: {
      theirs: { default: true, plugin: { kind: 'PrometheusDatasource', spec: { directUrl: 'https://example.com' } } },
    },
  },
} as unknown as DashboardResource;

/**
 * Looks the datasource up as the store does for a panel's query (getDatasourceClient runs the same
 * lookup, then loads the plugin), and shows what it got.
 */
const Lookup: React.FC<{ name?: string }> = ({ name }) => {
  const { getDatasource } = useDatasourceStore();
  const [outcome, setOutcome] = useState('looking up');
  useEffect(() => {
    getDatasource({ kind: 'PrometheusDatasource', name }).then(
      () => setOutcome("the dashboard's datasource"),
      (err: Error) => setOutcome(`error: ${err.message}`),
    );
  }, [getDatasource, name]);
  return <div data-testid="outcome">{outcome}</div>;
};

// Perses looks datasources up inside its async datasource store, so the refusal reaches the panel's
// query as an error, which the panel shows in its own error boundary (dashboards PanelContent), and
// nothing is sent to the relay.
// By name, and as the default a panel gets when its query names no datasource.
it.each([
  ['by name', 'theirs'],
  ['as the default', undefined],
])("fails a panel's lookup of a datasource the dashboard defines (%s), without a request", async (_, name) => {
  const fetchFn = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchFn);
  render(
    <PluginRegistry pluginLoader={pluginLoader}>
      <DatasourceStoreProvider dashboardResource={dashboard} datasourceApi={new RelayDatasourceApi()}>
        <Lookup name={name} />
      </DatasourceStoreProvider>
    </PluginRegistry>,
  );
  expect(await screen.findByText(/^error: .*defined in the dashboard/)).toBeInTheDocument();
  expect(fetchFn).not.toHaveBeenCalled();
});
