// Ported from krisv/ai-grid-cloud-provider-poc src/services/monitoring/demoObservability.ts at 62319b8.
//
// The Monitoring page's simulated per-model series and per-organization token usage, derived
// from the overview's gateway request rate. Only measurements are simulated: models and
// organizations are always the configured ones. The PoC's unused `allModels` parameter of
// modelMetrics is dropped.
import type { GridMetric, ManagedModel, Organization } from '../api/types';

const seed = (name: string) => [...name].reduce((n, c) => Math.imul(n, 31) + c.charCodeAt(0), 7) >>> 0;

/** A deterministic value in [0, 1) for a name and a 30-second time bucket. */
export const noise = (name: string, timestamp: number) => {
  let n = (seed(name) ^ Math.imul(Math.floor(timestamp / 30), 0x45d9f3b)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
};

/** The time integral of a series (trapezoids over seconds), or undefined without points. */
export function total(metric?: GridMetric) {
  const points = metric?.status === 'ok' ? metric.points : [];
  return points.length
    ? points
        .slice(1)
        .reduce((sum, p, i) => sum + ((p.value + points[i].value) / 2) * (p.timestamp - points[i].timestamp), 0)
    : undefined;
}

const modelDefinitions = [
  ['queue', 'Request queue length', 'requests'],
  ['replicas', 'Replica count', 'replicas'],
  ['p90', 'P90 E2E request latency', 'ms'],
  ['ttft', 'P90 Time to first token (TTFT)', 'ms'],
  ['tokens', 'Token throughput', 'tokens/s'],
  ['cache', 'KV cache utilization', '%'],
] as const;

/** Simulated performance series for the selected models, shaped by the gateway's load. */
export function modelMetrics(models: ManagedModel[], metrics: GridMetric[], simulated: boolean): GridMetric[] {
  const requests = metrics.find((m) => m.key === 'requests');
  const latency = metrics.find((m) => m.key === 'latency');
  const profile = models.reduce((sum, m) => sum + (seed(m.name) % 97), 0) / Math.max(1, models.length);
  return modelDefinitions.map(([key, label, unit]) => ({
    key,
    label,
    unit,
    status: simulated && requests?.status === 'ok' && models.length ? 'ok' : 'no-data',
    message: simulated ? 'No model telemetry for this selection.' : 'Per-model Thanos telemetry is not configured.',
    points:
      !simulated || !models.length
        ? []
        : (requests?.points ?? []).map((p, i) => {
            const jitter = noise(models.map((m) => m.name).join(',') + key, p.timestamp);
            const load = p.value;
            const value =
              key === 'queue'
                ? Math.max(0, Math.round(load * 0.07 + jitter * 6 - 2))
                : key === 'replicas'
                  ? models.reduce((n, m) => n + (m.replicas ?? 1), 0)
                  : key === 'p90'
                    ? (latency?.points[i]?.value ?? 180) * (0.8 + profile / 300) + (jitter - 0.5) * 25
                    : key === 'ttft'
                      ? 30 + load * 0.35 + profile * 0.3 + (jitter - 0.5) * 15
                      : key === 'tokens'
                        ? load * (14 + profile / 10) * (0.8 + jitter * 0.4)
                        : Math.min(98, 15 + load * 0.18 + profile * 0.2 + (jitter - 0.5) * 12);
            return { timestamp: p.timestamp, value: Number(value.toFixed(2)) };
          }),
  }));
}

export type OrganizationUsage = { id: string; name: string; input: number; output: number; cached: number };

/**
 * Simulated uncached input, output, and cached tokens per organization over the window.
 * Organization identities always come from the organizations service; only measurements are simulated.
 */
export function tenantUsage(
  metrics: GridMetric[],
  organizations: Pick<Organization, 'name' | 'id'>[],
): OrganizationUsage[] {
  const requests = metrics.find((m) => m.key === 'requests');
  const samples = requests?.status === 'ok' ? requests.points : [];
  const rates = organizations.map((organization, index) =>
    samples.map((p) => {
      const weights = organizations.map(
        (o) => 0.3 + noise(o.name + '-traffic', Math.floor(p.timestamp / 900) * 900) * 1.8,
      );
      const weight =
        weights[index] /
        Math.max(
          0.001,
          weights.reduce((a, b) => a + b, 0),
        );
      const name = organization.name;
      const inputPerRequest = 150 + (seed(name) % 350) + noise(name + '-prompt', p.timestamp) * 220;
      const outputPerRequest = 60 + (seed(name + '-output') % 180) + noise(name + '-generation', p.timestamp) * 120;
      const cacheFraction = 0.05 + noise(name + '-cache', Math.floor(p.timestamp / 300) * 300) * 0.65;
      const prompt = p.value * weight * inputPerRequest;
      return {
        timestamp: p.timestamp,
        input: prompt * (1 - cacheFraction),
        cached: prompt * cacheFraction,
        output: p.value * weight * outputPerRequest,
      };
    }),
  );
  return organizations.map((organization, index) => {
    const integrate = (key: 'input' | 'output' | 'cached') =>
      Math.round(
        rates[index]
          .slice(1)
          .reduce(
            (sum, p, i) => sum + ((p[key] + rates[index][i][key]) / 2) * (p.timestamp - rates[index][i].timestamp),
            0,
          ),
      );
    return {
      id: organization.id,
      name: organization.name,
      input: integrate('input'),
      output: integrate('output'),
      cached: integrate('cached'),
    };
  });
}
