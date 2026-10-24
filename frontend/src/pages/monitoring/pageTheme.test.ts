import { act, renderHook, waitFor } from '@testing-library/react';
import { usePageTheme } from './pageTheme';

afterEach(() => document.documentElement.classList.remove('pf-v6-theme-dark'));

it("follows PatternFly's dark class on <html> as it is added and removed", async () => {
  const { result } = renderHook(() => usePageTheme());
  expect(result.current).toBe('light');
  act(() => document.documentElement.classList.add('pf-v6-theme-dark'));
  await waitFor(() => expect(result.current).toBe('dark'));
  act(() => document.documentElement.classList.remove('pf-v6-theme-dark'));
  await waitFor(() => expect(result.current).toBe('light'));
});

it('starts dark on a page that already is', () => {
  document.documentElement.classList.add('pf-v6-theme-dark');
  expect(renderHook(() => usePageTheme()).result.current).toBe('dark');
});
