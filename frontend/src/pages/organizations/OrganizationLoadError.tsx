import { LoadError } from '../../components/LoadError';

/**
 * A failed load of one organization: not available yet on a 501, not found on a 404 (with a way
 * back to the list), else the PoC's error.
 */
export const OrganizationLoadError: React.FC<{ error: Error; id?: string }> = ({ error, id }) => (
  <LoadError
    subject="Organizations"
    error={error}
    title="Error loading organization"
    notFound={
      id === undefined
        ? undefined
        : {
            what: 'Organization',
            body: `There is no organization ${id}.`,
            listPath: '/organizations',
            listLabel: 'Organizations',
          }
    }
  />
);
