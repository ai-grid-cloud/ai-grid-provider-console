// The theme context and its hook, in their own module so ThemeContext.tsx exports only the
// provider (as useMaaSGovernanceContext.ts does).
import { createContext, useContext } from 'react';
import type { Theme, ThemeChoice } from '../utilities/theme';

export type ThemeContextValue = {
  /** The theme the console shows: the one chosen in this browser, else the operating system's. */
  theme: Theme;
  /** The choice in this browser: a theme, or System when none is saved. */
  choice: ThemeChoice;
  /** Shows this theme, or the operating system's for System, and keeps the choice for the next visit. */
  setChoice: (choice: ThemeChoice) => void;
};

export const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  choice: 'system',
  setChoice: () => undefined,
});

/** The console's theme, for what PatternFly's tokens can't colour, and the masthead's toggle. */
export const useTheme = () => useContext(ThemeContext);
