// Ported from krisv/ai-grid-cloud-provider-poc shared/grid-monitoring.mjs at 62319b8.
//
// The PoC's deterministic load simulation, for MockConsoleService. The fake
// backend has the same port in Go (bff/internal/fakebackend/demometrics.go);
// both are pinned to the PoC's output by mock/golden/demo-metrics.json.
import type { ClusterStatus, GridMetric } from '../api/types';

// The PoC's metricDefinitions (grid-monitoring.mjs:5-10) without the Thanos queries.
export const metricDefinitions = [
  { key: 'requests', label: 'Gateway request rate', unit: 'req/s' },
  { key: 'errors', label: 'Gateway error rate', unit: 'req/s' },
  { key: 'latency', label: 'Gateway p95 latency', unit: 'ms' },
  { key: 'gpu', label: 'GPU utilization', unit: '%' },
] as const;

type MetricKey = (typeof metricDefinitions)[number]['key'];
type Row = Record<MetricKey, number> & { timestamp: number };

// grid-monitoring.mjs:17
const hash = (name: string): number => [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);

// grid-monitoring.mjs:18-22
const random = (seed: number, bucket: number): number => {
  let n = (seed ^ Math.imul(bucket, 0x45d9f3b)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};

// grid-monitoring.mjs:23-29
const traffic = (timestamp: number, seed: number): number => {
  const bucket = Math.floor(timestamp / 30);
  const baseline = 0.6 + (random(seed + 3, Math.floor(timestamp / 1800)) - 0.5) * 0.4;
  const offset = (random(seed, bucket) - 0.5) * 0.9;
  const spike = random(seed + 2, bucket) > 0.91 ? 0.5 + random(seed + 4, bucket) * 1.2 : 0;
  return Math.max(0.04, baseline + offset + spike);
};

/**
 * The PoC's demoMetrics (grid-monitoring.mjs:14-47). Every metric derives from the same
 * per-cluster traffic and GPU follows recent traffic. Only Ready clusters report; start,
 * end and step are Unix seconds.
 */
export function demoMetrics(
  clusters: { name: string; status: ClusterStatus }[],
  start: number,
  end: number,
  step: number,
): GridMetric[] {
  // grid-monitoring.mjs:15
  const active = clusters.filter((c) => c.status === 'Ready');
  // grid-monitoring.mjs:30-46
  const series: Row[] = Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => {
    const timestamp = start + i * step;
    const values = active.map((cluster) => {
      const seed = hash(cluster.name),
        capacity = 90 + (seed % 120);
      const load = traffic(timestamp, seed),
        recent = load * 0.8 + traffic(timestamp - 30, seed) * 0.15 + traffic(timestamp - 60, seed) * 0.05;
      const requests = capacity * load;
      const gpu = Math.min(98, 8 + recent * 66 + (random(seed + 1, Math.floor(timestamp / 30)) - 0.5) * 4);
      const pressure = Math.max(0, recent - 0.85);
      return {
        requests,
        gpu,
        errors: requests * (0.001 + pressure * 0.018 + random(seed + 2, Math.floor(timestamp / 30)) * 0.0015),
        latency: 65 + recent * 95 + pressure * 220,
      };
    });
    const requests = values.reduce((sum, v) => sum + v.requests, 0);
    return {
      timestamp,
      requests,
      errors: values.reduce((sum, v) => sum + v.errors, 0),
      gpu: values.reduce((sum, v) => sum + v.gpu, 0) / Math.max(1, values.length),
      latency: values.reduce((sum, v) => sum + v.latency * v.requests, 0) / Math.max(1, requests),
    };
  });
  // grid-monitoring.mjs:46-47
  return metricDefinitions.map((definition) => ({
    ...definition,
    status: active.length ? 'ok' : 'no-data',
    ...(!active.length
      ? {
          message: clusters.length
            ? 'No available clusters report simulated telemetry for this selection.'
            : 'No enrolled clusters match this selection.',
        }
      : {}),
    points: active.length
      ? series.map((row) => ({ timestamp: row.timestamp, value: Number(row[definition.key].toFixed(3)) }))
      : [],
  }));
}
