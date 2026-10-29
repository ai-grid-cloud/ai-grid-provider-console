import {
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  type EmptyStateProps,
} from '@patternfly/react-core';
import { PathMissingIcon } from '@patternfly/react-icons';
import { Link } from 'react-router-dom';

/** How a page for one object says the object doesn't exist. */
export type NotFound = {
  /** The object type, e.g. "Model deployment"; the title is "<what> not found". */
  what: string;
  /**
   * The name or id the page asked for. The body then says, the same on every page, that there's no
   * <what> named it, set apart in monospace so an id never reads as part of the sentence.
   */
  name?: string;
  /** Instead of `name`, for a page that isn't one object's (an unknown address). */
  body?: React.ReactNode;
  /** Its list, and the list's name for the way back ("Go to Models"). */
  listPath: string;
  listLabel: string;
};

type Props = NotFound & { headingLevel?: EmptyStateProps['headingLevel'] };

/**
 * An object (or a page) that doesn't exist, or no longer does: PatternFly's full empty state with
 * the path-missing icon and a way back to its list. Retrying would not bring it back.
 */
export const NotFoundState: React.FC<Props> = ({ what, name, body, listPath, listLabel, headingLevel = 'h2' }) => (
  <EmptyState
    variant="lg"
    titleText={`${what} not found`}
    headingLevel={headingLevel}
    icon={PathMissingIcon}
    data-testid="not-found-state"
  >
    <EmptyStateBody>
      {name === undefined ? (
        body
      ) : (
        <>
          No {what.toLowerCase()} named <code>{name}</code> exists. It might have been deleted.
        </>
      )}
    </EmptyStateBody>
    <EmptyStateFooter>
      <EmptyStateActions>
        <Button variant="primary" component={(props) => <Link {...props} to={listPath} />}>
          Go to {listLabel}
        </Button>
      </EmptyStateActions>
    </EmptyStateFooter>
  </EmptyState>
);
