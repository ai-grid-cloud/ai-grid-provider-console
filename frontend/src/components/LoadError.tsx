import { ServiceError } from '../api/ConsoleService';
import { ErrorState } from './states/ErrorState';
import { FullPageState } from './states/FullPageState';
import { NotAvailableState } from './states/NotAvailableState';
import { NotFoundState, type NotFound } from './states/NotFoundState';

export type { NotFound };

type Props = {
  /** The feature, plural, e.g. "Models": "Models are not available on this AI Grid backend". */
  subject: string;
  /** What failed to load, as the titles name it: "model" on a model's page; the subject in lower case without it. */
  object?: string;
  error: Error;
  /** Loads again. Every failure that can pass offers it; a 404 and a 501 don't. */
  onRetry: () => void;
  /** The not-available title when "<subject> are ..." doesn't read, e.g. "AI Grid is not available ...". */
  notAvailableTitle?: string;
  /** For a page of one object: a 404 says it doesn't exist and links back to its list. */
  notFound?: NotFound;
};

/**
 * A failed load with nothing to show instead, as the matching state from components/states:
 *
 * - 401: nothing. The console says once, instead of every page, that the session has ended, and a
 *   retry would send the same rejected token.
 * - 404 on a page for one object: NotFoundState, with a link back to its list.
 * - 501: NotAvailableState. The backend doesn't implement the RPC yet, an expected state while the
 *   backend and the console are developed in parallel.
 * - 403: the no-access state, with the server's message.
 * - Anything else: ErrorState, "Unable to load <object>", the server's message, and Retry.
 *
 * When the last answer is still on screen, a failed reload is a StaleDataAlert instead
 * (PageStateSection decides).
 */
export const LoadError: React.FC<Props> = ({ subject, object, error, onRetry, notAvailableTitle, notFound }) => {
  const what = object ?? subject.toLowerCase();
  if (error instanceof ServiceError && error.isUnauthenticated) {
    return null;
  }
  if (notFound && error instanceof ServiceError && error.status === 404) {
    return <NotFoundState {...notFound} />;
  }
  if (error instanceof ServiceError && error.isNotImplemented) {
    return <NotAvailableState title={notAvailableTitle ?? `${subject} are not available on this AI Grid backend`} />;
  }
  if (error instanceof ServiceError && error.status === 403) {
    return (
      <FullPageState inPage title="Access permissions needed">
        <p>{error.message}</p>
        <p>To view {what}, ask your hub administrator for access.</p>
      </FullPageState>
    );
  }
  return (
    <ErrorState title={`Unable to load ${what}`} onRetry={onRetry}>
      {error.message}
    </ErrorState>
  );
};
