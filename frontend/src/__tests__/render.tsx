import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import type { ConsoleService } from '../api/ConsoleService';

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

/** Renders the whole console at `path`, as a deep link or a reload would. */
export const renderAt = (path: string, service: ConsoleService) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App service={service} />
    </MemoryRouter>,
  );
