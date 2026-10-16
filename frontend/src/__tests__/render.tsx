import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import type { ConsoleService } from '../api/ConsoleService';

/** Renders the whole console at `path`, as a deep link or a reload would. */
export const renderAt = (path: string, service: ConsoleService) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App service={service} />
    </MemoryRouter>,
  );
