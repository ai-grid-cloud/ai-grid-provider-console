// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/tenants/TenantDetailsPage.tsx at 62319b8.
import {
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Flex,
  FlexItem,
  Label,
  Spinner,
  Stack,
  StackItem,
  Title,
} from '@patternfly/react-core';
import { Link, useParams } from 'react-router-dom';
import type { UserService } from '../../api/ConsoleService';
import type { OrganizationsService } from '../../api/organizations';
import type { Organization } from '../../api/types';
import { useServiceData } from '../../hooks/useServiceData';
import { OrganizationConfigurationDetails } from './OrganizationConfigurationDetails';
import { OrganizationLoadError } from './OrganizationLoadError';

type Props = { service: OrganizationsService & UserService };

export const OrganizationDetailsPage: React.FC<Props> = ({ service }) => {
  const { id = '' } = useParams();
  const [organization, loaded, error] = useServiceData<Organization | undefined>(
    () => service.getOrganization(id),
    undefined,
    0,
  );
  const [user] = useServiceData(() => service.getUser(), undefined, 0);

  return (
    <Stack hasGutter>
      <StackItem>
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/organizations">Organizations</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{organization?.name ?? id}</BreadcrumbItem>
        </Breadcrumb>
      </StackItem>
      <StackItem>
        <Title headingLevel="h2">{organization?.name ?? 'Organization'}</Title>
      </StackItem>
      <StackItem>
        {error ? (
          <OrganizationLoadError error={error} />
        ) : !loaded || !organization ? (
          <Spinner aria-label="Loading organization" />
        ) : (
          <Stack hasGutter>
            <StackItem>
              <Flex alignItems={{ default: 'alignItemsCenter' }}>
                <FlexItem>
                  <Label color={organization.status === 'Saved' ? 'blue' : 'grey'}>{organization.status}</Label>
                </FlexItem>
                {user?.isProviderAdmin && (
                  <FlexItem>
                    <Button
                      component={(props) => <Link {...props} to={`/organizations/${encodeURIComponent(id)}/edit`} />}
                    >
                      Edit organization
                    </Button>
                  </FlexItem>
                )}
              </Flex>
            </StackItem>
            <StackItem>
              <OrganizationConfigurationDetails organization={organization} />
            </StackItem>
          </Stack>
        )}
      </StackItem>
    </Stack>
  );
};
