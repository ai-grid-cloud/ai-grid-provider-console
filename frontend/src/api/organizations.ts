import type { Organization, OrganizationInput } from './types';

/** The Organizations area: tenant organizations and their OIDC identity provider. */
export interface OrganizationsService {
  listOrganizations(): Promise<Organization[]>;
  getOrganization(id: string): Promise<Organization>;
  createOrganization(input: OrganizationInput): Promise<Organization>;
  /** Fails with a conflict when `resourceVersion` is not the current one. The name can't change. */
  updateOrganization(id: string, input: OrganizationInput, resourceVersion: string): Promise<Organization>;
  deleteOrganization(id: string, resourceVersion: string): Promise<void>;
}
