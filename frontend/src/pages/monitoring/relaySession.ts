import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useConsoleSession } from '../../context/useConsoleSession';

/** The HTTP status an error carries: Perses's FetchError and UserFriendlyError, and the relay's own. */
const statusOf = (err: unknown): number | undefined =>
  typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : undefined;

/**
 * Calls `onUnauthorized` whenever one of the client's queries fails with 401: a panel's query or a
 * datasource lookup through the relay. Returns the unsubscribe function.
 */
export const watchUnauthorized = (client: QueryClient, onUnauthorized: () => void): (() => void) =>
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error' && statusOf(event.action.error) === 401) {
      onUnauthorized();
    }
  });

/**
 * While mounted, asks the console to check its session (checkSession) when one of the client's
 * queries fails with 401: such a 401 may be Perses's or a datasource's, not the session's.
 */
export const useRelaySessionCheck = (client: QueryClient): void => {
  const { checkSession } = useConsoleSession();
  useEffect(() => (checkSession ? watchUnauthorized(client, checkSession) : undefined), [client, checkSession]);
};
