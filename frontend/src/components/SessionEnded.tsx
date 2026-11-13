import { Button, Spinner } from '@patternfly/react-core';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PageLoading } from './PageLoading';
import { FullPageState } from './states/FullPageState';

/**
 * Where an ended session stands: `checking` until the console's config says whether a login proxy
 * runs, `redirecting` on the way to the login, `refused` when the login sent this tab back refused
 * again (or the console can't tell), `fake` on the fake backend, which has no login, and `unknown`
 * when the config failed to load, so the console can't tell whether a login proxy runs.
 */
export type SessionEnd = 'checking' | 'redirecting' | 'refused' | 'fake' | 'unknown';

type Props = {
  state: SessionEnd;
  /** Goes through the login again. */
  onTryAgain: () => void;
  onReload: () => void;
};

/** Shown instead of the pages, and their navigation, once a call has answered 401: no page is left to show. */
export const SessionEnded: React.FC<Props> = ({ state, onTryAgain, onReload }) => {
  useDocumentTitle(state === 'redirecting' || state === 'checking' ? 'Logging you in' : 'Session expired');
  if (state === 'checking') {
    return <PageLoading label="Logging you in" />;
  }
  if (state === 'redirecting') {
    return <FullPageState title="Logging you in" icon={Spinner} />;
  }
  return (
    <FullPageState
      title="Session expired"
      actions={
        <>
          {state !== 'fake' && (
            <Button variant="primary" onClick={onTryAgain}>
              Log in
            </Button>
          )}
          {state === 'fake' && (
            <Button variant="primary" onClick={onReload}>
              Reload
            </Button>
          )}
        </>
      }
    >
      {state === 'fake'
        ? "The fake backend has no login, so the console can't sign you in again. Reload to try again with the token the dev server sends."
        : 'Your session timed out. To continue working, log in.'}
    </FullPageState>
  );
};
