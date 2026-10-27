// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantDetailsPage.tsx at 62319b8.
import { Breadcrumb, BreadcrumbItem, PageSection } from '@patternfly/react-core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization } from '../../api/types';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { StatusLabel } from '../../components/StatusLabel';
import { useConsoleSession } from '../../context/useConsoleSession';
import { useServiceData } from '../../hooks/useServiceData';
import { OrganizationConfigurationDetails } from './OrganizationConfigurationDetails';
import { OrganizationLoadError } from './OrganizationLoadError';
import { useDeleteOrganization } from './useDeleteOrganization';

type Props = { service: OrganizationsService };

export const OrganizationDetailsPage: React.FC<Props> = ({ service }) => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [organization, loaded, error, refresh] = useServiceData<Organization | undefined>(
    () => service.getOrganization(id),
    undefined,
    0,
  );
  const { user } = useConsoleSession();
  const [confirmDelete, deleteModal] = useDeleteOrganization(service, {
    refresh: () => void refresh(),
    onDeleted: () => navigate('/organizations', { state: { notice: 'Organization deleted' } }),
  });

  const actions = organization && user?.isProviderAdmin && (
    <SimpleMenuActions
      toggleLabel="Actions"
      ariaLabel={`Actions for ${organization.name}`}
      testId="organization-actions"
      dropdownItems={[
        {
          key: 'edit',
          label: 'Edit',
          onClick: () => navigate(`/organizations/${encodeURIComponent(id)}/edit`),
        },
        { isSpacer: true },
        { key: 'delete', label: 'Delete', isDanger: true, onClick: () => confirmDelete(organization) },
      ]}
    />
  );

  return (
    <>
      <PageHeader
        title={organization?.name ?? id}
        status={organization && <StatusLabel status={organization.status} />}
        headerAction={actions}
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to="/organizations">Organizations</Link>
            </BreadcrumbItem>
            <BreadcrumbItem isActive>{organization?.name ?? id}</BreadcrumbItem>
          </Breadcrumb>
        }
      />
      {!error && (!loaded || !organization) ? (
        <PageLoading label="Loading organization" />
      ) : (
        <PageSection isFilled>
          {error ? (
            <OrganizationLoadError error={error} id={id} />
          ) : (
            organization && <OrganizationConfigurationDetails organization={organization} variant="details" />
          )}
        </PageSection>
      )}
      {deleteModal}
    </>
  );
};
