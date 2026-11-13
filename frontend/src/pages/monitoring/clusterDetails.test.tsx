import { useMemo } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryParamProvider } from 'use-query-params';
import { ReactRouter6Adapter } from 'use-query-params/adapters/react-router-6';
import { Code, ConnectError } from '@connectrpc/connect';
import type { DashboardResource } from '@perses-dev/client';
import type { VariableDefinition } from '@perses-dev/spec';
import {
  useVariableDefinitionActions,
  useVariableDefinitionStates,
  VariableProviderWithQueryParams,
} from '@perses-dev/dashboards';
import { TimeRangeProviderBasic } from '@perses-dev/plugin-system';
import { BackendProvider } from '../../api/connect/BackendProvider';
import { fakeClients, type FakeBackend } from '../../api/connect/testing';
import { ClusterDetailsVariables } from './ClusterDetailsVariables';
import {
  API_SERVER,
  CHANNEL,
  CLUSTER_VARIABLE,
  clusterDetailsVariables,
  INFRASTRUCTURE_PROVIDER,
  OPENSHIFT_VERSION,
  selectedCluster,
} from './clusterDetails';
import { useClusterLookup } from './useClusterLookup';

const DETAILS = [INFRASTRUCTURE_PROVIDER, OPENSHIFT_VERSION, CHANNEL, API_SERVER];

const text = (name: string): VariableDefinition => ({
  kind: 'TextVariable',
  spec: { name, value: 'N/A', display: { name, hidden: true } },
});

// As the AI grid cluster dashboard defines its cluster variable: multi-select, All by default.
const clusterVariable: VariableDefinition = {
  kind: 'ListVariable',
  spec: {
    name: CLUSTER_VARIABLE,
    display: { name: 'Cluster', hidden: false },
    allowAllValue: true,
    allowMultiple: true,
    customAllValue: '.*',
    defaultValue: '$__all',
    plugin: { kind: 'PrometheusLabelValuesVariable', spec: { labelName: 'cluster' } },
  },
};

const dashboard = (variables: VariableDefinition[]) =>
  ({
    kind: 'Dashboard',
    metadata: { project: 'redhat-ods-monitoring', name: 'dashboard-0-cluster-admin' },
    spec: { duration: '1h', variables, panels: {}, layouts: [] },
  }) as unknown as DashboardResource;

const clusterDashboard = dashboard([clusterVariable, ...DETAILS.map(text)]);

const claims = (entries: Record<string, string>) => Object.entries(entries).map(([name, value]) => ({ name, value }));

const siteA = {
  id: 'site-a',
  status: {
    clusterClaims: claims({
      'platform.open-cluster-management.io': 'AWS',
      'version.openshift.io': '4.21.36',
      'apiserverurl.openshift.io': 'https://api.site-a.example.com:6443',
    }),
  },
};
// A cluster whose klusterlet reports no OpenShift claims.
const siteB = {
  id: 'site-b',
  status: { clusterClaims: claims({ 'platform.open-cluster-management.io': 'BareMetal' }) },
};

const backendWith = (items: object[]): FakeBackend => ({
  clusters: { list: vi.fn(() => ({ items, size: items.length, total: items.length })) },
});

/** Every variable's value, and buttons that pick clusters as the dashboard's select does. */
const Probe: React.FC = () => {
  const states = useVariableDefinitionStates();
  const { setVariableValue } = useVariableDefinitionActions();
  return (
    <>
      <dl aria-label="Variables">
        {Object.entries(states).map(([name, state]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd data-testid={name}>{String(state.value)}</dd>
          </div>
        ))}
      </dl>
      <button onClick={() => setVariableValue(CLUSTER_VARIABLE, ['site-a'])}>Select site-a</button>
      <button onClick={() => setVariableValue(CLUSTER_VARIABLE, ['site-a', 'site-b'])}>Select both</button>
      <button onClick={() => setVariableValue(CLUSTER_VARIABLE, '$__all')}>Select all</button>
    </>
  );
};

/** As PersesDashboardView wires them: the lookup outside Perses, the variables inside its provider. */
const View: React.FC<{ dashboard: DashboardResource }> = ({ dashboard }) => {
  const names = useMemo(() => clusterDetailsVariables(dashboard), [dashboard]);
  const lookup = useClusterLookup(names.length > 0);
  return (
    <TimeRangeProviderBasic initialTimeRange={{ pastDuration: '1h' }}>
      <VariableProviderWithQueryParams initialVariableDefinitions={dashboard.spec.variables}>
        {names.length > 0 && <ClusterDetailsVariables names={names} lookup={lookup} />}
        <Probe />
      </VariableProviderWithQueryParams>
    </TimeRangeProviderBasic>
  );
};

const renderView = (board: DashboardResource, backend: FakeBackend, url = '/monitoring') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryParamProvider adapter={ReactRouter6Adapter}>
        <BackendProvider transport={fakeClients(backend).transport} checkSession={vi.fn()}>
          <View dashboard={board} />
        </BackendProvider>
      </QueryParamProvider>
    </MemoryRouter>,
  );

const expectDetails = async (provider: string, version: string, channel: string, api: string) => {
  await waitFor(() => expect(screen.getByTestId(INFRASTRUCTURE_PROVIDER)).toHaveTextContent(provider));
  expect(screen.getByTestId(OPENSHIFT_VERSION)).toHaveTextContent(version);
  expect(screen.getByTestId(CHANNEL)).toHaveTextContent(channel);
  expect(screen.getByTestId(API_SERVER)).toHaveTextContent(api);
};

it("fills in the selected cluster's provider, OpenShift version and API server from its claims", async () => {
  const user = userEvent.setup();
  renderView(clusterDashboard, backendWith([siteA, siteB]));
  await user.click(screen.getByRole('button', { name: 'Select site-a' }));
  // The hub has no record of the OpenShift AI operator's channel.
  await expectDetails('AWS', '4.21.36', 'Not available', 'https://api.site-a.example.com:6443');
});

it('reads a cluster the URL selects', async () => {
  renderView(clusterDashboard, backendWith([siteA]), `/monitoring?var-${CLUSTER_VARIABLE}=site-a`);
  await expectDetails('AWS', '4.21.36', 'Not available', 'https://api.site-a.example.com:6443');
});

it('asks for one cluster when All or several are selected', async () => {
  const user = userEvent.setup();
  renderView(clusterDashboard, backendWith([siteA, siteB]));
  // All, the dashboard's default.
  await expectDetails('Select one cluster', 'Select one cluster', 'Select one cluster', 'Select one cluster');
  await user.click(screen.getByRole('button', { name: 'Select site-a' }));
  await expectDetails('AWS', '4.21.36', 'Not available', 'https://api.site-a.example.com:6443');
  await user.click(screen.getByRole('button', { name: 'Select both' }));
  await expectDetails('Select one cluster', 'Select one cluster', 'Select one cluster', 'Select one cluster');
  await user.click(screen.getByRole('button', { name: 'Select all' }));
  await expectDetails('Select one cluster', 'Select one cluster', 'Select one cluster', 'Select one cluster');
});

it('says "Not available" for a claim the hub does not report', async () => {
  renderView(clusterDashboard, backendWith([siteB]), `/monitoring?var-${CLUSTER_VARIABLE}=site-b`);
  await expectDetails('BareMetal', 'Not available', 'Not available', 'Not available');
});

it('says "Not available" for a cluster the hub does not list', async () => {
  renderView(clusterDashboard, backendWith([siteB]), `/monitoring?var-${CLUSTER_VARIABLE}=site-z`);
  await expectDetails('Not available', 'Not available', 'Not available', 'Not available');
});

it('says "Not available" when the clusters cannot be loaded', async () => {
  const backend: FakeBackend = {
    clusters: {
      list: () => {
        throw new ConnectError('The hub is unavailable.', Code.Unavailable);
      },
    },
  };
  renderView(clusterDashboard, backend, `/monitoring?var-${CLUSTER_VARIABLE}=site-a`);
  await expectDetails('Not available', 'Not available', 'Not available', 'Not available');
});

it('sets nothing, and reads no clusters, for a dashboard without cluster details', async () => {
  const backend = backendWith([siteA]);
  renderView(dashboard([clusterVariable, text('SUMMARY')]), backend, `/monitoring?var-${CLUSTER_VARIABLE}=site-a`);
  expect(await screen.findByTestId('SUMMARY')).toHaveTextContent('N/A');
  expect(screen.queryByTestId(INFRASTRUCTURE_PROVIDER)).not.toBeInTheDocument();
  expect(backend.clusters?.list).not.toHaveBeenCalled();
});

it('sets only the cluster details a dashboard defines', () => {
  expect(clusterDetailsVariables(dashboard([clusterVariable, text(API_SERVER), text('SUMMARY')]))).toEqual([
    API_SERVER,
  ]);
});

it.each([
  ['site-a', 'site-a'],
  [['site-a'], 'site-a'],
  ['$__all', undefined],
  [['site-a', 'site-b'], undefined],
  [[], undefined],
  ['', undefined],
  [null, undefined],
])('reads the cluster variable %j as %s', (value, want) => {
  expect(selectedCluster(value)).toBe(want);
});
