import { createConnectTransport } from '@connectrpc/connect-web';
import { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@connectrpc/connect';

/**
 * Connect transport to the BFF, which relays to the backend over gRPC
 * (docs/adr/0002-connect-end-to-end-with-vanguard-for-rest.md).
 *
 * Requests go to the same origin: in a deployed console the BFF serves the SPA, and in
 * development the Vite proxy forwards them with the caller's identity headers. Connect is a
 * plain HTTP/1.1 POST per call, so no special dev-server handling is needed beyond the proxy
 * that already exists.
 */
export const createTransport = (baseUrl = '/'): Transport =>
  createConnectTransport({
    baseUrl,
    // The BFF forwards the proxy's identity headers; the browser sends its session cookie.
    fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  });

/**
 * One QueryClient for the app.
 *
 * `staleTime` is deliberately short rather than zero: several screens show state that moves on
 * its own — a cluster joining the grid, a model rolling out — and a page that wants to track it
 * sets its own `refetchInterval` rather than relying on refetch-on-focus.
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Never retry what the caller cannot fix by waiting.
          const code = (error as { code?: string } | null)?.code;
          if (code && ['permission_denied', 'unauthenticated', 'not_found', 'invalid_argument'].includes(code)) {
            return false;
          }
          return failureCount < 2;
        },
      },
    },
  });
