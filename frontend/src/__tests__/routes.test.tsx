import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { InitialEntry } from 'react-router-dom';
import { App } from '../App';
import { ServiceError } from '../api/ConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';

const at = (path: InitialEntry, service = new MockConsoleService()) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App service={service} />
    </MemoryRouter>,
  );

describe('routes', () => {
  it('redirects / to clusters', async () => {
    at('/');
    expect(await screen.findByRole('heading', { name: 'Clusters' })).toBeInTheDocument();
  });

  it('deep-links to every route', async () => {
    for (const path of [
      '/ai-grid',
      '/monitoring',
      '/clusters',
      '/organizations',
      '/organizations/create',
      '/models',
      '/models/deploy',
      '/subscriptions',
      '/subscriptions/create',
      '/organizations/org-1',
      '/organizations/org-1/edit',
      '/subscriptions/view/engineering',
      '/subscriptions/edit/engineering',
    ]) {
      const { unmount } = at(path);
      expect(await screen.findByRole('main')).toBeInTheDocument();
      expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
      unmount();
    }
  });

  // Review focus 1 (A33/C10): on the real backend, which has only Ping, ListManagedClusters and
  // ListTenants, every page that needs a missing RPC says so instead of showing an error.
  const orgs = 'Organizations are not available on this backend yet';
  const subs = 'Subscriptions are not available on this backend yet';
  const grid = 'AI Grid clusters are not available on this backend yet';
  /** The deploy wizard loads locations up front but shows them on its third step. */
  const toLocationsStep = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(await screen.findByRole('textbox', { name: /Model URI/ }), 'hf://org/widget');
    await user.type(screen.getByRole('textbox', { name: /^Model name/ }), 'org/widget');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(await screen.findByTestId('model-name-desc-name'), 'Widget');
    await user.type(screen.getByRole('textbox', { name: /Runtime image/ }), 'registry.example/runtime:test');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
  };
  it.each<[path: string, method: keyof MockConsoleService, text: string, open?: typeof toLocationsStep]>([
    ['/organizations', 'listOrganizations', orgs],
    ['/organizations/org-1', 'getOrganization', orgs],
    ['/organizations/org-1/edit', 'getOrganization', orgs],
    ['/models', 'listModels', 'Models are not available on this backend yet'],
    ['/models/deploy', 'listLocations', 'Locations are not available on this backend yet.', toLocationsStep],
    ['/subscriptions', 'listSubscriptions', subs],
    ['/subscriptions/view/engineering', 'getSubscriptionInfo', subs],
    ['/subscriptions/create', 'listSubscriptions', subs],
    ['/subscriptions/edit/engineering', 'listSubscriptions', subs],
    ['/ai-grid', 'getGridOverview', grid],
    ['/monitoring', 'getGridOverview', grid],
  ])('renders not-available pages: %s without %s', async (path, method, text, open) => {
    const service = new MockConsoleService();
    vi.spyOn(service, method as 'listModels').mockRejectedValue(
      new ServiceError(501, 'the AI Grid backend does not support this operation yet'),
    );
    const user = userEvent.setup();
    at(path, service);
    // Let the shell's own loads (user, config) settle first, so none lands outside act.
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    await open?.(user);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByText('the AI Grid backend does not support this operation yet')).not.toBeInTheDocument();
  });

  it('shows the not-found page with a way back', async () => {
    at('/nowhere');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to clusters' })).toHaveAttribute('href', '/clusters');
  });

  it('orders the navigation like the PoC, with organization wording', async () => {
    at('/clusters');
    const nav = await screen.findByRole('navigation', { name: 'Console sections' });
    const names = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(names).toEqual(['AI Grid', 'Monitoring', 'Clusters', 'Organizations', 'Models', 'Subscriptions']);
  });

  it('collapses and expands the navigation from the masthead, as the PoC does', async () => {
    const user = userEvent.setup();
    at('/clusters', new MockConsoleService());
    await user.click(await screen.findByRole('button', { name: 'Collapse navigation' }));
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the fake-backend banner only in fake mode', async () => {
    const fake = new MockConsoleService();
    fake.config = { ...fake.config, fakeBackend: true };
    const { unmount } = at('/clusters', fake);
    // Neutral about the fixture directory: make dev-fake-poc loads mock/fixtures-poc.
    expect(await screen.findByText(/fake backend/i)).not.toHaveTextContent('mock/fixtures');
    unmount();

    const real = new MockConsoleService();
    const getConfig = vi.spyOn(real, 'getConfig');
    at('/clusters', real);
    await screen.findByRole('heading', { name: 'Clusters' });
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    await getConfig.mock.results[0].value;
    expect(screen.queryByText(/fake backend/i)).not.toBeInTheDocument();
  });

  it('shows a success toast for a notice passed through navigation state', async () => {
    at({ pathname: '/clusters', state: { notice: 'Organization saved' } });
    expect(await screen.findByText('Organization saved')).toBeInTheDocument();
  });
});
