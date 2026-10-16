// Ported from krisv/ai-grid-cloud-provider-poc src/services/monitoring/__tests__/demoObservability.test.ts at 62319b8.
// The PoC's tenants become the fixture organizations, which carry an id as well as a name.
import type { GridMetric } from '../api/types';
import { tenantUsage } from './demoObservability';

it('uses supplied identities and changes token mixes across windows without double counting cached input', () => {
  const organizations = [
    { id: '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c', name: 'acme-robotics' },
    { id: '8d2e7b31-0c4f-4a9d-b5e6-7f8a9b0c1d2e', name: 'globex-research' },
  ];
  const metric: GridMetric = {
    key: 'requests',
    label: 'Requests',
    unit: 'req/s',
    status: 'ok',
    points: Array.from({ length: 1441 }, (_, i) => ({ timestamp: 100000 - i * 60, value: 100 })).reverse(),
  };
  const day = tenantUsage([metric], organizations);
  const hour = tenantUsage([{ ...metric, points: metric.points.slice(-61) }], organizations);
  expect(day.map((t) => t.id)).toEqual(organizations.map((o) => o.id));
  expect(day.map((t) => t.name)).toEqual(['acme-robotics', 'globex-research']);
  expect(tenantUsage([metric], [])).toEqual([]);
  expect(hour[0].cached).toBeGreaterThan(0);
  expect(day[0].input).toBeGreaterThan(hour[0].input);
  expect(day[0].input / day[1].input).not.toBeCloseTo(hour[0].input / hour[1].input, 3);
  expect(day[0].cached / day[0].input).not.toBeCloseTo(hour[0].cached / hour[0].input, 3);
});
