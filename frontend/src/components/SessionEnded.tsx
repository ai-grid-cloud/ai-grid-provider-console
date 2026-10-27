import {
  Bullseye,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import { LockIcon } from '@patternfly/react-icons';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

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

/** A whole page, centred like a loading page: no page of the console is left to show. */
const Centred: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <PageSection isFilled hasBodyWrapper={false}>
    <Bullseye className="pf-v6-u-flex-grow-1">{children}</Bullseye>
  </PageSection>
);

/** Shown instead of the pages, and their navigation, once a call has answered 401. */
export const SessionEnded: React.FC<Props> = ({ state, onTryAgain, onReload }) => {
  useDocumentTitle(state === 'redirecting' || state === 'checking' ? 'Signing you in again' : 'Session ended');
  if (state === 'checking') {
    return (
      <Centred>
        <Spinner aria-label="Signing you in again" />
      </Centred>
    );
  }
  if (state === 'redirecting') {
    return (
      <Centred>
        <EmptyState titleText="Signing you in again…" headingLevel="h1" icon={Spinner} />
      </Centred>
    );
  }
  return (
    <Centred>
      <EmptyState titleText="Your session has ended" headingLevel="h1" icon={LockIcon}>
        <EmptyStateBody>
          {state === 'fake'
            ? "The fake backend has no login, so the console can't sign you in again. Reload to try again with the token the dev server sends."
            : state === 'unknown'
              ? "The console can't load or save anything with your current session, and couldn't load its settings to know how to sign you in again. Try again to log in again, or reload the console; if you end up back here, ask a hub administrator to check your access."
              : "The console can't load or save anything with your current session. Try again to log in again; if you end up back here, ask a hub administrator to check your access."}
        </EmptyStateBody>
        <EmptyStateFooter>
          <EmptyStateActions>
            {state !== 'fake' && (
              <Button variant="primary" onClick={onTryAgain}>
                Try again
              </Button>
            )}
            {(state === 'fake' || state === 'unknown') && (
              <Button variant={state === 'fake' ? 'primary' : 'secondary'} onClick={onReload}>
                Reload
              </Button>
            )}
          </EmptyStateActions>
        </EmptyStateFooter>
      </EmptyState>
    </Centred>
  );
};
