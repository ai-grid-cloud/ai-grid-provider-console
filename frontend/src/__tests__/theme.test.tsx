import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { MockConsoleService } from '../api/MockConsoleService';
import { DARK_THEME_CLASS, THEME_STORAGE_KEY } from '../utilities/theme';
import { renderAt } from './render';

/** The operating system's colour scheme as the browser reports it, which a test can change. */
const stubSystemScheme = (dark: boolean) => {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return (next: boolean) => {
    dark = next;
    listeners.forEach((listener) => listener());
  };
};

const isDark = () => document.documentElement.classList.contains(DARK_THEME_CLASS);
const toggle = () => screen.getByRole('group', { name: 'Theme' });
const choices = ['Light theme', 'Dark theme', 'System theme'];
/** Exactly this choice is pressed in the masthead's toggle. */
const expectChoice = (name: string) => {
  for (const choice of choices) {
    expect(within(toggle()).getByRole('button', { name: choice })).toHaveAttribute(
      'aria-pressed',
      String(choice === name),
    );
  }
};

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(DARK_THEME_CLASS);
});

it("follows the operating system's setting until a theme is chosen", async () => {
  const setSystemDark = stubSystemScheme(true);
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  expect(isDark()).toBe(true);
  expectChoice('System theme');
  act(() => setSystemDark(false));
  expect(isDark()).toBe(false);
  expectChoice('System theme');
});

it('follows the operating system again, live, after System is chosen', async () => {
  const setSystemDark = stubSystemScheme(false);
  localStorage.setItem(THEME_STORAGE_KEY, 'dark');
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  expect(isDark()).toBe(true);
  expectChoice('Dark theme');

  await user.click(within(toggle()).getByRole('button', { name: 'System theme' }));
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  expect(isDark()).toBe(false);
  expectChoice('System theme');
  act(() => setSystemDark(true));
  expect(isDark()).toBe(true);

  await user.click(within(toggle()).getByRole('button', { name: 'Light theme' }));
  expect(isDark()).toBe(false);
  expectChoice('Light theme');
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
});

it('keeps a chosen theme for the next visit, whatever the operating system says', async () => {
  const setSystemDark = stubSystemScheme(false);
  const user = userEvent.setup();
  const { unmount } = renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  await user.click(within(toggle()).getByRole('button', { name: 'Dark theme' }));
  expect(isDark()).toBe(true);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  act(() => setSystemDark(false));
  expect(isDark()).toBe(true);

  unmount();
  document.documentElement.classList.remove(DARK_THEME_CLASS);
  renderAt('/clusters', new MockConsoleService());
  expect(isDark()).toBe(true);
  await screen.findByRole('row', { name: /^site1 / });
  expectChoice('Dark theme');
});

it('takes a theme chosen in another tab', async () => {
  stubSystemScheme(false);
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  localStorage.setItem(THEME_STORAGE_KEY, 'dark');
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
  });
  expect(isDark()).toBe(true);
  expectChoice('Dark theme');
});

it('follows the operating system again when another tab clears the site data', async () => {
  stubSystemScheme(false);
  localStorage.setItem(THEME_STORAGE_KEY, 'dark');
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  expect(isDark()).toBe(true);
  localStorage.clear();
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(isDark()).toBe(false);
  expectChoice('System theme');
});

it('follows the operating system after System even when the browser refuses to clear the choice', async () => {
  const setSystemDark = stubSystemScheme(false);
  localStorage.setItem(THEME_STORAGE_KEY, 'dark');
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  await user.click(within(toggle()).getByRole('button', { name: 'System theme' }));
  expect(isDark()).toBe(false);
  act(() => setSystemDark(true));
  expect(isDark()).toBe(true);
  expectChoice('System theme');
});

it('shows each choice’s tooltip on keyboard focus', async () => {
  stubSystemScheme(false);
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  act(() => within(toggle()).getByRole('button', { name: 'System theme' }).focus());
  expect(await screen.findByText('System default')).toBeInTheDocument();
  await user.keyboard('{Escape}');
});

it("still switches when the browser won't store the choice", async () => {
  stubSystemScheme(false);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  await user.click(within(toggle()).getByRole('button', { name: 'Dark theme' }));
  expect(isDark()).toBe(true);
});

it('is light where the browser reports no colour scheme', async () => {
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  expect(isDark()).toBe(false);
});

it("offers the theme in the user menu, for a phone's masthead", async () => {
  stubSystemScheme(false);
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await user.click(await screen.findByRole('button', { name: /^User menu/ }));
  expect(screen.getByRole('menuitem', { name: 'System' })).toHaveClass('pf-m-selected');
  expect(screen.getByRole('menuitem', { name: 'Light' })).not.toHaveClass('pf-m-selected');
  await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
  expect(isDark()).toBe(true);
  expect(screen.queryByRole('menuitem', { name: 'Dark' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^User menu/ }));
  expect(screen.getByRole('menuitem', { name: 'Dark' })).toHaveClass('pf-m-selected');
  await user.click(screen.getByRole('menuitem', { name: 'System' }));
  expect(isDark()).toBe(false);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
});
