import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { InitialEntry } from 'react-router-dom';
import { App } from '../App';
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
