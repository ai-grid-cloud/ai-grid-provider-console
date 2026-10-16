// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantWizardPage.tsx at 62319b8.
import { Breadcrumb, BreadcrumbItem, Content, Spinner, Stack, StackItem, Title } from '@patternfly/react-core';
import { Link, useParams } from 'react-router-dom';
import type { UserService } from '../../api/ConsoleService';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization } from '../../api/types';
import { useServiceData } from '../../hooks/useServiceData';
import { OrganizationFormWizard } from './OrganizationFormWizard';
import { OrganizationLoadError } from './OrganizationLoadError';

type Props = { service: OrganizationsService & UserService };

/** Create at /organizations/create, edit at /organizations/:id/edit. */
export const OrganizationWizardPage: React.FC<Props> = ({ service }) => {
  const { id } = useParams();
  const [organization, loaded, error] = useServiceData<Organization | undefined>(
    () => (id ? service.getOrganization(id) : Promise.resolve(undefined)),
    undefined,
    0,
  );
  const title = id ? 'Edit organization' : 'Create organization';

  return (
    <Stack hasGutter>
      <StackItem>
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/organizations">Organizations</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{title}</BreadcrumbItem>
        </Breadcrumb>
      </StackItem>
      <StackItem>
        <Title headingLevel="h2">{title}</Title>
        <Content component="p">Configure organization details and an OIDC identity provider.</Content>
      </StackItem>
      <StackItem>
        {error ? (
          <OrganizationLoadError error={error} />
        ) : !loaded ? (
          <Spinner aria-label="Loading organization" />
        ) : (
          <OrganizationFormWizard key={id ?? 'create'} service={service} initial={organization} />
        )}
      </StackItem>
    </Stack>
  );
};
