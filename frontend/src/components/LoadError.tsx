import {
  Alert,
  AlertActionLink,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
} from '@patternfly/react-core';
import { SearchIcon } from '@patternfly/react-icons';
import { Link } from 'react-router-dom';
import { ServiceError } from '../api/ConsoleService';

/** How a page for one object says the object doesn't exist. */
export type NotFound = {
  /** The object type, e.g. "Model deployment"; the title is "<what> not found". */
  what: string;
  /** Which one was asked for, e.g. "There is no organization acme." */
  body: React.ReactNode;
  /** Its list, and the list's name for the way back ("Go to Models"). */
  listPath: string;
  listLabel: string;
};

type Props = {
  /** What was being loaded, e.g. "Clusters". */
  subject: string;
  error: Error;
  /** The not-available title when "<subject> are ..." doesn't read, e.g. "AI Grid is not available ...". */
  notAvailableTitle?: string;
  /** The error's title; "<subject> could not be loaded" without one. */
  title?: string;
  /** Offers Retry on the error. */
  onRetry?: () => void;
  /** For a page of one object: a 404 says it doesn't exist and links back to its list, with no Retry. */
  notFound?: NotFound;
};

/**
 * Renders a failed load. A 501 from the BFF means the backend does not
 * implement the RPC behind this page yet; that is an expected state while the
 * backend and the console are developed in parallel, so it is shown as an
 * informational empty state rather than an error. A 401 shows nothing: the
 * console says once, above every page, that the session has ended, and a retry
 * would send the same rejected token. A 404 on a page for one object is an
 * empty state naming it, with a link back to its list: retrying would not
 * bring it back. Everything else is an error with the BFF's message.
 */
export const LoadError: React.FC<Props> = ({ subject, error, notAvailableTitle, title, onRetry, notFound }) => {
  if (error instanceof ServiceError && error.isUnauthenticated) {
    return null;
  }
  if (notFound && error instanceof ServiceError && error.status === 404) {
    return <NotFoundState {...notFound} />;
  }
  if (error instanceof ServiceError && error.isNotImplemented) {
    return (
      <EmptyState
        titleText={notAvailableTitle ?? `${subject} are not available on this backend yet`}
        headingLevel="h3"
        variant="sm"
      >
        <EmptyStateBody>
          The AI Grid backend this console talks to does not implement this capability yet. The page will work without
          changes once it does.
        </EmptyStateBody>
      </EmptyState>
    );
  }
  return (
    <Alert
      variant="danger"
      isInline
      title={title ?? `${subject} could not be loaded`}
      actionLinks={onRetry && <AlertActionLink onClick={onRetry}>Retry</AlertActionLink>}
    >
      {error.message}
    </Alert>
  );
};

/** A page's object that doesn't exist (or no longer does). */
export const NotFoundState: React.FC<NotFound> = ({ what, body, listPath, listLabel }) => (
  <EmptyState titleText={`${what} not found`} headingLevel="h2" icon={SearchIcon} data-testid="not-found-state">
    <EmptyStateBody>{body}</EmptyStateBody>
    <EmptyStateFooter>
      <EmptyStateActions>
        <Button variant="primary" component={(props) => <Link {...props} to={listPath} />}>
          Go to {listLabel}
        </Button>
      </EmptyStateActions>
    </EmptyStateFooter>
  </EmptyState>
);
