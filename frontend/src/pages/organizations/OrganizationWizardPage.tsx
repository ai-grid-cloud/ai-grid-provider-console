// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantWizardPage.tsx at 62319b8.
import { Breadcrumb, BreadcrumbItem, PageSection } from '@patternfly/react-core';
import { Link, useParams } from 'react-router-dom';
import type { UserService } from '../../api/ConsoleService';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization } from '../../api/types';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { useServiceData } from '../../hooks/useServiceData';
import { OrganizationFormWizard } from './OrganizationFormWizard';
import { OrganizationLoadError } from './OrganizationLoadError';

type Props = { service: OrganizationsService & UserService };

/** Create at /organizations/create, edit at /organizations/:id/edit: the same wizard. */
export const OrganizationWizardPage: React.FC<Props> = ({ service }) => {
  const { id } = useParams();
  const [organization, loaded, error] = useServiceData<Organization | undefined>(
    () => (id ? service.getOrganization(id) : Promise.resolve(undefined)),
    undefined,
    0,
  );
  const name = organization?.name ?? id;
  const title = id ? `Edit ${name}` : 'Create organization';

  return (
    <>
      <PageHeader
        title={title}
        description={
          id
            ? 'Change the organization’s domains and its OIDC identity provider.'
            : 'Configure organization details and an OIDC identity provider.'
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
            <BreadcrumbItem isActive>{id ? 'Edit' : title}</BreadcrumbItem>
          </Breadcrumb>
        }
      />
      {!error && (!loaded || (id && !organization)) ? (
        <PageLoading label="Loading organization" />
      ) : (
        <PageSection hasBodyWrapper={false} isFilled>
          {error ? (
            <OrganizationLoadError error={error} id={id} />
          ) : (
            <OrganizationFormWizard key={organization?.id} service={service} organization={organization} />
          )}
        </PageSection>
      )}
    </>
  );
};
