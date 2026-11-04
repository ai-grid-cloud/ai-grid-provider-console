import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import type { DashboardResource } from '@perses-dev/client';
import { vi } from 'vitest';
import { RelayedError, ServiceError } from '../api/ConsoleService';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import { monitoringLinkFor, monitoringTabs } from '../api/monitoring';
import type { MonitoringExtraProject } from '../api/types';
import { renderAt } from './render';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/monitoring/MonitoringPage';
import { TestApp } from './TestApp';

// Perses's charts don't render in jsdom; the page is tested up to the dashboard it hands over.
// It also renders links as a dashboard's panels would.
// Its button stands for a burst of relay 401s, from a dashboard whose panels all fail at once.
vi.mock('../pages/monitoring/PersesDashboardView', async () => {
  const { useConsoleSession } = await import('../context/useConsoleSession');
  const RelayUnauthorized = () => {
    const { checkSession } = useConsoleSession();
    return (
      <button type="button" onClick={() => [1, 2, 3].forEach(() => checkSession?.())}>
        panels answered 401
      </button>
    );
  };
  return {
    default: ({ dashboard }: { dashboard: DashboardResource }) => (
      <div>
        <RelayUnauthorized />
        <div data-testid="perses-dashboard">
          {dashboard.metadata.project}/{dashboard.metadata.name}
        </div>
        <a href="/monitoring/v2/dashboards/view?dashboard=dashboard-2-usage&project=ai-grid&var-cluster=site-a">
          usage of site-a
        </a>
        <a href="/monitoring/v2/dashboards/view?dashboard=acm-optimization-overview&project=ai-grid">optimization</a>
        <a href="/monitoring/v2/dashboards/view?dashboard=acm-optimization-overview&project=acm&var-cluster=site-b">
          acm optimization
        </a>
      </div>
    ),
  };
});

const dashboard = (project: string, name: string, title?: string) =>
  ({
    kind: 'Dashboard',
    metadata: { project, name },
    spec: { display: title ? { name: title } : undefined, duration: '1h', variables: [], panels: {}, layouts: [] },
  }) as unknown as DashboardResource;

const withMonitoring = (
  persesProject: string,
  dashboards: DashboardResource[],
  extraDashboards: MonitoringExtraProject[] = [],
) => {
  const service = new MockConsoleService();
  service.config = { ...service.config, monitoring: { enabled: true, persesProject, extraDashboards } };
  service.monitoringDashboards = dashboards;
  return service;
};

const acmDashboards = [
  dashboard('acm', 'acm-clusters-overview', 'ACM Clusters Overview'),
  dashboard('acm', 'acm-optimization-overview', 'ACM Resource Optimization / Cluster'),
  dashboard('acm', 'acm-node-rsrc-use', 'USE Method / Node'),
];

/** The chart's list for `acm`: two of its dashboards and one the hub doesn't have. */
const acmExtra: MonitoringExtraProject[] = [
  {
    project: 'acm',
    dashboards: [
      { name: 'acm-clusters-overview', title: 'Clusters overview' },
      { name: 'acm-missing' },
      { name: 'acm-optimization-overview' },
    ],
    datasources: ['rbac-query-proxy-datasource'],
  },
];

const hub = [
  dashboard('ai-grid', 'dashboard-2-usage', 'Token usage'),
  dashboard('ai-grid', 'dashboard-1-fleet', 'Fleet health'),
  dashboard('ai-grid', 'acm-clusters-overview', 'ACM Clusters Overview'),
  dashboard('other', 'dashboard-1-fleet', 'Someone else'),
];

it("shows the configured project's dashboard-* dashboards as tabs, the first one open", async () => {
  renderAt('/monitoring', withMonitoring('ai-grid', hub));
  const tabs = within(await screen.findByTestId('monitoring-tabs')).getByRole('tablist');
  expect(
    within(tabs)
      .getAllByRole('tab')
      .map((t) => t.textContent),
  ).toEqual(['Fleet health', 'Token usage']);
  expect(within(tabs).getByRole('tab', { name: 'Fleet health' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet');
});

it('opens the tab ?dashboard= names, and another one on click', async () => {
  const user = userEvent.setup();
  renderAt('/monitoring?dashboard=dashboard-2-usage', withMonitoring('ai-grid', hub));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-2-usage');
  await user.click(screen.getByRole('tab', { name: 'Fleet health' }));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet');
  expect(screen.getByRole('tab', { name: 'Fleet health' })).toHaveAttribute('aria-selected', 'true');
});

it('says when the hub has no such dashboards yet', async () => {
  renderAt('/monitoring', withMonitoring('ai-grid', [dashboard('ai-grid', 'acm-clusters-overview')]));
  expect(await screen.findByRole('heading', { name: 'No dashboards' })).toBeVisible();
  expect(screen.getByText(/whose name starts with/)).toBeVisible();
  expect(screen.queryByTestId('perses-dashboard')).not.toBeInTheDocument();
});

it("says when the caller can't read the dashboards", async () => {
  const service = withMonitoring('ai-grid', []);
  service.listMonitoringDashboards = () => Promise.reject(new ServiceError(403, 'forbidden: project ai-grid'));
  renderAt('/monitoring', service);
  expect(await screen.findByRole('heading', { name: 'Access permissions needed' })).toBeVisible();
  expect(screen.getByText('forbidden: project ai-grid')).toBeVisible();
  expect(screen.getByText('To view dashboards, ask your hub administrator for access.')).toBeVisible();
});

it("says when the dashboards can't be loaded, and retries", async () => {
  const user = userEvent.setup();
  const service = withMonitoring('ai-grid', hub);
  const list = service.listMonitoringDashboards;
  service.listMonitoringDashboards = () => Promise.reject(new ServiceError(502, 'perses is unavailable'));
  renderAt('/monitoring', service);
  expect(await screen.findByRole('heading', { name: 'Unable to load dashboards' })).toBeVisible();
  service.listMonitoringDashboards = list;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet');
});

it("says when the console's configuration can't be read, instead of falling back", async () => {
  const user = userEvent.setup();
  const service = withMonitoring('ai-grid', hub);
  const getConfig = service.getConfig;
  service.getConfig = () => Promise.reject(new ServiceError(0, 'Unable to reach the console server.'));
  renderAt('/monitoring', service);
  expect(await screen.findByRole('heading', { name: 'Unable to load console settings' })).toBeVisible();
  expect(screen.queryByText(/Cluster availability, gateway performance/)).not.toBeInTheDocument();
  service.getConfig = getConfig;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet');
});

it("keeps the AI Grid overview's metrics when the console relays to no Perses", async () => {
  renderAt('/monitoring', new MockConsoleService());
  expect(
    await screen.findByText('Cluster availability, gateway performance, and resource use across AI Grid.'),
  ).toBeVisible();
  expect(screen.queryByTestId('monitoring-tabs')).not.toBeInTheDocument();
});

it("opens a dashboard's link to another tab here, and says when a link goes elsewhere", async () => {
  const user = userEvent.setup();
  renderAt('/monitoring', withMonitoring('ai-grid', hub));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet');
  await user.click(screen.getByRole('link', { name: 'optimization' }));
  expect(await screen.findByText('Link not available in this console')).toBeVisible();
  expect(screen.getByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet');
  await user.click(screen.getByRole('link', { name: 'usage of site-a' }));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-2-usage');
  expect(screen.getByRole('tab', { name: 'Token usage' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByText('Link not available in this console')).not.toBeInTheDocument();
});

describe("other projects' dashboards", () => {
  it("adds the listed ones that are there as tabs after the project's, and none it doesn't list", async () => {
    renderAt('/monitoring', withMonitoring('ai-grid', [...hub, ...acmDashboards], acmExtra));
    const tabs = within(await screen.findByTestId('monitoring-tabs')).getByRole('tablist');
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Fleet health', 'Token usage', 'Clusters overview', 'ACM Resource Optimization / Cluster']);
  });

  it("keeps the project's tabs when another project's dashboard fails, and says which", async () => {
    const service = withMonitoring('ai-grid', [...hub, ...acmDashboards], acmExtra);
    const get = service.getMonitoringDashboard;
    service.getMonitoringDashboard = (project, name) =>
      name === 'acm-optimization-overview'
        ? Promise.reject(new RelayedError(502, 'perses is unavailable'))
        : get(project, name);
    renderAt('/monitoring', service);
    const tabs = within(await screen.findByTestId('monitoring-tabs')).getByRole('tablist');
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Fleet health', 'Token usage', 'Clusters overview']);
    expect(screen.getByText('Some dashboards could not be loaded')).toBeVisible();
    expect(screen.getByText(/acm-optimization-overview\. Refresh the page/)).toBeVisible();
  });

  it("fails the page on another project's 401, so the session is checked", async () => {
    const service = withMonitoring('ai-grid', [...hub, ...acmDashboards], acmExtra);
    service.getMonitoringDashboard = () => Promise.reject(new RelayedError(401, 'Perses refused the token'));
    renderAt('/monitoring', service);
    expect(await screen.findByText('Perses refused the token')).toBeVisible();
    expect(screen.queryByTestId('monitoring-tabs')).not.toBeInTheDocument();
  });

  it('opens one by ?dashboard=<project>/<name>', async () => {
    renderAt(
      '/monitoring?dashboard=acm%2Facm-clusters-overview',
      withMonitoring('ai-grid', [...hub, ...acmDashboards], acmExtra),
    );
    expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('acm/acm-clusters-overview');
    expect(screen.getByRole('tab', { name: 'Clusters overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('are tabs even when the project has no dashboard-* dashboards', async () => {
    renderAt('/monitoring', withMonitoring('ai-grid', acmDashboards, acmExtra));
    expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('acm/acm-clusters-overview');
  });

  it("follows a dashboard's link to another listed dashboard of its project", async () => {
    const user = userEvent.setup();
    renderAt(
      '/monitoring?dashboard=acm%2Facm-clusters-overview',
      withMonitoring('ai-grid', [...hub, ...acmDashboards], acmExtra),
    );
    expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('acm/acm-clusters-overview');
    await user.click(screen.getByRole('link', { name: 'acm optimization' }));
    expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('acm/acm-optimization-overview');
    expect(screen.getByRole('tab', { name: 'ACM Resource Optimization / Cluster' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The main project's link to the same name is not that tab.
    await user.click(screen.getByRole('link', { name: 'optimization' }));
    expect(await screen.findByText('Link not available in this console')).toBeVisible();
  });
});

describe('monitoringLinkFor', () => {
  // The page's tabs: the configured project's only.
  const tabs = monitoringTabs(hub.filter((d) => d.metadata.project === 'ai-grid'));
  const withACM = monitoringTabs(
    hub.filter((d) => d.metadata.project === 'ai-grid'),
    acmDashboards.map((dashboard) => ({ dashboard })),
  );

  it("maps a link in another project's dashboard to a tab of that project, by its key", () => {
    expect(
      monitoringLinkFor(
        '/monitoring/v2/dashboards/view?dashboard=acm-optimization-overview&project=acm&var-cluster=site-a',
        withACM,
        'acm',
      ),
    ).toBe('/monitoring?dashboard=acm%2Facm-optimization-overview&var-cluster=site-a');
    // No project: the one the link is in.
    expect(
      monitoringLinkFor('/monitoring/v2/dashboards/view?dashboard=acm-optimization-overview', withACM, 'acm'),
    ).toBe('/monitoring?dashboard=acm%2Facm-optimization-overview');
    // From the main project's dashboard, the name alone is that project's.
    expect(
      monitoringLinkFor('/monitoring/v2/dashboards/view?dashboard=acm-optimization-overview', withACM, 'ai-grid'),
    ).toBe(undefined);
  });

  it("maps the OpenShift console's and Perses's dashboard links to a tab, keeping time and variables", () => {
    expect(
      monitoringLinkFor(
        '/monitoring/v2/dashboards/view?dashboard=dashboard-2-usage&project=ai-grid&var-cluster=site-a&start=6h&x=1',
        tabs,
        'ai-grid',
      ),
    ).toBe('/monitoring?dashboard=dashboard-2-usage&var-cluster=site-a&start=6h');
    expect(monitoringLinkFor('/projects/ai-grid/dashboards/dashboard-1-fleet?var-a=b', tabs, 'ai-grid')).toBe(
      '/monitoring?dashboard=dashboard-1-fleet&var-a=b',
    );
  });

  it('reads a link without a project as one to the same project', () => {
    expect(monitoringLinkFor('/monitoring/v2/dashboards/view?dashboard=dashboard-1-fleet', tabs, 'ai-grid')).toBe(
      '/monitoring?dashboard=dashboard-1-fleet',
    );
  });

  it('answers undefined for a dashboard that is not a tab, another project, or another page', () => {
    expect(monitoringLinkFor('/monitoring/v2/dashboards/view?dashboard=acm-clusters-overview', tabs, 'ai-grid')).toBe(
      undefined,
    );
    expect(
      monitoringLinkFor('/monitoring/v2/dashboards/view?dashboard=dashboard-2-usage&project=other', tabs, 'ai-grid'),
    ).toBe(undefined);
    expect(monitoringLinkFor('/projects/other/dashboards/dashboard-1-fleet', tabs, 'ai-grid')).toBe(undefined);
    expect(monitoringLinkFor('/multicloud/infrastructure/clusters', tabs, 'ai-grid')).toBe(undefined);
    expect(monitoringLinkFor('/projects/%/dashboards/dashboard-1-fleet', tabs, 'ai-grid')).toBe(undefined);
    expect(monitoringLinkFor('/projects/ai-grid/dashboards/%', tabs, 'ai-grid')).toBe(undefined);
  });
});

describe('monitoringTabs', () => {
  it('keeps the dashboard-* dashboards, ordered by name', () => {
    expect(monitoringTabs(hub.slice(0, 3)).map((t) => t.key)).toEqual(['dashboard-1-fleet', 'dashboard-2-usage']);
  });

  it("adds other projects' dashboards after them, in order, keyed by project and name, with the chart's title", () => {
    expect(
      monitoringTabs(hub.slice(0, 2), [
        { dashboard: acmDashboards[1], title: 'Cluster optimization' },
        { dashboard: acmDashboards[0] },
      ]).map((t) => [t.key, t.title]),
    ).toEqual([
      ['dashboard-1-fleet', 'Fleet health'],
      ['dashboard-2-usage', 'Token usage'],
      ['acm/acm-optimization-overview', 'Cluster optimization'],
      ['acm/acm-clusters-overview', 'ACM Clusters Overview'],
    ]);
  });
});

describe('HttpConsoleService.getMonitoringDashboard', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

  it('reads one dashboard by name through the relay', async () => {
    const fetchFn = answer(200, acmDashboards[0]);
    expect(await new HttpConsoleService(fetchFn).getMonitoringDashboard('acm', 'acm-clusters-overview')).toEqual(
      acmDashboards[0],
    );
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      '/perses/api/api/v1/projects/acm/dashboards/acm-clusters-overview',
    ]);
  });

  it("answers undefined when it isn't there or may not be read, and fails otherwise", async () => {
    for (const status of [403, 404]) {
      expect(await new HttpConsoleService(answer(status, {})).getMonitoringDashboard('acm', 'd')).toBeUndefined();
    }
    await expect(
      new HttpConsoleService(answer(502, { error: { message: 'perses is down' } })).getMonitoringDashboard('acm', 'd'),
    ).rejects.toMatchObject({ status: 502, message: 'perses is down' });
    await expect(
      new HttpConsoleService(answer(401, { message: 'token expired' })).getMonitoringDashboard('acm', 'd'),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('HttpConsoleService.listMonitoringDashboards', () => {
  // A fresh Response per call: a body can be read once.
  const answer = (status: number, body: unknown) =>
    vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

  it("reads the configured project's dashboards through the relay, and no other project's", async () => {
    const fetchFn = answer(200, [hub[0]]);
    const service = new HttpConsoleService(fetchFn);
    expect(await service.listMonitoringDashboards('ai-grid')).toEqual([hub[0]]);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual(['/perses/api/api/v1/projects/ai-grid/dashboards']);
  });

  it("keeps Perses's message, and the BFF's for the relay's own refusals", async () => {
    await expect(
      new HttpConsoleService(answer(403, { message: 'not allowed to read project' })).listMonitoringDashboards('x'),
    ).rejects.toMatchObject({ status: 403, message: 'not allowed to read project' });
    await expect(
      new HttpConsoleService(
        answer(404, { error: { message: 'monitoring is not configured on this console' } }),
      ).listMonitoringDashboards('ai-grid'),
    ).rejects.toMatchObject({ status: 404, message: 'monitoring is not configured on this console' });
  });
});

describe('a 401 from the relay', () => {
  it('asks for the user once and keeps the page while the session is live', async () => {
    const user = userEvent.setup();
    const service = withMonitoring('ai-grid', hub);
    renderAt('/monitoring', service);
    await screen.findByTestId('perses-dashboard');
    const getUser = vi.spyOn(service, 'getUser');
    await user.click(screen.getByRole('button', { name: 'panels answered 401' }));
    await waitFor(() => expect(getUser).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('perses-dashboard')).toBeVisible();
    expect(screen.queryByText(/Your session has ended|Logging you in/)).not.toBeInTheDocument();
  });

  it('checks the session, and keeps it, when Perses answers the dashboards list with 401', async () => {
    const service = withMonitoring('ai-grid', hub);
    service.listMonitoringDashboards = () => Promise.reject(new RelayedError(401, 'Perses refused the token'));
    const getUser = vi.spyOn(service, 'getUser');
    renderAt('/monitoring', service);
    expect(await screen.findByText('Perses refused the token')).toBeVisible();
    // Once on load, once for the check.
    await waitFor(() => expect(getUser).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Your session has ended|Logging you in/)).not.toBeInTheDocument();
  });

  it('ends the session when the user answers 401 too', async () => {
    window.sessionStorage.clear();
    const user = userEvent.setup();
    const service = withMonitoring('ai-grid', hub);
    const navigation = { assign: vi.fn<(url: string) => void>(), reload: vi.fn<() => void>() };
    render(
      <MemoryRouter initialEntries={['/monitoring']}>
        <TestApp service={service} navigation={navigation} />
      </MemoryRouter>,
    );
    await screen.findByTestId('perses-dashboard');
    service.getUser = () => Promise.reject(new ServiceError(401, 'missing x-forwarded-access-token'));
    await user.click(screen.getByRole('button', { name: 'panels answered 401' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Logging you in' })).toBeInTheDocument();
    expect(navigation.assign).toHaveBeenCalledWith('/oauth2/sign_out?rd=%2Fmonitoring');
    expect(screen.queryByTestId('perses-dashboard')).not.toBeInTheDocument();
  });
});
