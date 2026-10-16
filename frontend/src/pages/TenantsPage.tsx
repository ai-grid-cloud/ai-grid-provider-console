import { EmptyState, EmptyStateBody, Spinner, Stack, StackItem, Title } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { ConsoleService } from '../api/ConsoleService';
import type { Tenant } from '../api/types';
import { LoadError } from '../components/LoadError';
import { useServiceData } from '../hooks/useServiceData';

type Props = { service: ConsoleService };

export const TenantsPage: React.FC<Props> = ({ service }) => {
  const [tenants, loaded, error] = useServiceData<Tenant[]>(() => service.listTenants(), []);

  return (
    <Stack hasGutter>
      <StackItem>
        <Title headingLevel="h2">Organizations</Title>
      </StackItem>
      {error && (
        <StackItem>
          <LoadError subject="Organizations" error={error} />
        </StackItem>
      )}
      <StackItem>
        {!loaded ? (
          <Spinner aria-label="Loading organizations" />
        ) : error ? null : tenants.length === 0 ? (
          <EmptyState titleText="No organizations" headingLevel="h3">
            <EmptyStateBody>No organizations exist in the AI Grid identity realm yet.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Organizations" variant="compact">
            <Thead>
              <Tr>
                <Th>Organization</Th>
                <Th>Domains</Th>
                <Th>ID</Th>
              </Tr>
            </Thead>
            <Tbody>
              {tenants.map((t) => (
                <Tr key={t.id}>
                  <Td dataLabel="Organization">{t.name}</Td>
                  <Td dataLabel="Domains">{t.domains.length ? t.domains.join(', ') : '-'}</Td>
                  <Td dataLabel="ID">{t.id}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </StackItem>
    </Stack>
  );
};
