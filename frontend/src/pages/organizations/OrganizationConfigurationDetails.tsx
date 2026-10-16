// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantConfigurationDetails.tsx at 62319b8.
// Adapted from OSAC IdentityProvider/CreateWizard/steps/IdpReviewStep.tsx.
import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Title,
} from '@patternfly/react-core';
import type { Organization, OrganizationInput } from '../../api/types';

type Props = { organization: OrganizationInput | Organization };

/** The read-only configuration, on the wizard's Review step and the details page. */
export const OrganizationConfigurationDetails: React.FC<Props> = ({ organization }) => {
  const { identityProvider: idp } = organization;
  const fields: [string, string][] = idp
    ? [
        ['Title', idp.title],
        ['Description', idp.description],
        ['Client ID', idp.config.clientId],
        ['Client secret reference', idp.config.clientSecretSecret.name],
        ['Issuer', idp.config.issuer],
        ['Authorization URL', idp.config.authorizationUrl],
        ['Token URL', idp.config.tokenUrl],
        ['Default scopes', idp.config.defaultScopes],
        ['User info URL', idp.config.userInfoUrl],
        ['JWKS URL', idp.config.jwksUrl],
        ['Logout URL', idp.config.logoutUrl],
        ['Validate signature', idp.config.validateSignature ? 'Yes' : 'No'],
      ]
    : [];
  return (
    <div data-testid="tenant-configuration-details">
      <Title headingLevel="h2" size="lg">
        Organization details
      </Title>
      <DescriptionList isHorizontal className="pf-v6-u-my-md">
        <DescriptionListGroup>
          <DescriptionListTerm>Name</DescriptionListTerm>
          <DescriptionListDescription>{organization.name}</DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Domains</DescriptionListTerm>
          <DescriptionListDescription>{organization.domains.join(', ') || '—'}</DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>
      <Title headingLevel="h2" size="lg">
        Identity provider
      </Title>
      <DescriptionList isHorizontal className="pf-v6-u-my-md">
        {fields.length === 0 && (
          <DescriptionListGroup>
            <DescriptionListTerm>Identity provider</DescriptionListTerm>
            <DescriptionListDescription>None</DescriptionListDescription>
          </DescriptionListGroup>
        )}
        {fields.map(([label, value]) => (
          <DescriptionListGroup key={label}>
            <DescriptionListTerm>{label}</DescriptionListTerm>
            <DescriptionListDescription>{value || '—'}</DescriptionListDescription>
          </DescriptionListGroup>
        ))}
      </DescriptionList>
    </div>
  );
};
