import { Alert } from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import { LoadError } from '../../components/LoadError';

/** A failed load of one organization: not available yet on a 501, else the PoC's error. */
export const OrganizationLoadError: React.FC<{ error: Error }> = ({ error }) =>
  error instanceof ServiceError && error.isNotImplemented ? (
    <LoadError subject="Organizations" error={error} />
  ) : (
    <Alert isInline variant="danger" title="Error loading organization">
      {error.message}
    </Alert>
  );
