import { EmptyState, EmptyStateBody } from '@patternfly/react-core';
import { WrenchIcon } from '@patternfly/react-icons';

type Props = {
  /** e.g. "Models are not available on this AI Grid backend". */
  title: string;
};

/**
 * A page whose RPC the backend doesn't implement yet (501). That is expected while the backend and
 * the console are developed in parallel, so it is a neutral full empty state, not an error, and has
 * no Retry: the page works without changes once the backend has the RPC.
 */
export const NotAvailableState: React.FC<Props> = ({ title }) => (
  <EmptyState variant="lg" titleText={title} headingLevel="h2" icon={WrenchIcon} data-testid="not-available-state">
    <EmptyStateBody>
      This AI Grid backend does not support this feature. The page becomes available when the backend supports it.
    </EmptyStateBody>
  </EmptyState>
);
