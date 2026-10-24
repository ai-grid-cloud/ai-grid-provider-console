// The theme context and its hook, in their own module so ThemeContext.tsx exports only the
// provider (as useMaaSGovernanceContext.ts does).
import { createContext, useContext } from 'react';
import type { Theme } from '../utilities/theme';

export type ThemeContextValue = {
  /** The theme the console shows: the one chosen in this browser, else the operating system's. */
  theme: Theme;
  /** Shows this theme and keeps it for the next visit. */
  setTheme: (theme: Theme) => void;
};

export const ThemeContext = createContext<ThemeContextValue>({ theme: 'light', setTheme: () => undefined });

/** The console's theme, for what PatternFly's tokens can't colour, and the masthead's toggle. */
export const useTheme = () => useContext(ThemeContext);
