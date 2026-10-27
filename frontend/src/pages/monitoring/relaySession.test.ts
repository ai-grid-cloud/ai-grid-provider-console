import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ConsoleSessionContext } from '../../context/useConsoleSession';
import { useRelaySessionCheck, watchUnauthorized } from './relaySession';

const fail = (client: QueryClient, key: string, err: unknown) =>
  client.fetchQuery({ queryKey: [key], queryFn: () => Promise.reject(err), retry: 0 }).catch(() => undefined);

describe('watchUnauthorized', () => {
  it('calls back for a query that fails with 401, and only that', async () => {
    const client = new QueryClient({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
    const onUnauthorized = vi.fn();
    const stop = watchUnauthorized(client, onUnauthorized);
    await fail(client, 'panel', Object.assign(new Error('Unauthorized'), { status: 401 }));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await fail(client, 'other', Object.assign(new Error('Bad gateway'), { status: 502 }));
    await fail(client, 'plain', new Error('no status'));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    stop();
    await fail(client, 'after', Object.assign(new Error('Unauthorized'), { status: 401 }));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('useRelaySessionCheck', () => {
  it('checks the session for a 401 while mounted, and no longer once unmounted', async () => {
    const client = new QueryClient({ logger: { log: () => {}, warn: () => {}, error: () => {} } });
    const checkSession = vi.fn();
    const { unmount } = renderHook(() => useRelaySessionCheck(client), {
      wrapper: ({ children }) =>
        createElement(ConsoleSessionContext.Provider, { value: { userLoaded: true, checkSession } }, children),
    });
    await fail(client, 'panel', Object.assign(new Error('Unauthorized'), { status: 401 }));
    await waitFor(() => expect(checkSession).toHaveBeenCalledTimes(1));
    unmount();
    await fail(client, 'after', Object.assign(new Error('Unauthorized'), { status: 401 }));
    expect(checkSession).toHaveBeenCalledTimes(1);
  });
});
