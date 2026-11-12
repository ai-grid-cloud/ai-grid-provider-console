// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantWizardPage.tsx at 62319b8.
import { useState } from 'react';
import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import { Link, useParams } from 'react-router-dom';
import { PageStateSection } from '../../components/states/PageStateSection';
import { OrganizationFormWizard } from './OrganizationFormWizard';
import { organizationNotFound } from './organizationNotFound';
import type { OrganizationView } from './organizationView';
import { useOrganization } from './useOrganizations';

/** Create at /organizations/create, edit at /organizations/:id/edit: the same wizard. */
export const OrganizationWizardPage: React.FC = () => {
  const { id } = useParams();
  const { data, loaded, fresh, error, refresh } = useOrganization(id);
  // The first answer read on this page stays the form's: Save sends its version, so a later answer
  // (a refetch on window focus) mustn't replace it underneath the user, and an answer the cache
  // kept from an earlier page mustn't stand in for it. Someone else's save in between is then a
  // conflict, not overwritten.
  const [kept, setKept] = useState<OrganizationView>();
  if (id !== undefined && data?.id === id && fresh && !error && kept?.id !== id) setKept(data);
  const organization = kept?.id === id ? kept : undefined;
  const name = organization?.name ?? id;
  const title = id ? 'Edit organization' : 'Create organization';

  return (
    <PageStateSection
      title={title}
      description={
        id ? (
          <>
            Make changes to the configuration of the <strong>{name}</strong> organization.
          </>
        ) : (
          'Configure organization details and an OIDC identity provider.'
        )
      }
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/organizations">Organizations</Link>
          </BreadcrumbItem>
          {id && (
            <BreadcrumbItem>
              <Link to={`/organizations/${encodeURIComponent(id)}`}>{name}</Link>
            </BreadcrumbItem>
          )}
          <BreadcrumbItem isActive>{title}</BreadcrumbItem>
        </Breadcrumb>
      }
      loaded={id === undefined || !!organization || (loaded && fresh && !!error)}
      // Once the form has its organization, a later load's failure says nothing about it.
      error={id === undefined || organization ? undefined : error}
      onRetry={() => void refresh()}
      subject="Organizations"
      object="organization"
      loadingLabel="Loading organization"
      notFound={id === undefined ? undefined : organizationNotFound(id)}
      isWizard
    >
      {(id === undefined || organization) && (
        <OrganizationFormWizard key={organization?.id} organization={organization} />
      )}
    </PageStateSection>
  );
};
