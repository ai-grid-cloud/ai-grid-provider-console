import { describe, expect, it } from 'vitest';
import type { ModelHardware } from '../../api/types';
import type { ClusterView } from '../clusters/clusterView';
import { defaultHardware } from './modelHardware';

const nvidia: ModelHardware = { id: 'nvidia-gpu', label: 'NVIDIA GPU', accelerator: 'nvidia.com/gpu' };
const cpu: ModelHardware = { id: 'cpu', label: 'CPU only', image: 'r/cpu:1' };
const list = [nvidia, cpu];

const cluster = (gpuCapacity: number | undefined, role = 'combined', enabled = true): ClusterView =>
  ({
    name: `c-${Math.random()}`,
    aiGridEnabled: enabled,
    gpuCapacity,
    labels: { 'ai-grid/role': role },
  }) as unknown as ClusterView;

describe('defaultHardware', () => {
  it('is the CPU entry when every serving cluster has no GPUs', () => {
    expect(defaultHardware(list, [cluster(0), cluster(0, 'inference')])).toBe(cpu);
  });
  it('is the first entry when any serving cluster has GPUs', () => {
    expect(defaultHardware(list, [cluster(0), cluster(16)])).toBe(nvidia);
  });
  it('is the first entry without clusters or with an unknown GPU count', () => {
    expect(defaultHardware(list, undefined)).toBe(nvidia);
    expect(defaultHardware(list, [])).toBe(nvidia);
    expect(defaultHardware(list, [cluster(undefined)])).toBe(nvidia);
    expect(defaultHardware(list, [cluster(0), cluster(undefined)])).toBe(nvidia);
  });
  it('ignores clusters that serve no models', () => {
    expect(defaultHardware(list, [cluster(0), cluster(16, 'ingress'), cluster(16, 'combined', false)])).toBe(cpu);
    expect(defaultHardware(list, [cluster(0, 'ingress'), cluster(0, 'combined', false)])).toBe(nvidia);
  });
  it('is the first entry when no entry is CPU only', () => {
    expect(defaultHardware([nvidia], [cluster(0)])).toBe(nvidia);
  });
});
