import { describe, expect, it } from 'vitest';
import type { ClusterRole } from '../../api/clusters';
import { roleSet } from './editClusterText';

const TITLE = 'What the hub installs';
const SETTLES = 'The cluster shows Provisioning until the installation finishes.';

describe('roleSet', () => {
  it.each<[ClusterRole, string]>([
    [
      'ingress',
      'Saving sets the role to Ingress. The hub then installs MaaS, the consumer gateway, the MaaS portal, and the database replica on this cluster.',
    ],
    [
      'inference',
      'Saving sets the role to Inference. The hub then installs KServe model serving, the provider gateway, and the GPU operators on this cluster.',
    ],
    [
      'combined',
      'Saving sets the role to Ingress and inference. The hub then installs MaaS, the consumer gateway, the MaaS portal, the database replica, KServe model serving, the provider gateway, and the GPU operators on this cluster.',
    ],
  ])('words %s as what Save will do', (role, installs) => {
    expect(roleSet(role)).toEqual({ title: TITLE, installs, settling: SETTLES });
  });
});
