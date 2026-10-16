import golden from '../../../mock/golden/demo-metrics.json';
import { MockConsoleService, seedClusters } from '../api/MockConsoleService';
import { demoMetrics } from './demoMetrics';

describe('demoMetrics', () => {
  it('matches the PoC (mock/golden/demo-metrics.json)', () => {
    const { clusters, start, end, step } = golden.input;
    // The golden's input is the AI Grid members, the same clusters the mock seeds.
    expect(
      seedClusters()
        .filter((c) => c.aiGridEnabled)
        .map(({ name, status }) => ({ name, status })),
    ).toEqual(clusters);

    const got = demoMetrics(
      seedClusters().filter((c) => c.aiGridEnabled),
      start,
      end,
      step,
    );
    expect(got.map(({ points, ...rest }) => ({ ...rest, points: points.length }))).toEqual(
      golden.metrics.map(({ points, ...rest }) => ({ ...rest, points: points.length })),
    );
    got.forEach((metric, i) =>
      metric.points.forEach((point, j) => {
        const want = golden.metrics[i].points[j];
        expect(point.timestamp).toBe(want.timestamp);
        expect(Math.abs(point.value - want.value)).toBeLessThanOrEqual(1e-9);
      }),
    );
  });

  it('explains why there is no data', () => {
    const offline = { name: 'site1', status: 'Offline' as const };
    for (const [clusters, message] of [
      [[offline], 'No available clusters report simulated telemetry for this selection.'],
      [[], 'No enrolled clusters match this selection.'],
    ] as const) {
      const metrics = demoMetrics([...clusters], 1790000000, 1790003600, 60);
      expect(metrics).toHaveLength(4);
      for (const metric of metrics) {
        expect(metric).toMatchObject({ status: 'no-data', message, points: [] });
      }
    }
  });
});

describe('MockConsoleService.getGridOverview', () => {
  afterEach(() => vi.useRealTimers());

  it('answers like the fake backend: members, simulated metrics for the range ending now', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.500Z'), toFake: ['Date'] });
    const end = Date.parse('2026-10-16T09:00:00Z') / 1000;
    const service = new MockConsoleService();

    const overview = await service.getGridOverview('6h');
    expect(overview).toMatchObject({
      updatedAt: '2026-10-16T09:00:00.000Z',
      inventorySource: 'acm',
      demo: false,
      metricsSource: 'demo',
    });
    expect(overview.clusters.map((c) => c.name)).toEqual(['site1', 'site2', 'site3']);
    expect(overview.metrics.map((m) => m.key)).toEqual(['requests', 'errors', 'latency', 'gpu']);
    for (const metric of overview.metrics) {
      expect(metric.status).toBe('ok');
      expect(metric.points).toHaveLength(61);
      expect(metric.points[0].timestamp).toBe(end - 21600);
      expect(metric.points[1].timestamp - metric.points[0].timestamp).toBe(360);
    }

    const brussels = await service.getGridOverview('1h', { site: 'brussels', includeMetrics: false });
    expect(brussels.clusters.map((c) => c.name)).toEqual(['site3']);
    expect(brussels.metrics).toEqual([]);

    const nowhere = await service.getGridOverview('24h', { site: 'nowhere' });
    expect(nowhere.clusters).toEqual([]);
    expect(nowhere.metrics[0]).toMatchObject({
      status: 'no-data',
      message: 'No enrolled clusters match this selection.',
    });
  });
});
