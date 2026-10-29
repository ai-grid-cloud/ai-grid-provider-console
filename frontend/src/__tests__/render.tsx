import { render, screen, waitFor, type ByRoleMatcher } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import type { Transport } from '@connectrpc/connect';
import type { TransportWith } from '../api/connect/BackendProvider';
import type { ConsoleService } from '../api/ConsoleService';
import { transportFor, type ClusterSource } from './connectClusters';

/**
 * The item with this role and name once a user can see it. PatternFly's Popper shows a menu or a
 * select's list in a timer after the click (Popper.show sets its opacity in setTimeout), and React
 * 19 renders that update on its own schedule, so the item exists before it is visible.
 */
export const findVisible = async (role: ByRoleMatcher, name: string) => {
  const element = await screen.findByRole(role, { name });
  await waitFor(() => expect(element).toBeVisible());
  return element;
};

/** A promise the test settles by hand. */
export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Renders the whole console at `path`, as a deep link or a reload would; routed as main.tsx routes it.
 * The backend's Clusters API over Connect answers from the service's clusters (connectClusters.ts)
 * unless a test gives its own transport.
 */
export const renderAt = (
  path: string,
  service: ConsoleService & ClusterSource,
  transport: Transport | TransportWith = transportFor(service),
) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App service={service} transport={transport} />
    </MemoryRouter>,
  );
