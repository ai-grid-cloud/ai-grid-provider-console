// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantConfigurationDetails.tsx at 62319b8.
// Adapted from OSAC IdentityProvider/CreateWizard/steps/IdpReviewStep.tsx.
import { ExpandableSection, Flex, Stack, StackItem } from '@patternfly/react-core';
import type { DetailsItem } from '../../components/DetailsList';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { RelativeTime } from '../../components/RelativeTime';
import { SectionEmptyState } from '../../components/states/SectionEmptyState';
import {
  NO_IDENTITY_PROVIDER,
  NO_IDENTITY_PROVIDER_REASON,
  type OrganizationInput,
  type OrganizationView,
} from './organizationView';

export type OrganizationSection = 'details' | 'identityProvider';

type Props = {
  organization: OrganizationInput | OrganizationView;
  /**
   * "review": the wizard's last step; empty optional fields are left out and each section has an
   * Edit link. "details": the organization page; everything is shown, endpoints folded away.
   */
  variant: 'review' | 'details';
  /** Review only: go back to the step that edits a section. */
  onEditSection?: (section: OrganizationSection) => void;
};

const isSaved = (organization: OrganizationInput | OrganizationView): organization is OrganizationView =>
  'id' in organization;

const domainsValue = (organization: OrganizationInput | OrganizationView) =>
  organization.domains.length ? (
    <Stack>
      {organization.domains.map((domain) => (
        <StackItem key={domain}>{domain}</StackItem>
      ))}
    </Stack>
  ) : undefined;

/** The read-only configuration, on the wizard's Review step and the organization page. */
export const OrganizationConfigurationDetails: React.FC<Props> = ({ organization, variant, onEditSection }) => {
  const review = variant === 'review';
  const saved = isSaved(organization) ? organization : undefined;
  const idp = organization.identityProvider;

  // The backend's Tenant has a name, domains, an identity provider and a creation time: no
  // description, attributes or domain verification to show.
  const detailItems: DetailsItem[] = [
    { term: 'Name', value: organization.name },
    { term: 'Domains', value: domainsValue(organization) },
    ...(saved
      ? [{ term: 'Created', value: saved.creationTimestamp && <RelativeTime time={saved.creationTimestamp} /> }]
      : []),
  ];
  const connectionItems: DetailsItem[] = idp
    ? [
        { term: 'Identity provider name', value: idp.title },
        { term: 'Description', value: idp.description },
        { term: 'Client ID', value: idp.config.clientId },
        { term: 'Client secret reference', value: idp.config.clientSecretSecret.name },
        { term: 'Issuer', value: idp.config.issuer },
        { term: 'Default scopes', value: idp.config.defaultScopes },
        { term: 'Validate signature', value: idp.config.validateSignature ? 'Yes' : 'No' },
      ]
    : [];
  const endpointItems: DetailsItem[] = idp
    ? [
        { term: 'Authorization URL', value: idp.config.authorizationUrl },
        { term: 'Token URL', value: idp.config.tokenUrl },
        { term: 'User info URL', value: idp.config.userInfoUrl },
        { term: 'JSON Web Key Set (JWKS) URL', value: idp.config.jwksUrl },
        { term: 'Logout URL', value: idp.config.logoutUrl },
      ]
    : [];

  return (
    <Flex
      direction={{ default: 'column' }}
      flexWrap={{ default: 'nowrap' }}
      spaceItems={{ default: 'spaceItemsXl' }}
      data-testid="organization-configuration-details"
    >
      <DetailsSection title="Organization details" onEdit={review ? () => onEditSection?.('details') : undefined}>
        <DetailsList items={detailItems} hideEmpty={review} aria-label="Organization details" />
      </DetailsSection>
      <DetailsSection title="Identity provider" onEdit={review ? () => onEditSection?.('identityProvider') : undefined}>
        {idp ? (
          <DetailsList
            items={review ? [...connectionItems, ...endpointItems] : connectionItems}
            hideEmpty={review}
            aria-label="Identity provider"
          />
        ) : (
          // The backend's Tenant has no spec.identity_provider; the list's cell says the same.
          <SectionEmptyState title={NO_IDENTITY_PROVIDER}>{NO_IDENTITY_PROVIDER_REASON}</SectionEmptyState>
        )}
        {idp && !review && (
          <ExpandableSection toggleText="OIDC endpoints">
            <DetailsList items={endpointItems} aria-label="OIDC endpoints" />
          </ExpandableSection>
        )}
      </DetailsSection>
    </Flex>
  );
};
