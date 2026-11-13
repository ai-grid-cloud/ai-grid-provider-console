import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Code, ConnectError } from '@connectrpc/connect';
import { focusManager } from '@tanstack/react-query';
import type { DashboardResource } from '@perses-dev/client';
import type { VariableDefinition } from '@perses-dev/spec';
import { BackendProvider } from '../../api/connect/BackendProvider';
import { fakeClients, type FakeBackend } from '../../api/connect/testing';
import { CHANNEL } from './clusterDetails';
import { ORGANIZATION_VARIABLE } from './organizationVariable';
import PersesDashboardView from './PersesDashboardView';

const organizationVariable = {
  kind: 'ListVariable',
  spec: {
    name: ORGANIZATION_VARIABLE,
    display: { name: 'Organization' },
    allowMultiple: false,
    allowAllValue: false,
    plugin: { kind: 'StaticListVariable', spec: { values: ['uuid-1'] } },
  },
} as VariableDefinition;

const channelVariable: VariableDefinition = {
  kind: 'TextVariable',
  spec: { name: CHANNEL, value: 'N/A', display: { name: CHANNEL, hidden: true } },
};

const dashboard = (variables: VariableDefinition[]) =>
  ({
    kind: 'Dashboard',
    metadata: { project: 'redhat-ods-monitoring', name: 'dashboard' },
    spec: { duration: '1h', variables, panels: {}, layouts: [] },
  }) as unknown as DashboardResource;

const unavailable = () => {
  throw new ConnectError('The backend is unavailable.', Code.Unavailable);
};

// Perses asks the relay for datasources: none.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('[]'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const renderView = (board: DashboardResource, backend: FakeBackend) =>
  render(
    <MemoryRouter initialEntries={['/monitoring']}>
      <BackendProvider transport={fakeClients(backend).transport} checkSession={vi.fn()}>
        <PersesDashboardView dashboard={board} />
      </BackendProvider>
    </MemoryRouter>,
  );

describe('the side loads of a dashboard', () => {
  it('warns when the organizations fail to load, keeps the dashboard, and clears on Retry', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockImplementationOnce(unavailable)
      .mockImplementation(() => ({ items: [{ id: 'uuid-1', metadata: { name: 'Acme' } }], size: 1, total: 1 }));
    renderView(dashboard([organizationVariable]), { tenants: { list } });
    const alert = await screen.findByTestId('load-failed-alert');
    expect(alert).toHaveClass('pf-m-plain');
    expect(within(alert).getByText(/^Unable to load organizations\./)).toBeVisible();
    expect(within(alert).getByText(/backend is unavailable/)).toBeVisible();
    expect(
      within(alert).getByRole('heading', { name: /Unable to load organizations\. .*backend is unavailable/ }),
    ).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeVisible();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/^Unable to load organizations\./)).not.toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeVisible();
  });

  it('warns when the clusters fail to load, keeps the dashboard, and clears on Retry', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockImplementationOnce(unavailable)
      .mockImplementation(() => ({ items: [{ id: 'site-a' }], size: 1, total: 1 }));
    renderView(dashboard([channelVariable]), { clusters: { list } });
    const alert = await screen.findByTestId('load-failed-alert');
    expect(alert).toHaveClass('pf-m-plain');
    expect(within(alert).getByText(/^Unable to load clusters\./)).toBeVisible();
    expect(within(alert).getByText(/backend is unavailable/)).toBeVisible();
    expect(screen.getByText('Time period:')).toBeVisible();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/^Unable to load clusters\./)).not.toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Time period:')).toBeVisible();
  });

  it('says the last loaded organizations and clusters are shown when a reload fails after they loaded', async () => {
    const tenants = vi
      .fn()
      .mockImplementationOnce(() => ({ items: [{ id: 'uuid-1', metadata: { name: 'Acme' } }], size: 1, total: 1 }))
      .mockImplementation(unavailable);
    const clusters = vi
      .fn()
      .mockImplementationOnce(() => ({ items: [{ id: 'site-a' }], size: 1, total: 1 }))
      .mockImplementation(unavailable);
    renderView(dashboard([organizationVariable, channelVariable]), {
      tenants: { list: tenants },
      clusters: { list: clusters },
    });
    expect(await screen.findByText('Time period:')).toBeVisible();
    // A refetch, as a poll makes it.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(tenants).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(clusters).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(await screen.findByText(/^Showing the last loaded organizations\./)).toBeVisible();
    expect(await screen.findByText(/^Showing the last loaded clusters\./)).toBeVisible();
    expect(screen.queryByText(/Unable to load/)).not.toBeInTheDocument();
    const alerts = screen.getAllByTestId('stale-data-alert');
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(alert).toHaveClass('pf-m-plain');
      expect(within(alert).getByText(/backend is unavailable/)).toBeVisible();
      expect(within(alert).getByRole('button', { name: 'Retry' })).toBeVisible();
    }
    // Retry on the organizations alert loads only Tenants/List again.
    const tenantCalls = tenants.mock.calls.length;
    const clusterCalls = clusters.mock.calls.length;
    const orgAlert = screen
      .getByText(/^Showing the last loaded organizations\./)
      .closest('.pf-v6-c-alert') as HTMLElement;
    await userEvent.setup().click(within(orgAlert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(tenants).toHaveBeenCalledTimes(tenantCalls + 1));
    expect(clusters).toHaveBeenCalledTimes(clusterCalls);
    expect(screen.getByText('Time period:')).toBeVisible();
  });

  it('says it was unable to load when a list that loaded empty fails to reload', async () => {
    const empty = () => ({ items: [], size: 0, total: 0 });
    const tenants = vi.fn().mockImplementationOnce(empty).mockImplementation(unavailable);
    const clusters = vi.fn().mockImplementationOnce(empty).mockImplementation(unavailable);
    renderView(dashboard([organizationVariable, channelVariable]), {
      tenants: { list: tenants },
      clusters: { list: clusters },
    });
    expect(await screen.findByText('Time period:')).toBeVisible();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(tenants).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(clusters).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Unable to load organizations\./)).toBeVisible();
    expect(await screen.findByText(/^Unable to load clusters\./)).toBeVisible();
    expect(screen.getAllByTestId('load-failed-alert')).toHaveLength(2);
    expect(screen.queryByText(/Showing the last loaded/)).not.toBeInTheDocument();
  });

  it('shows no alert for a dashboard without organization or cluster-details variables', async () => {
    renderView(dashboard([]), {
      tenants: { list: unavailable },
      clusters: { list: unavailable },
    });
    expect(await screen.findByText('Time period:')).toBeVisible();
    await act(async () => {});
    expect(screen.queryByText(/Unable to load|Showing the last loaded/)).not.toBeInTheDocument();
  });

  it('shows no warning when both load', async () => {
    renderView(dashboard([organizationVariable, channelVariable]), {
      tenants: { list: () => ({ items: [], size: 0, total: 0 }) },
      clusters: { list: () => ({ items: [], size: 0, total: 0 }) },
    });
    expect(await screen.findByText('Time period:')).toBeVisible();
    expect(screen.queryByText(/Unable to load/)).not.toBeInTheDocument();
  });
});
