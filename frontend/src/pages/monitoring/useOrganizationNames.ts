import { useQuery as useConnectQuery } from '@connectrpc/connect-query';
import type { TenantsListResponse } from '../../gen/ai_grid/v1/tenants_service_pb';
import { list } from '../../gen/ai_grid/v1/tenants_service-Tenants_connectquery';
import { useLoaded, useLoadOptions, type Loaded } from '../clusters/useClusters';
import { toOrganizationView } from '../organizations/organizationView';
import type { OrganizationName } from './organizationVariable';

const namesOf = (answer: TenantsListResponse | undefined): OrganizationName[] =>
  answer?.items.map(toOrganizationView).map(({ id, name }) => ({ id, name })) ?? [];

/**
 * Tenants/List, the same query the Organizations pages read, while `enabled`: for a dashboard that
 * filters by organization ID. Called outside Perses's own query client, so the answer is the
 * console's cached one.
 */
export const useOrganizationNames = (enabled: boolean): Loaded<OrganizationName[]> =>
  useLoaded(useConnectQuery(list, {}, { ...useLoadOptions(), enabled }), namesOf);
