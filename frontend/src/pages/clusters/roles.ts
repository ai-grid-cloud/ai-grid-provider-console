import type { ClusterRole } from '../../api/clusters';

/**
 * The AI Grid roles a cluster can have, as Add to AI Grid offers them and the Clusters pages show
 * them (GLOSSARY.md, "Ingress", "Inference" and "Ingress and inference"). A role says what the cluster does in
 * AI Grid; MaaS and KServe are the tools it does it with. The value is the cluster's
 * `ai-grid/role` label, which the hub's Placements select on: the third role's value stays
 * `combined`, whatever its label says.
 */
export const clusterRoles: { value: ClusterRole; label: string; description: string }[] = [
  {
    value: 'ingress',
    label: 'Ingress',
    description:
      'The cluster receives requests via Models-as-a-Service and routes those requests to inference clusters.',
  },
  {
    value: 'inference',
    label: 'Inference',
    description: 'The cluster serves models via KServe and receives requests through an ingress cluster.',
  },
  {
    value: 'combined',
    label: 'Ingress and inference',
    description: 'The cluster receives requests via Models-as-a-Service and serves models via KServe.',
  },
];

/** The cluster's `ai-grid/role` label when it's one of the roles above. */
export const roleOf = (labels: Record<string, string>) => clusterRoles.find((r) => r.value === labels['ai-grid/role']);
