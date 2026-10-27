import { useSyncExternalStore } from 'react';

// PatternFly's dark theme is the pf-v6-theme-dark class on <html>. Perses's MUI components and
// ECharts' <canvas> don't read PatternFly's tokens for everything, so the dashboard view builds its
// themes for the mode the page is in, and rebuilds them when the class changes (as odh-dashboard's
// packages follow it, useDarkMode).

export type PageTheme = 'light' | 'dark';

const DARK_THEME_CLASS = 'pf-v6-theme-dark';

const pageTheme = (): PageTheme => (document.documentElement.classList.contains(DARK_THEME_CLASS) ? 'dark' : 'light');

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

/** The page's PatternFly theme, light or dark, kept current as it switches. */
export const usePageTheme = (): PageTheme => useSyncExternalStore(subscribe, pageTheme);
