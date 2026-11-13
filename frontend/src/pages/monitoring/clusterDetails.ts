// The cluster details a hub dashboard expects its host app to fill in, as odh-dashboard does
// (packages/observability/src/pages/ClusterDetailsVariablesProvider.tsx and src/utils/variables.ts):
// hidden text variables named CLUSTER_DETAILS_*, which the dashboard's "Cluster details" panel
// prints and which default to "N/A" until the host sets them.
import type { DashboardResource } from '@perses-dev/client';
import { DEFAULT_ALL_VALUE, type VariableValue } from '@perses-dev/spec';
import type { ManagedCluster } from '../../gen/ai_grid/v1/managed_cluster_type_pb';

/** The prefix odh-dashboard's isClusterDetailsVariable checks. */
export const CLUSTER_DETAILS_PREFIX = 'CLUSTER_DETAILS_';

export const INFRASTRUCTURE_PROVIDER = `${CLUSTER_DETAILS_PREFIX}INFRASTRUCTURE_PROVIDER`;
export const OPENSHIFT_VERSION = `${CLUSTER_DETAILS_PREFIX}OPENSHIFT_VERSION`;
export const CHANNEL = `${CLUSTER_DETAILS_PREFIX}CHANNEL`;
export const API_SERVER = `${CLUSTER_DETAILS_PREFIX}API_SERVER`;

/**
 * The list variable that picks the cluster on the AI grid cluster dashboard
 * (ai-grid-cluster-gitops apps/ai-grid-o11y/manifests/perses-dashboard-cluster.yaml, variable
 * `cluster_name`, multi-select with All): its values are ManagedCluster names.
 */
export const CLUSTER_VARIABLE = 'cluster_name';

// The claims ManagedClusterStatus.cluster_claims carries (the backend's managed_cluster_type.proto),
// as ACM's klusterlet writes them on an OpenShift cluster.
const CLAIM_PLATFORM = 'platform.open-cluster-management.io';
const CLAIM_OPENSHIFT_VERSION = 'version.openshift.io';
const CLAIM_API_SERVER = 'apiserverurl.openshift.io';

export const SELECT_ONE_CLUSTER = 'Select one cluster';
export const NOT_AVAILABLE = 'Not available';
export const LOADING = 'Loading';

/** The CLUSTER_DETAILS_* text variables the dashboard defines; the console sets these and no others. */
export const clusterDetailsVariables = (dashboard: DashboardResource): string[] =>
  (dashboard.spec.variables ?? [])
    .filter((v) => v.kind === 'TextVariable' && v.spec.name.startsWith(CLUSTER_DETAILS_PREFIX))
    .map((v) => v.spec.name);

/**
 * The one cluster the cluster variable names, or undefined for All, several, or none: All is
 * Perses's `$__all` (a multi-select keeps it alone in the list), and an empty value names nothing.
 */
export const selectedCluster = (value: VariableValue | undefined): string | undefined => {
  const values = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  return values.length === 1 && values[0] !== DEFAULT_ALL_VALUE && values[0] !== '' ? values[0] : undefined;
};

/** The clusters of Clusters/List by name, with their claims. */
export type ClusterClaims = Map<string, Record<string, string>>;

export const claimsByCluster = (items: ManagedCluster[]): ClusterClaims =>
  new Map(
    items.map((mc) => [mc.id, Object.fromEntries((mc.status?.clusterClaims ?? []).map((c) => [c.name, c.value]))]),
  );

/** What Clusters/List has answered, as the variables need it. */
export type ClusterLookup = { clusters?: ClusterClaims; loaded: boolean; error?: Error };

/**
 * The value of each of `names` for the cluster variable's value (undefined when the dashboard has
 * no cluster variable). One cluster: its claims from Clusters/List, "Not available" for one the hub
 * doesn't report (the hub has no record of the OpenShift AI operator's channel, so that one always
 * is), for a cluster Clusters/List doesn't have, or when Clusters/List fails; "Loading" until it
 * answers. All, several or no clusters: "Select one cluster". No cluster variable: "Not available".
 */
export const clusterDetailsValues = (
  names: string[],
  clusterValue: VariableValue | undefined,
  lookup: ClusterLookup,
): Record<string, string> => {
  const name = selectedCluster(clusterValue);
  const claims = name === undefined ? undefined : lookup.clusters?.get(name);
  const valueOf = (variable: string): string => {
    if (clusterValue === undefined) return NOT_AVAILABLE;
    if (name === undefined) return SELECT_ONE_CLUSTER;
    if (!lookup.clusters) return lookup.error || lookup.loaded ? NOT_AVAILABLE : LOADING;
    const claim = {
      [INFRASTRUCTURE_PROVIDER]: CLAIM_PLATFORM,
      [OPENSHIFT_VERSION]: CLAIM_OPENSHIFT_VERSION,
      [API_SERVER]: CLAIM_API_SERVER,
    }[variable];
    return (claim && claims?.[claim]) || NOT_AVAILABLE;
  };
  return Object.fromEntries(names.map((n) => [n, valueOf(n)]));
};
