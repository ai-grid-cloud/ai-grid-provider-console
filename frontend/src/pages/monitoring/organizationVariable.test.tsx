import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryParamProvider } from 'use-query-params';
import { ReactRouter6Adapter } from 'use-query-params/adapters/react-router-6';
import { Code, ConnectError } from '@connectrpc/connect';
import type { DashboardResource } from '@perses-dev/client';
import type { ListVariableDefinition, VariableDefinition } from '@perses-dev/spec';
import { PluginRegistry, TimeRangeProviderBasic } from '@perses-dev/plugin-system';
import {
  DatasourceStoreProvider,
  Variable,
  VariableProviderWithQueryParams,
  useVariableDefinitionStates,
} from '@perses-dev/dashboards';
import { BackendProvider } from '../../api/connect/BackendProvider';
import { fakeClients, type FakeBackend } from '../../api/connect/testing';
import { ORGANIZATION_VARIABLE, withOrganizationNames } from './organizationVariable';
import PersesDashboardView from './PersesDashboardView';
import { RelayDatasourceApi } from './persesDatasourceApi';
import { pluginLoader } from './persesPlugins';
import { RELABELED_LIST_VARIABLE } from './relabeledVariable';

const loki = (labelName: string, matcher: string) => ({
  kind: 'LokiLabelValuesVariable',
  spec: { datasource: { kind: 'LokiDatasource', name: 'usage-logs-all' }, labelName, matchers: [matcher] },
});

// As the Usage dashboard defines it (ai-grid-cluster-gitops
// apps/ai-grid-o11y/manifests/usage-logs-admin-dashboard.yaml).
const organizationVariable: ListVariableDefinition = {
  kind: 'ListVariable',
  spec: {
    name: ORGANIZATION_VARIABLE,
    display: { name: 'Organization' },
    allowMultiple: true,
    allowAllValue: true,
    customAllValue: '.*',
    defaultValue: '$__all',
    plugin: loki('organization_id', '{service_name="models-as-a-service", organization_id!="-"}'),
  },
};

// A variable whose Loki request carries the organization variable's value, as a panel's query does.
const modelVariable = {
  kind: 'ListVariable',
  spec: {
    name: 'model',
    display: { name: 'Model' },
    allowMultiple: false,
    allowAllValue: false,
    plugin: loki('model', '{service_name="models-as-a-service", organization_id=~"$organization_id"}'),
  },
} as VariableDefinition;

const dashboard = (variables: VariableDefinition[]) =>
  ({
    kind: 'Dashboard',
    metadata: { project: 'redhat-ods-monitoring', name: 'dashboard-4-maas-usage-logs-admin' },
    spec: { duration: '1h', variables, panels: {}, layouts: [] },
  }) as unknown as DashboardResource;

const acme = { id: 'uuid-1', name: 'Acme' };
const globex = { id: 'uuid-2', name: 'Globex' };

describe('withOrganizationNames', () => {
  const usage = dashboard([organizationVariable, modelVariable]);

  it("labels the organization variable's values with the organizations' names, keeping its own plugin", () => {
    const [org, model] = withOrganizationNames(usage, [acme, globex]).spec.variables;
    expect(org).toEqual({
      ...organizationVariable,
      spec: {
        ...organizationVariable.spec,
        plugin: {
          kind: RELABELED_LIST_VARIABLE,
          spec: { plugin: organizationVariable.spec.plugin, labels: { 'uuid-1': 'Acme', 'uuid-2': 'Globex' } },
        },
      },
    });
    expect(model).toBe(modelVariable);
  });

  it('keeps its display, All option, custom All value and default', () => {
    const [org] = withOrganizationNames(usage, [acme]).spec.variables;
    expect(org.spec).toMatchObject({
      name: ORGANIZATION_VARIABLE,
      display: { name: 'Organization' },
      allowMultiple: true,
      allowAllValue: true,
      customAllValue: '.*',
      defaultValue: '$__all',
    });
  });

  it('leaves the original dashboard as it was', () => {
    withOrganizationNames(usage, [acme]);
    expect(usage.spec.variables).toEqual([organizationVariable, modelVariable]);
  });

  it('returns a dashboard without the variable, or with no names to give, as it is', () => {
    const other = dashboard([modelVariable]);
    expect(withOrganizationNames(other, [acme])).toBe(other);
    expect(withOrganizationNames(usage, [])).toBe(usage);
    // An organization whose name is its ID has nothing to add.
    expect(withOrganizationNames(usage, [{ id: 'uuid-3', name: 'uuid-3' }])).toBe(usage);
  });
});

// Perses's queries go through the relay to the hub's Perses and on to Loki: answered here.
const lokiAnswers = (values: Record<string, string[]>) => {
  const requests: URL[] = [];
  const fetchFn = vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input), 'http://console.test');
    requests.push(url);
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    if (url.pathname.endsWith('/globaldatasources')) {
      return json([
        {
          kind: 'GlobalDatasource',
          metadata: { name: 'usage-logs-all' },
          spec: { default: true, plugin: { kind: 'LokiDatasource', spec: { proxy: { kind: 'HTTPProxy', spec: {} } } } },
        },
      ]);
    }
    if (url.pathname.endsWith('/datasources')) {
      return json([]);
    }
    const label = /\/loki\/api\/v1\/label\/([^/]+)\/values$/.exec(url.pathname)?.[1];
    if (label) {
      return json({ status: 'success', data: values[label] ?? [] });
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchFn);
  return requests;
};

const Url: React.FC = () => <div data-testid="url">{useLocation().search}</div>;

const Value: React.FC<{ name: string }> = ({ name }) => (
  <div data-testid="value">{JSON.stringify(useVariableDefinitionStates()[name]?.value)}</div>
);

/** One variable, rendered with Perses's own select and the console's bundled plugins. */
const renderVariable = (definition: VariableDefinition, url = '/monitoring') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryParamProvider adapter={ReactRouter6Adapter}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: 0 } } })}>
          <PluginRegistry pluginLoader={pluginLoader}>
            <TimeRangeProviderBasic initialTimeRange={{ pastDuration: '1h' }}>
              <VariableProviderWithQueryParams initialVariableDefinitions={[definition]}>
                <DatasourceStoreProvider
                  dashboardResource={dashboard([definition])}
                  datasourceApi={new RelayDatasourceApi()}
                >
                  <Variable name={definition.spec.name} source={undefined} />
                  <Value name={definition.spec.name} />
                  <Url />
                </DatasourceStoreProvider>
              </VariableProviderWithQueryParams>
            </TimeRangeProviderBasic>
          </PluginRegistry>
        </QueryClientProvider>
      </QueryParamProvider>
    </MemoryRouter>,
  );

// What the console's relabeling rests on: Perses's select shows an option's label and the
// dashboard takes its value.
it("shows a static list option's label in Perses's select, and selects its value", async () => {
  const user = userEvent.setup();
  renderVariable({
    kind: 'ListVariable',
    spec: {
      name: ORGANIZATION_VARIABLE,
      display: { name: 'Organization' },
      allowMultiple: false,
      allowAllValue: false,
      plugin: { kind: 'StaticListVariable', spec: { values: [{ value: 'uuid-1', label: 'Acme' }] } },
    },
  } as VariableDefinition);
  const select = await screen.findByRole('combobox', { name: 'Organization' });
  await waitFor(() => expect(select).toHaveValue('Acme'));
  await user.click(select);
  const listbox = await screen.findByRole('listbox');
  expect(within(listbox).queryByText('uuid-1')).not.toBeInTheDocument();
  await user.click(within(listbox).getByRole('option', { name: 'Acme' }));
  await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('"uuid-1"'));
  expect(screen.getByTestId('url')).toHaveTextContent('var-organization_id=uuid-1');
});

const renderView = (board: DashboardResource, backend: FakeBackend, url = '/monitoring') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <BackendProvider transport={fakeClients(backend).transport} checkSession={vi.fn()}>
        <PersesDashboardView dashboard={board} />
        <Url />
      </BackendProvider>
    </MemoryRouter>,
  );

const tenants = (items: { id: string; name: string }[]): FakeBackend => ({
  tenants: {
    list: vi.fn(() => ({
      items: items.map(({ id, name }) => ({ id, metadata: { name } })),
      size: items.length,
      total: items.length,
    })),
  },
});

/** The values the Loki label request for `label` filtered on, newest last. */
const lokiQueries = (requests: URL[], label: string) =>
  requests.filter((u) => u.pathname.endsWith(`/label/${label}/values`)).map((u) => u.searchParams.get('query'));

describe('the Usage dashboard on the Monitoring page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the organizations in the select, offers an ID the console doesn't list, and filters by ID", async () => {
    const user = userEvent.setup();
    const requests = lokiAnswers({ organization_id: ['uuid-1', 'uuid-2', 'uuid-9'], model: ['m1'] });
    renderView(dashboard([organizationVariable, modelVariable]), tenants([acme, globex]));
    const select = await screen.findByRole('combobox', { name: 'Organization' });
    // All, the dashboard's default, is its custom All value.
    await waitFor(() =>
      expect(lokiQueries(requests, 'model')).toContain('{service_name="models-as-a-service", organization_id=~".*"}'),
    );
    await user.click(select);
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All', 'Acme', 'Globex', 'uuid-9']);
    await user.click(within(listbox).getByRole('option', { name: 'Acme' }));
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('var-organization_id=uuid-1'));
    await waitFor(() =>
      expect(lokiQueries(requests, 'model').at(-1)).toBe(
        // Perses joins a multi-value selection as a regex group.
        '{service_name="models-as-a-service", organization_id=~"(uuid-1)"}',
      ),
    );
  });

  it('selects the organization var-organization_id names, by its name', async () => {
    lokiAnswers({ organization_id: ['uuid-1', 'uuid-2'] });
    renderView(dashboard([organizationVariable]), tenants([acme, globex]), '/monitoring?var-organization_id=uuid-2');
    const select = await screen.findByRole('combobox', { name: 'Organization' });
    const field = select.closest('.MuiAutocomplete-root') as HTMLElement;
    await waitFor(() => expect(within(field).getByText('Globex')).toBeVisible());
    expect(within(field).queryByText('Acme')).not.toBeInTheDocument();
  });

  it("shows the IDs when the organizations can't be loaded", async () => {
    const user = userEvent.setup();
    lokiAnswers({ organization_id: ['uuid-1'] });
    const backend: FakeBackend = {
      tenants: {
        list: () => {
          throw new ConnectError('The backend is unavailable.', Code.Unavailable);
        },
      },
    };
    renderView(dashboard([organizationVariable]), backend);
    await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
    expect(await within(await screen.findByRole('listbox')).findByRole('option', { name: 'uuid-1' })).toBeVisible();
  });

  it('reads no organizations for a dashboard without the variable', async () => {
    lokiAnswers({ model: ['m1'] });
    const backend = tenants([acme]);
    renderView(dashboard([modelVariable]), backend);
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeInTheDocument();
    expect(backend.tenants?.list).not.toHaveBeenCalled();
  });
});
