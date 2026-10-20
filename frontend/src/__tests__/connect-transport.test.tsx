/**
 * Proves the generated Connect pipeline end to end in the browser: a query hook generated
 * from the backend's contract, through connect-query and TanStack Query, returning typed
 * messages.
 *
 * This is the shell's acceptance test. It does not test a page — pages move to these hooks
 * one at a time (issue #22) and are covered by the Playwright suite, which is the migration's
 * real acceptance criterion (issue #29).
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TransportProvider, useQuery } from '@connectrpc/connect-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouterTransport } from '@connectrpc/connect';
import { Clusters } from '../gen/ai_grid/v1/clusters_service_pb';
import { list } from '../gen/ai_grid/v1/clusters_service-Clusters_connectquery';

const transport = createRouterTransport(({ service }) => {
  service(Clusters, {
    list: () => ({
      size: 2,
      total: 2,
      items: [
        { id: 'site-paris-1', metadata: { name: 'site-paris-1' } },
        { id: 'site-berlin-1', metadata: { name: 'site-berlin-1' } },
      ],
    }),
  });
});

const ClusterNames = () => {
  const { data, error, isPending } = useQuery(list, {});
  if (isPending) return <p>loading</p>;
  if (error) return <p>failed</p>;
  return (
    <ul>
      {data.items.map((cluster) => (
        <li key={cluster.id}>{cluster.metadata?.name}</li>
      ))}
    </ul>
  );
};

const renderWithProviders = (ui: React.ReactNode) =>
  render(
    <TransportProvider transport={transport}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {ui}
      </QueryClientProvider>
    </TransportProvider>,
  );

describe('the generated Connect pipeline', () => {
  it('resolves a query hook into typed messages', async () => {
    renderWithProviders(<ClusterNames />);

    await waitFor(() => expect(screen.getByText('site-paris-1')).toBeInTheDocument());
    expect(screen.getByText('site-berlin-1')).toBeInTheDocument();
  });

  it('surfaces a Connect error rather than throwing', async () => {
    const failing = createRouterTransport(({ service }) => {
      service(Clusters, {
        list: () => {
          throw new Error('backend unavailable');
        },
      });
    });

    render(
      <TransportProvider transport={failing}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ClusterNames />
        </QueryClientProvider>
      </TransportProvider>,
    );

    await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());
  });
});
