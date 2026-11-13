import { Alert, AlertActionLink } from '@patternfly/react-core';
import { compactTitle } from './compactTitle';

type Props = {
  /** What is on screen: "clusters", "model". */
  object: string;
  error: Error;
  onRetry: () => void;
  /**
   * Two lines, for a page whose own content is the point, such as a Monitoring dashboard: the title
   * with the server's message after it (compactTitle), then Retry.
   */
  isCompact?: boolean;
};

/**
 * A reload that failed while the last answer is still on screen: the data stays, under a warning
 * that says it may be out of date, with the server's message and Retry.
 */
export const StaleDataAlert: React.FC<Props> = ({ object, error, onRetry, isCompact }) => (
  <Alert
    isInline
    isPlain={isCompact}
    variant="warning"
    title={isCompact ? compactTitle(`Showing the last loaded ${object}`, error) : `Showing the last loaded ${object}`}
    actionLinks={<AlertActionLink onClick={onRetry}>Retry</AlertActionLink>}
    data-testid="stale-data-alert"
  >
    {!isCompact && error.message}
  </Alert>
);
