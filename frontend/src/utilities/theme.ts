// The console's light and dark themes: PatternFly's dark theme is the pf-v6-theme-dark class on
// <html>, under which its stylesheet gives the --pf-t-- tokens their dark values. odh-dashboard
// switches it the same way. The browser keeps the choice; without one the console follows the
// operating system's setting.

export type Theme = 'light' | 'dark';
/** What the user chose: a theme, or the operating system's setting (nothing saved). */
export type ThemeChoice = Theme | 'system';

export const THEME_STORAGE_KEY = 'console.theme';
export const DARK_THEME_CLASS = 'pf-v6-theme-dark';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** The theme chosen in this browser, if any. Storage can be blocked (private windows, policies). */
export const readSavedTheme = (): Theme | undefined => {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Keeps the choice for the next visit: a theme is saved, System removes the saved one. Without
 * storage the choice lasts until the page reloads.
 */
export const saveTheme = (choice: ThemeChoice) => {
  try {
    if (choice === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    // Storage is blocked: the choice still applies to this page.
  }
};

/** The operating system's setting; light where the browser can't tell. */
export const systemTheme = (): Theme => (window.matchMedia?.(DARK_SCHEME_QUERY).matches ? 'dark' : 'light');

export const applyTheme = (theme: Theme) => {
  document.documentElement.classList.toggle(DARK_THEME_CLASS, theme === 'dark');
};
