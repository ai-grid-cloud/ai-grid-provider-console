import type { ReactNode } from 'react';
import { Alert, AlertActionLink } from '@patternfly/react-core';
import { compactTitle } from './compactTitle';

type Props = {
  /** What failed to load: "clusters". */
  object: string;
  error: Error;
  onRetry: () => void;
  /** What the page shows without it, one sentence: "Site and Region show a dash until ...". */
  children?: ReactNode;
  /**
   * Two lines, for a page whose own content is the point, such as a Monitoring dashboard: the title
   * with the server's message after it (compactTitle), then Retry; `children` is not shown.
   */
  isCompact?: boolean;
};

/**
 * Data a page shows beside its own (the clusters' sites on the Models pages) that failed to load
 * before any of it arrived: the page's own content stays, under a warning that names what is
 * missing, with the server's message and Retry. Once some of it has loaded, a failed reload is a
 * StaleDataAlert instead.
 */
export const LoadFailedAlert: React.FC<Props> = ({ object, error, onRetry, children, isCompact }) => (
  <Alert
    isInline
    isPlain={isCompact}
    variant="warning"
    title={isCompact ? compactTitle(`Unable to load ${object}`, error) : `Unable to load ${object}`}
    actionLinks={<AlertActionLink onClick={onRetry}>Retry</AlertActionLink>}
    data-testid="load-failed-alert"
  >
    {!isCompact && (
      <>
        <p>{children}</p>
        <p>{error.message}</p>
      </>
    )}
  </Alert>
);
