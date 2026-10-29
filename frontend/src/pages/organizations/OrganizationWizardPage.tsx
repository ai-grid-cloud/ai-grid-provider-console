// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantWizardPage.tsx at 62319b8.
import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import { Link, useParams } from 'react-router-dom';
import type { UserService } from '../../api/ConsoleService';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization } from '../../api/types';
import { PageStateSection } from '../../components/states/PageStateSection';
import { useServiceData } from '../../hooks/useServiceData';
import { OrganizationFormWizard } from './OrganizationFormWizard';
import { organizationNotFound } from './organizationNotFound';

type Props = { service: OrganizationsService & UserService };

/** Create at /organizations/create, edit at /organizations/:id/edit: the same wizard. */
export const OrganizationWizardPage: React.FC<Props> = ({ service }) => {
  const { id } = useParams();
  const [organization, loaded, error, refresh] = useServiceData<Organization | undefined>(
    () => (id ? service.getOrganization(id) : Promise.resolve(undefined)),
    undefined,
    0,
  );
  const name = organization?.name ?? id;
  const title = id ? `Edit ${name}` : 'Create organization';

  return (
    <PageStateSection
      title={title}
      description={
        id
          ? "Edit the organization's domains and OIDC identity provider."
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
      loaded={loaded}
      error={error}
      onRetry={() => void refresh()}
      subject="Organizations"
      object="organization"
      loadingLabel="Loading organization"
      notFound={id === undefined ? undefined : organizationNotFound(id)}
      isWizard
    >
      <OrganizationFormWizard key={organization?.id} service={service} organization={organization} />
    </PageStateSection>
  );
};
