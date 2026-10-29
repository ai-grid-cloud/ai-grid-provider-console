// The About dialog: each row's states.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MockConsoleService } from '../api/MockConsoleService';
import { ServiceError } from '../api/ConsoleService';
import type { ConsoleConfig, User } from '../api/types';
import { AboutConsoleModal } from '../components/AboutConsoleModal';

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5';
const admin: User = { username: 'dev-user', email: 'dev@example.com', groups: [], isProviderAdmin: true };
const baseConfig = (): Promise<ConsoleConfig> => new MockConsoleService().getConfig();

type Props = React.ComponentProps<typeof AboutConsoleModal>;
const renderAbout = (props: Partial<Props>) => render(<AboutConsoleModal isOpen onClose={() => {}} {...props} />);

/** The value next to a label in the dialog's description list. */
const row = (label: string) => {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.nextElementSibling as HTMLElement;
};

it('says what the console is under its name', async () => {
  renderAbout({ config: await baseConfig(), user: admin });
  expect(screen.getByRole('dialog', { name: 'Cloud Provider Admin Console' })).toHaveTextContent(
    'Manages AI Grid on this ACM hub: its clusters, the organizations and subscriptions that use it, and the models it serves.',
  );
});

it('has no backend version row: the backend has no version RPC', async () => {
  renderAbout({ config: await baseConfig(), user: admin });
  expect(screen.queryByText('Backend version')).not.toBeInTheDocument();
  expect(screen.queryByText('Not reported')).not.toBeInTheDocument();
});

describe('Console build', () => {
  it('shows a commit SHA short, and copies it whole', async () => {
    const user = userEvent.setup();
    renderAbout({ config: { ...(await baseConfig()), version: SHA }, user: admin });
    expect(row('Console build')).toHaveTextContent(/^1a2b3c4$/);
    await user.click(screen.getByRole('button', { name: 'Copy the full console build' }));
    expect(await navigator.clipboard.readText()).toBe(SHA);
  });

  it.each(['v0.3.0', '1a2b3c4-dirty', 'v0.3.0-4-g1a2b3c4'])('shows %s as it is, and copies it', async (version) => {
    const user = userEvent.setup();
    renderAbout({ config: { ...(await baseConfig()), version }, user: admin });
    expect(row('Console build')).toHaveTextContent(new RegExp(`^${version}$`));
    await user.click(screen.getByRole('button', { name: 'Copy the full console build' }));
    expect(await navigator.clipboard.readText()).toBe(version);
  });

  it('calls dev a development build', async () => {
    renderAbout({ config: { ...(await baseConfig()), version: 'dev' }, user: admin });
    expect(row('Console build')).toHaveTextContent(/^Development build$/);
    expect(screen.queryByRole('button', { name: 'Copy the full console build' })).not.toBeInTheDocument();
  });
});

describe('the config rows', () => {
  const rows = ['Console build', 'Data', 'Monitoring'];

  it('say Loading while the config loads', () => {
    renderAbout({ user: admin });
    for (const label of rows) expect(row(label)).toHaveTextContent(/^Loading$/);
  });

  it('say Unable to load when the config failed', () => {
    renderAbout({ configError: new ServiceError(502, 'bad gateway'), user: admin });
    for (const label of rows) expect(row(label)).toHaveTextContent(/^Unable to load$/);
  });

  it('say what the console talks to', async () => {
    const { rerender } = renderAbout({ config: { ...(await baseConfig()), fakeBackend: false } });
    expect(row('Data')).toHaveTextContent(/^AI Grid backend$/);
    rerender(<AboutConsoleModal isOpen onClose={() => {}} config={{ ...(await baseConfig()), fakeBackend: true }} />);
    expect(row('Data')).toHaveTextContent(/^Fake backend: fixture data; nothing you change reaches a cluster$/);
  });

  it.each([
    [{ enabled: false, persesProject: '' }, 'Off'],
    [{ enabled: true, persesProject: 'ai-grid-monitoring' }, 'On: Perses project ai-grid-monitoring'],
    [{ enabled: true, persesProject: '' }, 'On'],
  ])('say Monitoring %j as %s', async (monitoring, text) => {
    renderAbout({ config: { ...(await baseConfig()), monitoring } });
    expect(row('Monitoring')).toHaveTextContent(new RegExp(`^${text}$`));
  });
});

describe('the user rows', () => {
  it('show the username and email, and a provider admin', () => {
    renderAbout({ user: admin });
    expect(row('Logged in as')).toHaveTextContent(/^dev-user \(dev@example.com\)$/);
    expect(row('Access')).toHaveTextContent(/^Provider admin$/);
  });

  it('show a user without an email, who is not a provider admin', () => {
    renderAbout({ user: { username: 'viewer', groups: [], isProviderAdmin: false } });
    expect(row('Logged in as')).toHaveTextContent(/^viewer$/);
    expect(row('Access')).toHaveTextContent(/^Not a provider admin$/);
  });

  it('say Loading while the user loads', () => {
    renderAbout({});
    expect(row('Logged in as')).toHaveTextContent(/^Loading$/);
    expect(row('Access')).toHaveTextContent(/^Loading$/);
  });

  it('say Unable to load when the user failed', () => {
    renderAbout({ userError: new ServiceError(500, 'unavailable') });
    expect(row('Logged in as')).toHaveTextContent(/^Unable to load$/);
    expect(row('Access')).toHaveTextContent(/^Unable to load$/);
  });
});
