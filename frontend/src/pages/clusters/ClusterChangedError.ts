import type { GridCluster } from '../../api/types';

/**
 * What onConfirm throws when the cluster changed since the dialog loaded it (a 409): `current` is
 * the cluster as the backend has it now, or undefined when it couldn't be loaded again.
 */
export class ClusterChangedError extends Error {
  constructor(readonly current?: GridCluster) {
    super('The cluster changed since the dialog loaded it.');
    this.name = 'ClusterChangedError';
  }
}
