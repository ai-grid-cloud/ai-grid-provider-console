import type { ClusterRole } from '../../api/clusters';

/**
 * The AI grid roles a cluster can have, as Add to AI grid offers them and the Clusters pages show
 * them (GLOSSARY.md, "Ingress", "Inference" and "Ingress and inference"). A role says what the cluster does in
 * the AI grid; MaaS and KServe are the tools it does it with. The value is the cluster's
 * `ai-grid/role` label, which the hub's Placements select on: the third role's value stays
 * `combined`, whatever its label says. `description` explains one role on its own; `clusters` is
 * the same, after the role's name, in the list of every role ("Ingress clusters receive ...").
 */
export const clusterRoles: { value: ClusterRole; label: string; description: string; clusters: string }[] = [
  {
    value: 'ingress',
    label: 'Ingress',
    description:
      'The cluster receives requests via Models-as-a-Service and routes those requests to inference clusters.',
    clusters: 'clusters receive requests via Models-as-a-Service and route those requests to inference clusters.',
  },
  {
    value: 'inference',
    label: 'Inference',
    description: 'The cluster serves models via KServe and receives requests through an ingress cluster.',
    clusters: 'clusters serve models via KServe and receive requests through an ingress cluster.',
  },
  {
    value: 'combined',
    label: 'Ingress and inference',
    description: 'The cluster receives requests via Models-as-a-Service and serves models via KServe.',
    clusters: 'clusters receive requests via Models-as-a-Service and serve models via KServe.',
  },
];

/** The cluster's `ai-grid/role` label when it's one of the roles above. */
export const roleOf = (labels: Record<string, string>) => clusterRoles.find((r) => r.value === labels['ai-grid/role']);
