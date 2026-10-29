import type { ClusterRole } from '../../api/clusters';

/**
 * The AI Grid roles a cluster can have, as Add to AI Grid offers them and the Clusters pages show
 * them (GLOSSARY.md, "Ingress", "Inference" and "Combined"). A role says what the cluster does in
 * AI Grid; MaaS and KServe are the tools it does it with. The value is the cluster's
 * `ai-grid/role` label, which the hub's Placements select on.
 */
export const clusterRoles: { value: ClusterRole; label: string; description: string }[] = [
  {
    value: 'ingress',
    label: 'Ingress',
    description: "Receives requests from organizations' users through MaaS and routes them to inference clusters.",
  },
  {
    value: 'inference',
    label: 'Inference',
    description: 'Serves models with KServe. Requests reach it through an ingress cluster.',
  },
  { value: 'combined', label: 'Combined', description: 'Does both: receives requests through MaaS and serves models.' },
];

/** The cluster's `ai-grid/role` label when it's one of the roles above. */
export const roleOf = (labels: Record<string, string>) => clusterRoles.find((r) => r.value === labels['ai-grid/role']);
