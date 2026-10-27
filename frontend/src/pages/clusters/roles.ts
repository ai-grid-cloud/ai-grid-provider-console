import type { ClusterRole } from '../../api/clusters';

/** The roles a member can have, as Add to AI Grid offers them and the Clusters table shows them. */
export const clusterRoles: { value: ClusterRole; label: string; description: string }[] = [
  { value: 'combined', label: 'Combined', description: 'Takes tenant traffic and serves models.' },
  { value: 'ingress', label: 'Ingress', description: 'Takes tenant traffic and routes it to inference clusters.' },
  { value: 'inference', label: 'Inference', description: 'Serves models behind an ingress cluster.' },
];

/** The cluster's `ai-grid/role` label when it's one of the roles above. */
export const roleOf = (labels: Record<string, string>) => clusterRoles.find((r) => r.value === labels['ai-grid/role']);
