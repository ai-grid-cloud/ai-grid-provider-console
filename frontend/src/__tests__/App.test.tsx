import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { MockConsoleService } from '../api/MockConsoleService';
import { ServiceError } from '../api/ConsoleService';
import type { ConsoleConfig, User } from '../api/types';
import { deferred } from './render';
import { SIGN_IN_AGAIN_KEY, SIGN_IN_AGAIN_WINDOW_MS, type Navigation } from '../utilities/signInAgain';

describe('App', () => {
  it('shows the signed-in user and the clusters from the service', async () => {
    const service = new MockConsoleService();
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user (provider admin)'));
    // The menu keeps its name where a phone shows only its icon.
    expect(screen.getByRole('button', { name: 'User menu: dev-user (provider admin)' })).toBeInTheDocument();
    const row = await screen.findByRole('row', { name: /^site1 / });
    expect(within(row).getByText('4.22.15')).toBeInTheDocument();
    expect(screen.getAllByText('Provisioned')).toHaveLength(3);
  });

  it('has one h1, the page heading, first: the masthead title is not a heading', async () => {
    render(
      <MemoryRouter>
        <App service={new MockConsoleService()} />
      </MemoryRouter>,
    );
    await screen.findByRole('row', { name: /^site1 / });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading')[0]).toHaveTextContent('Clusters');
    expect(screen.getByText('Cloud Provider Admin Console')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Cloud Provider Admin Console' })).not.toBeInTheDocument();
  });

  it('starts with a Skip to content link to the main region', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App service={new MockConsoleService()} />
      </MemoryRouter>,
    );
    await screen.findByRole('row', { name: /^site1 / });
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#console-main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'console-main');
  });

  it('has one h1 on the AI Grid map, which has no visible page heading', async () => {
    render(
      <MemoryRouter initialEntries={['/ai-grid']}>
        <App service={new MockConsoleService()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'AI Grid' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('opens About and offers Log out from the user menu even when the user could not be loaded', async () => {
    const service = new MockConsoleService();
    service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );
    // Not a 401: somebody is signed in, the console just can't say who.
    await user.click(await screen.findByRole('button', { name: 'User menu: User could not be loaded' }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('href', '/oauth2/sign_out');
    await user.click(screen.getByRole('menuitem', { name: 'About' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent("Signed in asCouldn't load");
    expect(screen.queryByText('Your session has ended')).not.toBeInTheDocument();
  });

  it('opens About and offers Log out while the user is still loading', async () => {
    const service = new MockConsoleService();
    service.getUser = () => new Promise(() => {});
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'User menu: Signing in...' }));
    expect(screen.getByRole('menuitem', { name: 'About' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
  });

  it('does not call a viewer a provider admin', async () => {
    const service = new MockConsoleService({ username: 'viewer', groups: [], isProviderAdmin: false });
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('viewer'));
    expect(screen.getByTestId('masthead-user')).not.toHaveTextContent('provider admin');
  });

  it('shows a viewer one empty state instead of the pages and their nav, which then load nothing', async () => {
    const service = new MockConsoleService({ username: 'viewer', groups: [], isProviderAdmin: false });
    const listClusters = vi.spyOn(service, 'listClusters');
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/clusters']}>
        <App service={service} />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This console is for provider admins' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/You are signed in as viewer/)).toHaveTextContent(
      'log out from the user menu and sign in as someone else',
    );
    expect(screen.queryByTestId('clusters-table')).not.toBeInTheDocument();
    // Every page would only answer 403, so there is no nav to them, nor a toggle for it.
    expect(screen.queryByRole('navigation', { name: 'Console sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /navigation/ })).not.toBeInTheDocument();
    const calls = listClusters.mock.calls.length;
    // The masthead stays, with the user menu.
    await user.click(screen.getByRole('button', { name: 'User menu: viewer' }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
    expect(listClusters).toHaveBeenCalledTimes(calls);
  });

  it('does not tell a viewer on the fake backend to log out, where there is no Log out', async () => {
    const service = new MockConsoleService({ username: 'viewer', groups: [], isProviderAdmin: false });
    const config = await service.getConfig();
    service.getConfig = async () => ({ ...config, fakeBackend: true });
    render(
      <MemoryRouter initialEntries={['/clusters']}>
        <App service={service} />
      </MemoryRouter>,
    );
    await screen.findByText(/^Fake backend:/);
    const body = await screen.findByText(/You are signed in as viewer/);
    expect(body).not.toHaveTextContent('log out');
    expect(body).toHaveTextContent('The fake backend has no login');
  });

  it('shows the pages when the user could not be loaded, without admin actions', async () => {
    const service = new MockConsoleService();
    service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
    render(
      <MemoryRouter initialEntries={['/clusters']}>
        <App service={service} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('row', { name: /^site1 / })).toBeInTheDocument();
    expect(screen.queryByText('This console is for provider admins')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for / })).not.toBeInTheDocument();
  });

  it('navigates to organizations and shows them', async () => {
    render(
      <MemoryRouter>
        <App service={new MockConsoleService()} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Organizations' }));

    expect(await screen.findByRole('heading', { name: 'Organizations' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'acme-robotics' })).toBeInTheDocument();
    expect(screen.getByText('acme-robotics.example.com')).toBeInTheDocument();
  });

  it('shows a not-available state, not an error, when the backend lacks the RPC', async () => {
    const service = new MockConsoleService();
    service.listOrganizations = async () => {
      throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
    };
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Organizations' }));

    expect(await screen.findByText('Organizations are not available on this backend yet')).toBeInTheDocument();
    expect(screen.queryByText('Error loading organizations')).not.toBeInTheDocument();
  });

  it('shows the backend error when organizations cannot be loaded', async () => {
    const service = new MockConsoleService();
    service.listOrganizations = async () => {
      throw new ServiceError(502, 'the AI Grid backend failed to process the request');
    };
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Organizations' }));

    expect(await screen.findByText('Error loading organizations')).toBeInTheDocument();
    expect(screen.getByText('the AI Grid backend failed to process the request')).toBeInTheDocument();
  });
});

describe('user menu', () => {
  it('offers Log out through the login proxy when the backend is real', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App service={new MockConsoleService()} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: /dev-user/ }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('href', '/oauth2/sign_out');
  });

  it('offers About but no Log out on the fake backend, where no login proxy runs', async () => {
    const service = new MockConsoleService();
    const config = await service.getConfig();
    service.getConfig = async () => ({ ...config, fakeBackend: true });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    await user.click(screen.getByRole('button', { name: /dev-user/ }));
    expect(screen.getByRole('menuitem', { name: 'About' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('shows the console build, the data source and the user in About', async () => {
    const service = new MockConsoleService();
    const config = await service.getConfig();
    service.getConfig = async () => ({ ...config, version: '1a2b3c4', fakeBackend: true });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <App service={service} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    await user.click(screen.getByRole('button', { name: /dev-user/ }));
    await user.click(screen.getByRole('menuitem', { name: 'About' }));
    const about = await screen.findByRole('dialog', { name: 'Cloud Provider Admin Console' });
    expect(about).toHaveTextContent('Console build1a2b3c4');
    expect(about).toHaveTextContent('DataFake backend: fixture data; nothing you change reaches a cluster');
    // The backend has no version RPC yet, so About has no row for it.
    expect(about).not.toHaveTextContent('Backend version');
    expect(about).toHaveTextContent('Signed in asdev-user');
    expect(about).toHaveTextContent('AccessProvider admin (may change managed clusters on this hub)');
    await user.click(within(about).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('an ended session', () => {
  const expired = () => new ServiceError(401, 'missing x-forwarded-access-token');
  const signOut = '/oauth2/sign_out?rd=%2Fclusters%3Fview%3Dall%23top';
  /** A service whose user and clusters both answer 401, as an expired token gets. */
  const expiredService = () => {
    const service = new MockConsoleService();
    service.getUser = async () => {
      throw expired();
    };
    service.listClusters = async () => {
      throw expired();
    };
    return service;
  };
  const fakeNavigation = () => ({ assign: vi.fn<(url: string) => void>(), reload: vi.fn<() => void>() });
  const renderEnded = (service: MockConsoleService, navigation: Navigation, storage?: () => Storage) =>
    render(
      <MemoryRouter initialEntries={['/clusters?view=all#top']}>
        <App service={service} navigation={navigation} storage={storage} />
      </MemoryRouter>,
    );
  /** The page with nothing of the console's pages: no nav, no nav toggle, no page heading. */
  const expectFullPage = (h1s = 1) => {
    expect(screen.queryByRole('navigation', { name: 'Console sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /navigation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Clusters' })).not.toBeInTheDocument();
    expect(screen.queryByText('Error loading clusters')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(h1s);
    expect(screen.getByText('Cloud Provider Admin Console')).toBeVisible();
  };

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('sends the first 401 through the login, back to the same page, once', async () => {
    const navigation = fakeNavigation();
    const user = userEvent.setup();
    renderEnded(expiredService(), navigation);
    // A reload would keep the login proxy's session cookie, with the token the hub rejected; signing
    // out clears it and comes back here, through a new login.
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(signOut));
    expect(await screen.findByRole('heading', { level: 1, name: 'Signing you in again…' })).toBeInTheDocument();
    expectFullPage();
    expect(window.sessionStorage.getItem(SIGN_IN_AGAIN_KEY)).toMatch(/^\d+$/);

    // The masthead stays, with its user menu and Log out.
    await user.click(screen.getByRole('button', { name: 'User menu: Not signed in' }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('href', '/oauth2/sign_out');
    expect(navigation.assign).toHaveBeenCalledTimes(1);
    expect(navigation.reload).not.toHaveBeenCalled();
  });

  it('stops at the ended session when the login sent it back refused again, and offers Try again', async () => {
    window.sessionStorage.setItem(SIGN_IN_AGAIN_KEY, String(Date.now() - 5000));
    const navigation = fakeNavigation();
    const user = userEvent.setup();
    renderEnded(expiredService(), navigation);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has ended' })).toBeInTheDocument();
    expectFullPage();
    expect(navigation.assign).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(navigation.assign).toHaveBeenCalledWith(signOut);
    expect(navigation.assign).toHaveBeenCalledTimes(1);
  });

  it('redirects again when the last redirect is older than the window', async () => {
    window.sessionStorage.setItem(SIGN_IN_AGAIN_KEY, String(Date.now() - 2 * SIGN_IN_AGAIN_WINDOW_MS));
    const navigation = fakeNavigation();
    renderEnded(expiredService(), navigation);
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(signOut));
  });

  it('keeps the last redirect when the user loads: the hub accepting the token is not the backend', async () => {
    const last = String(Date.now() - 5000);
    window.sessionStorage.setItem(SIGN_IN_AGAIN_KEY, last);
    const navigation = fakeNavigation();
    renderEnded(new MockConsoleService(), navigation);
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    expect(await screen.findByRole('row', { name: /^site1 / })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(SIGN_IN_AGAIN_KEY)).toBe(last);
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it('stops at the ended session when, back from the login, the user loads and then a page call answers 401', async () => {
    const navigation = fakeNavigation();
    // The first page load: a 401 sends the tab through the login.
    const first = renderEnded(expiredService(), navigation);
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(signOut));
    first.unmount();

    // Back from the login: the hub accepts the token, so the user loads, but the backend refuses it.
    const service = new MockConsoleService();
    const clusters = deferred<never>();
    service.listClusters = () => clusters.promise;
    renderEnded(service, navigation);
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    await act(async () => clusters.reject(expired()));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has ended' })).toBeInTheDocument();
    expectFullPage();
    expect(navigation.assign).toHaveBeenCalledTimes(1);
  });

  it('stops again on the next load when, back from the login, a 401 came before the user loaded', async () => {
    window.sessionStorage.setItem(SIGN_IN_AGAIN_KEY, String(Date.now() - 5000));
    const navigation = fakeNavigation();
    const service = expiredService();
    const user = deferred<User>();
    service.getUser = () => user.promise;
    const first = renderEnded(service, navigation);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has ended' })).toBeInTheDocument();
    await act(async () => user.resolve(await new MockConsoleService().getUser()));
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    first.unmount();

    // A reload within the window answers 401 again: still the ended session, not another redirect.
    renderEnded(expiredService(), navigation);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has ended' })).toBeInTheDocument();
    expectFullPage();
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it('shows the ended session rather than risk a loop when the session storage is refused', async () => {
    const navigation = fakeNavigation();
    renderEnded(expiredService(), navigation, () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has ended' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expectFullPage();
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it('offers Reload, and never redirects, against the fake backend, where no login proxy runs', async () => {
    const service = expiredService();
    service.getConfig = async () => ({ ...(await new MockConsoleService().getConfig()), fakeBackend: true });
    const navigation = fakeNavigation();
    const user = userEvent.setup();
    renderEnded(service, navigation);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has ended' })).toBeInTheDocument();
    expect(screen.getByText(/The fake backend has no login/)).toBeVisible();
    await screen.findByText(/^Fake backend:/);
    expectFullPage();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(navigation.reload).toHaveBeenCalled();
    expect(navigation.assign).not.toHaveBeenCalled();
  });

  it('waits for the config to say there is a login proxy before redirecting', async () => {
    const service = expiredService();
    const config = deferred<ConsoleConfig>();
    service.getConfig = () => config.promise;
    const navigation = fakeNavigation();
    renderEnded(service, navigation);
    expect(await screen.findByRole('progressbar', { name: 'Signing you in again' })).toBeInTheDocument();
    expectFullPage(0);
    expect(navigation.assign).not.toHaveBeenCalled();
    await act(async () => config.resolve(await new MockConsoleService().getConfig()));
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(signOut));
  });

  it('does not redirect when the config could not be loaded, and offers Try again and Reload', async () => {
    const service = expiredService();
    service.getConfig = async () => {
      throw new ServiceError(503, 'unavailable');
    };
    const navigation = fakeNavigation();
    const user = userEvent.setup();
    renderEnded(service, navigation);
    // Without the config the console can't tell a login proxy from the fake backend, which has none.
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has ended' })).toBeInTheDocument();
    expectFullPage();
    expect(navigation.assign).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(navigation.reload).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(navigation.assign).toHaveBeenCalledWith(signOut);
    expect(navigation.assign).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the session has ended', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const service = new MockConsoleService();
      const navigation = fakeNavigation();
      render(
        <MemoryRouter initialEntries={['/clusters']}>
          <App service={service} navigation={navigation} />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('row', { name: /^site1 / })).toBeInTheDocument();
      const poll = vi.spyOn(service, 'listClusters').mockRejectedValue(expired());
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'Signing you in again…' })).toBeVisible();
      expect(poll).toHaveBeenCalledTimes(1);
      // Each further poll would only be another 401.
      await act(async () => {
        vi.advanceTimersByTime(120000);
      });
      expect(poll).toHaveBeenCalledTimes(1);
      expect(navigation.assign).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a loaded page when a later call answers 401, and sends it through the login', async () => {
    const service = new MockConsoleService();
    const navigation = fakeNavigation();
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/clusters']}>
        <App service={service} navigation={navigation} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('row', { name: /^site1 / })).toBeInTheDocument();
    service.listClusters = async () => {
      throw expired();
    };
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith('/oauth2/sign_out?rd=%2Fclusters'));
    expect(screen.queryByRole('row', { name: /^site1 / })).not.toBeInTheDocument();
    expectFullPage();
  });
});
