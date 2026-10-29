import type { ClusterView } from './clusterView';

/**
 * What onConfirm throws when the cluster changed since the dialog loaded it (a 409): `current` is
 * the cluster as the backend has it now, or undefined when it couldn't be loaded again.
 */
export class ClusterChangedError extends Error {
  constructor(readonly current?: ClusterView) {
    super('The cluster was changed after this dialog opened.');
    this.name = 'ClusterChangedError';
  }
}
