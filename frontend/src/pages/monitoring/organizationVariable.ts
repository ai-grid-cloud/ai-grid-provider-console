// The Usage dashboard's Organization filter (ai-grid-cluster-gitops
// apps/ai-grid-o11y/manifests/usage-logs-admin-dashboard.yaml) lists the organization_id label
// values its Loki logs carry: each one the ID of a Keycloak organization, the same ID Tenants/List
// answers. Its select shows the organization's name instead; the dashboard still filters by ID.
import type { DashboardResource } from '@perses-dev/client';
import type { VariableDefinition } from '@perses-dev/spec';
import { RELABELED_LIST_VARIABLE, type RelabeledListVariableSpec } from './relabeledVariable';

/** The dashboard variable whose values are organization IDs. */
export const ORGANIZATION_VARIABLE = 'organization_id';

export type OrganizationName = { id: string; name: string };

const isOrganizationVariable = (v: VariableDefinition) =>
  v.kind === 'ListVariable' && v.spec.name === ORGANIZATION_VARIABLE;

/** Whether the dashboard has the organization variable, so the console reads the organizations. */
export const hasOrganizationVariable = (dashboard: DashboardResource): boolean =>
  dashboard.spec.variables.some(isOrganizationVariable);

/** Each organization's name by its ID, for those whose name isn't their ID already. */
export const organizationLabels = (organizations: OrganizationName[]): Record<string, string> =>
  Object.fromEntries(organizations.filter((o) => o.name && o.name !== o.id).map((o) => [o.id, o.name]));

/**
 * The dashboard with its organization variable's values labelled by organization name. The
 * variable's own plugin still finds the values, so an ID the logs carry that the console doesn't
 * list (an organization since deleted) is still offered, as its ID. Its name, display, All option,
 * custom All value and default stay as the dashboard defines them. A dashboard without the
 * variable, or with no names to give, comes back as it is.
 */
export const withOrganizationNames = (
  dashboard: DashboardResource,
  organizations: OrganizationName[],
): DashboardResource => {
  const labels = organizationLabels(organizations);
  if (!hasOrganizationVariable(dashboard) || Object.keys(labels).length === 0) {
    return dashboard;
  }
  const variables = dashboard.spec.variables.map((v): VariableDefinition => {
    if (v.kind !== 'ListVariable' || !isOrganizationVariable(v)) {
      return v;
    }
    const spec: RelabeledListVariableSpec = { plugin: v.spec.plugin, labels };
    return { ...v, spec: { ...v.spec, plugin: { kind: RELABELED_LIST_VARIABLE, spec } } };
  });
  return { ...dashboard, spec: { ...dashboard.spec, variables } };
};
