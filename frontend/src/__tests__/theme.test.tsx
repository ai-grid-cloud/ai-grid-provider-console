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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove(DARK_THEME_CLASS);
});

it("follows the operating system's setting until a theme is chosen", async () => {
  const setSystemDark = stubSystemScheme(true);
  renderAt('/clusters', new MockConsoleService());
  await screen.findByRole('row', { name: /^site1 / });
  expect(isDark()).toBe(true);
  expect(within(toggle()).getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');
  act(() => setSystemDark(false));
  expect(isDark()).toBe(false);
  expect(within(toggle()).getByRole('button', { name: 'Light theme' })).toHaveAttribute('aria-pressed', 'true');
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
  expect(within(toggle()).getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');
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
  expect(screen.getByRole('menuitem', { name: 'Light' })).toHaveClass('pf-m-selected');
  await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
  expect(isDark()).toBe(true);
  expect(screen.queryByRole('menuitem', { name: 'Dark' })).not.toBeInTheDocument();
});
