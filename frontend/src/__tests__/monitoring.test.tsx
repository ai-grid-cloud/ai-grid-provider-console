import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import type { DashboardResource } from '@perses-dev/client';
import { vi } from 'vitest';
import { RelayedError, ServiceError } from '../api/ConsoleService';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import { monitoringLinkFor, monitoringTabs } from '../api/monitoring';
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
        <a href="/monitoring/v2/dashboards/view?dashboard=dashboard-2-usage-admin&project=ai-grid&var-cluster=site-a">
          usage of site-a
        </a>
        <a href="/monitoring/v2/dashboards/view?dashboard=acm-optimization-overview&project=ai-grid">optimization</a>
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

const withMonitoring = (persesProject: string, dashboards: DashboardResource[]) => {
  const service = new MockConsoleService();
  service.config = { ...service.config, monitoring: { enabled: true, persesProject } };
  service.monitoringDashboards = dashboards;
  return service;
};

const hub = [
  dashboard('ai-grid', 'dashboard-2-usage-admin', 'Token usage'),
  dashboard('ai-grid', 'dashboard-1-fleet-admin', 'Fleet health'),
  dashboard('ai-grid', 'acm-clusters-overview', 'ACM Clusters Overview'),
  dashboard('other', 'dashboard-1-fleet-admin', 'Someone else'),
];

it("shows the configured project's dashboard-*-admin dashboards as tabs, the first one open", async () => {
  renderAt('/monitoring', withMonitoring('ai-grid', hub));
  const tabs = within(await screen.findByTestId('monitoring-tabs')).getByRole('tablist');
  expect(
    within(tabs)
      .getAllByRole('tab')
      .map((t) => t.textContent),
  ).toEqual(['Fleet health', 'Token usage']);
  expect(within(tabs).getByRole('tab', { name: 'Fleet health' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet-admin');
});

it('opens the tab ?dashboard= names, and another one on click', async () => {
  const user = userEvent.setup();
  renderAt('/monitoring?dashboard=dashboard-2-usage-admin', withMonitoring('ai-grid', hub));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-2-usage-admin');
  await user.click(screen.getByRole('tab', { name: 'Fleet health' }));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet-admin');
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
  expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
  expect(screen.getByText('forbidden: project ai-grid')).toBeVisible();
  expect(
    screen.getByText(
      "You don't have permission to view dashboards. To request permission, contact your hub administrator.",
    ),
  ).toBeVisible();
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
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet-admin');
});

it("says when the console's configuration can't be read, instead of falling back", async () => {
  const user = userEvent.setup();
  const service = withMonitoring('ai-grid', hub);
  const getConfig = service.getConfig;
  service.getConfig = () => Promise.reject(new ServiceError(0, 'Unable to reach the console server.'));
  renderAt('/monitoring', service);
  expect(await screen.findByRole('heading', { name: 'Unable to load console settings' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Monitoring is not set up for this console' })).not.toBeInTheDocument();
  service.getConfig = getConfig;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet-admin');
});

it('says Monitoring is not set up, and which Helm values set it up, when the console relays to no Perses', async () => {
  const service = new MockConsoleService();
  const list = vi.spyOn(service, 'listMonitoringDashboards');
  renderAt('/monitoring', service);
  expect(await screen.findByRole('heading', { name: 'Monitoring is not set up for this console' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === 'DIV' &&
        element.textContent ===
          "To view the hub's Perses dashboards here, ask your hub administrator to set console.perses.url and console.perses.project in the console's Helm values.",
    ),
  ).toBeVisible();
  // Nothing to retry and no dashboards to ask for: the relay isn't there.
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('monitoring-tabs')).not.toBeInTheDocument();
  expect(list).not.toHaveBeenCalled();
});

it("opens a dashboard's link to another tab here, and says when a link goes elsewhere", async () => {
  const user = userEvent.setup();
  renderAt('/monitoring', withMonitoring('ai-grid', hub));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet-admin');
  await user.click(screen.getByRole('link', { name: 'optimization' }));
  expect(await screen.findByText('Link not available in this console')).toBeVisible();
  expect(screen.getByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-1-fleet-admin');
  await user.click(screen.getByRole('link', { name: 'usage of site-a' }));
  expect(await screen.findByTestId('perses-dashboard')).toHaveTextContent('ai-grid/dashboard-2-usage-admin');
  expect(screen.getByRole('tab', { name: 'Token usage' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByText('Link not available in this console')).not.toBeInTheDocument();
});

describe('monitoringLinkFor', () => {
  // The page's tabs: the configured project's only.
  const tabs = monitoringTabs(hub.filter((d) => d.metadata.project === 'ai-grid'));
  it("maps the OpenShift console's and Perses's dashboard links to a tab, keeping time and variables", () => {
    expect(
      monitoringLinkFor(
        '/monitoring/v2/dashboards/view?dashboard=dashboard-2-usage-admin&project=ai-grid&var-cluster=site-a&start=6h&x=1',
        tabs,
        'ai-grid',
      ),
    ).toBe('/monitoring?dashboard=dashboard-2-usage-admin&var-cluster=site-a&start=6h');
    expect(monitoringLinkFor('/projects/ai-grid/dashboards/dashboard-1-fleet-admin?var-a=b', tabs, 'ai-grid')).toBe(
      '/monitoring?dashboard=dashboard-1-fleet-admin&var-a=b',
    );
  });

  it('reads a link without a project as one to the same project', () => {
    expect(monitoringLinkFor('/monitoring/v2/dashboards/view?dashboard=dashboard-1-fleet-admin', tabs, 'ai-grid')).toBe(
      '/monitoring?dashboard=dashboard-1-fleet-admin',
    );
  });

  it('answers undefined for a dashboard that is not a tab, another project, or another page', () => {
    expect(monitoringLinkFor('/monitoring/v2/dashboards/view?dashboard=acm-clusters-overview', tabs, 'ai-grid')).toBe(
      undefined,
    );
    expect(
      monitoringLinkFor(
        '/monitoring/v2/dashboards/view?dashboard=dashboard-2-usage-admin&project=other',
        tabs,
        'ai-grid',
      ),
    ).toBe(undefined);
    expect(monitoringLinkFor('/projects/other/dashboards/dashboard-1-fleet-admin', tabs, 'ai-grid')).toBe(undefined);
    expect(monitoringLinkFor('/multicloud/infrastructure/clusters', tabs, 'ai-grid')).toBe(undefined);
    expect(monitoringLinkFor('/projects/%/dashboards/dashboard-1-fleet-admin', tabs, 'ai-grid')).toBe(undefined);
    expect(monitoringLinkFor('/projects/ai-grid/dashboards/%', tabs, 'ai-grid')).toBe(undefined);
  });
});

describe('monitoringTabs', () => {
  it('keeps the dashboard-*-admin dashboards, ordered by name', () => {
    expect(monitoringTabs(hub.slice(0, 3)).map((d) => d.metadata.name)).toEqual([
      'dashboard-1-fleet-admin',
      'dashboard-2-usage-admin',
    ]);
  });

  it('leaves out the dashboards for users without cluster-wide access, as odh-dashboard does for an admin, and My Usage', () => {
    // A hub's redhat-ods-monitoring: OpenShift AI's two model dashboards, both titled Models, and
    // MaaS's two usage dashboards, the per-user one (My Usage) without an admin variant.
    const project = [
      dashboard('redhat-ods-monitoring', 'dashboard-0-cluster-admin', 'Cluster'),
      dashboard('redhat-ods-monitoring', 'dashboard-1-model', 'Models'),
      dashboard('redhat-ods-monitoring', 'dashboard-1-model-admin', 'Models'),
      dashboard('redhat-ods-monitoring', 'dashboard-4-maas-usage-logs-admin', 'Usage'),
      dashboard('redhat-ods-monitoring', 'dashboard-5-maas-usage-logs', 'My Usage'),
    ];
    expect(monitoringTabs(project).map((d) => d.metadata.name)).toEqual([
      'dashboard-0-cluster-admin',
      'dashboard-1-model-admin',
      'dashboard-4-maas-usage-logs-admin',
    ]);
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
        answer(404, { message: 'monitoring is not configured on this console' }),
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
    expect(screen.queryByText(/Session expired|Logging you in/)).not.toBeInTheDocument();
  });

  it('checks the session, and keeps it, when Perses answers the dashboards list with 401', async () => {
    const service = withMonitoring('ai-grid', hub);
    service.listMonitoringDashboards = () => Promise.reject(new RelayedError(401, 'Perses refused the token'));
    const getUser = vi.spyOn(service, 'getUser');
    renderAt('/monitoring', service);
    expect(await screen.findByText('Perses refused the token')).toBeVisible();
    // Once on load, once for the check.
    await waitFor(() => expect(getUser).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Session expired|Logging you in/)).not.toBeInTheDocument();
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
