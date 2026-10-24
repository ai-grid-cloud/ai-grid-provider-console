import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  type Theme,
  DARK_SCHEME_QUERY,
  THEME_STORAGE_KEY,
  applyTheme,
  readSavedTheme,
  saveTheme,
  systemTheme,
} from '../utilities/theme';
import { ThemeContext } from './useTheme';

/**
 * Applies the console's theme to the page (utilities/theme.ts) and keeps it current: a choice made
 * here or in another tab, or, without a choice, a change of the operating system's setting.
 */
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [saved, setSaved] = useState(readSavedTheme);
  const [system, setSystem] = useState(systemTheme);
  const theme = saved ?? system;

  useEffect(() => {
    const query = window.matchMedia?.(DARK_SCHEME_QUERY);
    const onSchemeChange = () => setSystem(systemTheme());
    // A null key is another tab clearing the site's storage, which drops the choice too.
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setSaved(readSavedTheme());
      }
    };
    query?.addEventListener('change', onSchemeChange);
    window.addEventListener('storage', onStorage);
    return () => {
      query?.removeEventListener('change', onSchemeChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Before the browser paints the console, so it never renders in the other theme first. (The empty
  // page before the bundle loads is the browser's own.)
  useLayoutEffect(() => applyTheme(theme), [theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme: (next: Theme) => {
        saveTheme(next);
        setSaved(next);
      },
    }),
    [theme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
