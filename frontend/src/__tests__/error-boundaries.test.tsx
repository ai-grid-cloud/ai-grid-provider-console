// The two error boundaries: one around the whole console, one around each page.
import { render, screen, within } from '@testing-library/react';
import { TestApp } from './TestApp';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MockConsoleService } from '../api/MockConsoleService';
import type { User } from '../api/types';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { PageErrorBoundary } from '../components/PageErrorBoundary';
import { isDynamicImportError } from '../utilities/errors';

const Throws: React.FC<{ error: Error }> = ({ error }) => {
  throw error;
};

let consoleError: ReturnType<typeof vi.spyOn>;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
});

describe('isDynamicImportError', () => {
  it.each([
    ['Chrome', new TypeError('Failed to fetch dynamically imported module: https://hub/assets/ModelsPage-abc.js')],
    ['Firefox', new TypeError('error loading dynamically imported module: https://hub/assets/ModelsPage-abc.js')],
    ['Safari', new TypeError('Importing a module script failed.')],
    ['Vite CSS', new Error('Unable to preload CSS for /assets/GridPage-abc.css')],
    ['a ChunkLoadError', Object.assign(new Error('Loading chunk 3 failed.'), { name: 'ChunkLoadError' })],
    ['any case', new TypeError('FAILED TO FETCH DYNAMICALLY IMPORTED MODULE: /x.js')],
  ])('knows %s', (_browser, error) => {
    expect(isDynamicImportError(error)).toBe(true);
  });

  it.each([
    new TypeError("Cannot read properties of undefined (reading 'map')"),
    new Error('Failed to fetch'),
    'Failed to fetch dynamically imported module',
    undefined,
  ])('does not take %s for one', (error) => {
    expect(isDynamicImportError(error)).toBe(false);
  });
});

describe('PageErrorBoundary', () => {
  it('says the console may have been updated when a page file is gone', () => {
    render(
      <PageErrorBoundary resetKey="/models">
        <Throws error={new TypeError('Importing a module script failed.')} />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Unable to load this page' })).toBeVisible();
    expect(screen.getByText(/The console was probably updated after this page opened/)).toBeVisible();
    expect(screen.queryByText('Unable to display this page')).not.toBeInTheDocument();
  });

  it('says something went wrong, with the error, for any other error, and offers Reload', async () => {
    const user = userEvent.setup();
    render(
      <PageErrorBoundary resetKey="/models">
        <Throws error={new TypeError("Cannot read properties of undefined (reading 'map')")} />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Unable to display this page' })).toBeVisible();
    expect(screen.queryByText(/may have been updated/)).not.toBeInTheDocument();
    // The message is there for a bug report, folded away until asked for.
    expect(screen.queryByText(/reading 'map'/)).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Error details' }));
    expect(screen.getByText(/reading 'map'/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
  });

  it('tries again on another page, with the error details folded away again', async () => {
    const user = userEvent.setup();
    const Page: React.FC<{ broken: boolean }> = ({ broken }) => {
      if (broken) {
        throw new Error('page broke');
      }
      return <p>Clusters</p>;
    };
    const { rerender } = render(
      <PageErrorBoundary resetKey="/models">
        <Page broken />
      </PageErrorBoundary>,
    );
    await user.click(screen.getByRole('button', { name: 'Error details' }));
    expect(screen.getByText('page broke')).toBeVisible();

    // Another page that fails too: its details start folded, not open from the last page.
    rerender(
      <PageErrorBoundary resetKey="/organizations">
        <Page broken />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Unable to display this page' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Error details' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('page broke')).not.toBeVisible();

    // A page that renders: the boundary shows it.
    rerender(
      <PageErrorBoundary resetKey="/clusters">
        <Page broken={false} />
      </PageErrorBoundary>,
    );
    expect(screen.getByText('Clusters')).toBeVisible();
    expect(screen.queryByText('Unable to display this page')).not.toBeInTheDocument();
  });

  it('logs the error and where it happened', () => {
    const error = new Error('page broke');
    render(
      <PageErrorBoundary resetKey="/models">
        <Throws error={error} />
      </PageErrorBoundary>,
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('page'),
      error,
      expect.stringContaining('Throws'),
    );
  });
});

describe('AppErrorBoundary', () => {
  it('catches a crash outside the pages, in the masthead, instead of a blank screen', async () => {
    const service = new MockConsoleService();
    // A user the user menu can't show: reading its name throws while the masthead renders.
    service.getUser = async () =>
      ({
        get username(): string {
          throw new Error('the masthead broke');
        },
        groups: [],
        isProviderAdmin: true,
      }) as User;
    const user = userEvent.setup();
    render(
      <AppErrorBoundary>
        <MemoryRouter>
          <TestApp service={service} />
        </MemoryRouter>
      </AppErrorBoundary>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Unable to display the console' })).toBeInTheDocument();
    const details = screen.getByText('Error details').closest('details')!;
    expect(within(details).getByText(/the masthead broke/)).toBeInTheDocument();
    expect(details).not.toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('console'),
      expect.objectContaining({ message: 'the masthead broke' }),
      expect.stringContaining('UserMenu'),
    );
  });

  it('shows its children when nothing fails', () => {
    render(
      <AppErrorBoundary>
        <p>Clusters</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText('Clusters')).toBeVisible();
  });
});
