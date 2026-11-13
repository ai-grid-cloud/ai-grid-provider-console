import { EmptyState, EmptyStateBody } from '@patternfly/react-core';
import { WrenchIcon } from '@patternfly/react-icons';

type Props = {
  /** e.g. "Models are not available on this AI grid backend". */
  title: string;
  /** What is missing and who sets it up, for a feature this console isn't configured for; the backend's sentence otherwise. */
  children?: React.ReactNode;
};

/**
 * A page whose RPC the backend doesn't implement yet (501). That is expected while the backend and
 * the console are developed in parallel, so it is a neutral full empty state, not an error, and has
 * no Retry: the page works without changes once the backend has the RPC. A page whose feature this
 * console isn't configured for (Monitoring without Perses) looks the same, with a body that says
 * what is missing and who sets it up.
 */
export const NotAvailableState: React.FC<Props> = ({ title, children }) => (
  <EmptyState variant="lg" titleText={title} headingLevel="h2" icon={WrenchIcon} data-testid="not-available-state">
    <EmptyStateBody>
      {children ??
        'This AI grid backend does not support this feature. The page becomes available when the backend supports it.'}
    </EmptyStateBody>
  </EmptyState>
);
