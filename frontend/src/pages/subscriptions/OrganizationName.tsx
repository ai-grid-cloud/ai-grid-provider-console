// A subscription's organization in a table cell or a details list: its name, or a warning when the
// organization no longer exists (subscriptionText.ts, organizationRefOf).
import { EMPTY_VALUE } from '../../utilities/format';
import { MissingLabel } from '../../components/MissingLabel';
import { MISSING_ORGANIZATION, missingOrganizationReason, type OrganizationRef } from './subscriptionText';

export const OrganizationName: React.FC<{ organization: OrganizationRef }> = ({ organization }) =>
  organization.missing ? (
    <MissingLabel testId="subscription-organization-missing" reason={missingOrganizationReason(organization.id)}>
      {MISSING_ORGANIZATION}
    </MissingLabel>
  ) : (
    <>{organization.name || EMPTY_VALUE}</>
  );
