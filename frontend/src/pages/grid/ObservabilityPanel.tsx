// Layout and visual styling adapted from the cloned ProviderAdminObservabilityPage.
// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/ObservabilityPanel.tsx at 62319b8.
// The PoC's tenants are the console's organizations; visible text says "organization".
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Card,
  CardBody,
  ExpandableSection,
  FormSelect,
  FormSelectOption,
  Label,
  Tab,
  Tabs,
  TabTitleText,
  Title,
} from '@patternfly/react-core';
import type { GridCluster, GridMetric, GridRange, ManagedModel, Organization } from '../../api/types';
import { modelMetrics, tenantUsage, total } from '../../services/demoObservability';
import './observability.css';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <ExpandableSection toggleText={title} isExpanded={expanded} onToggle={(_, value) => setExpanded(value)}>
      {children}
    </ExpandableSection>
  );
}

function Stat({ label, value, unit, warn = false }: { label: string; value: string; unit?: string; warn?: boolean }) {
  return (
    <div className={`observability-stat-card${warn ? ' observability-stat-card--warn' : ''}`}>
      <div className="observability-stat-card__label">{label}</div>
      <div className="observability-stat-card__value">
        {value}
        {unit && <span className="observability-stat-card__unit">{unit}</span>}
      </div>
    </div>
  );
}

/** A hand-drawn SVG area chart of one series, with a hover readout. */
export function MetricChart({ metric }: { metric: GridMetric }) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId().replaceAll(':', '');
  const points = metric.points;
  const last = points.at(-1);
  const first = points[0];
  const start = first?.timestamp ?? 0;
  const end = last?.timestamp ?? 1;
  const ceiling = metric.unit === '%' ? 100 : Math.max(1, ...points.map((p) => p.value)) * 1.12;
  const x = (timestamp: number) => 48 + ((timestamp - start) / (end - start || 1)) * 506;
  const y = (value: number) => 156 - (value / ceiling) * 132;
  const path = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.timestamp)} ${y(p.value)}`).join(' ');
  const color =
    metric.key === 'gpu'
      ? '#0066cc'
      : metric.key === 'requests'
        ? '#3e8635'
        : metric.key === 'errors'
          ? '#c9190b'
          : '#6b46c1';
  const point = hover === null ? undefined : points[hover];
  const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: ceiling < 5 ? 3 : 1 });
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const readoutX = point ? Math.min(370, Math.max(48, x(point.timestamp) - 80)) : 0;
  return (
    <Card className="observability-metric-card">
      <CardBody>
        <Title headingLevel="h3" size="md" className="observability-metric-card__title">
          {metric.label}
        </Title>
        {metric.status === 'ok' && last ? (
          <>
            <svg
              data-start={start}
              data-end={end}
              viewBox="0 0 580 190"
              role="img"
              aria-label={`${metric.label} over time`}
              className="observability-chart"
              onMouseLeave={() => setHover(null)}
              onMouseMove={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                const cursor = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 580;
                setHover(
                  Math.max(0, Math.min(points.length - 1, Math.round(((cursor - 48) / 506) * (points.length - 1)))),
                );
              }}
            >
              <defs>
                <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.26" />
                  <stop offset="100%" stopColor={color} stopOpacity="0.03" />
                </linearGradient>
              </defs>
              {ticks.map((f) => (
                <g key={f}>
                  <line x1="48" x2="554" y1={y(ceiling * f)} y2={y(ceiling * f)} stroke="currentColor" opacity="0.1" />
                  <text x="42" y={y(ceiling * f) + 4} textAnchor="end" fontSize="10" fill="currentColor">
                    {format(ceiling * f)}
                    {metric.unit === '%' ? '%' : ''}
                  </text>
                </g>
              ))}
              <path d={`${path} L554 156 L48 156 Z`} fill={`url(#fill-${id})`} />
              <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
              {metric.key === 'gpu' && (
                <line x1="48" x2="554" y1={y(90)} y2={y(90)} stroke="#f0ab00" strokeDasharray="4 3" />
              )}
              {ticks.map((f) => (
                <text
                  key={f}
                  x={48 + f * 506}
                  y="179"
                  textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}
                  fontSize="10"
                  fill="currentColor"
                >
                  {new Date((start + f * (end - start)) * 1000).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </text>
              ))}
              {point && (
                <g>
                  <line x1={x(point.timestamp)} x2={x(point.timestamp)} y1="24" y2="156" stroke={color} opacity="0.5" />
                  <circle cx={x(point.timestamp)} cy={y(point.value)} r="3" fill={color} />
                  <rect
                    x={readoutX}
                    y="0"
                    width="185"
                    height="22"
                    rx="3"
                    fill="var(--pf-t--global--background--color--primary--default)"
                    stroke={color}
                  />
                  <text x={readoutX + 7} y="15" fontSize="11" fill="currentColor">
                    {new Date(point.timestamp * 1000).toLocaleTimeString()} · {format(point.value)} {metric.unit}
                  </text>
                </g>
              )}
            </svg>
            <p className="observability-chart-caption">
              Latest: {format(last.value)} {metric.unit} · {new Date(last.timestamp * 1000).toLocaleTimeString()}
            </p>
          </>
        ) : (
          <p className="observability-empty-metric">{metric.message ?? 'No data available.'}</p>
        )}
      </CardBody>
    </Card>
  );
}

type Props = {
  clusters: GridCluster[];
  models: ManagedModel[];
  modelsError?: string;
  organizations: Organization[];
  organizationsError?: string;
  metrics: GridMetric[];
  loading: boolean;
  error?: string;
  simulated: boolean;
  range: GridRange;
};

/** The Monitoring page's Cluster, Models, and Usage tabs. */
export function ObservabilityPanel({
  clusters,
  models,
  modelsError,
  organizations,
  organizationsError,
  metrics,
  loading,
  error,
  simulated,
  range,
}: Props) {
  const [tab, setTab] = useState<string | number>('cluster');
  const [model, setModel] = useState('all');
  const value = (key: string) => {
    const m = metrics.find((m) => m.key === key);
    const points = m?.status === 'ok' ? m.points : [];
    return points.length ? points.reduce((n, p) => n + p.value, 0) / points.length : undefined;
  };
  const gpu = value('gpu');
  const requestTotal = total(metrics.find((m) => m.key === 'requests'));
  const errorTotal = total(metrics.find((m) => m.key === 'errors'));
  const success =
    requestTotal !== undefined && requestTotal > 0 && errorTotal !== undefined
      ? Math.max(0, 100 * (1 - errorTotal / requestTotal))
      : undefined;
  const metricText = (v: number | undefined) =>
    v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const charts = (keys: string[], columns = 2) => (
    <div className={`observability-chart-grid observability-chart-grid--${columns}col`}>
      {keys.map((key) => {
        const metric = metrics.find((m) => m.key === key);
        return metric ? <MetricChart key={key} metric={metric} /> : null;
      })}
    </div>
  );
  const relevantModels = models.filter(
    (m) => m.locations.length === 0 || clusters.some((c) => c.location && m.locations.includes(c.location)),
  );
  if (model !== 'all' && !relevantModels.some((m) => m.name === model)) {
    setModel('all');
  }
  const visibleModels = relevantModels.filter((m) => model === 'all' || m.name === model);
  const modelSeries = modelMetrics(visibleModels, metrics, simulated);
  const usage = tenantUsage(metrics, organizations);
  const usageTotal = usage.reduce((n, t) => n + t.input + t.output + t.cached, 0);
  // Auto-scale totals; variable organization shares and token mixes change relative bar shapes.
  const usageMaximum = Math.max(1, ...usage.map((t) => t.input + t.output + t.cached)) * 1.1;
  const tokenLabel = (n: number) =>
    n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);

  const usageTab = () => {
    if (organizationsError) {
      return (
        <Alert isInline variant="warning" title="Organization data unavailable">
          {organizationsError}
        </Alert>
      );
    }
    if (!organizations.length) {
      return (
        <Alert isInline variant="info" title="No organizations">
          Create organizations to see their simulated consumption.
        </Alert>
      );
    }
    if (!simulated || requestTotal === undefined) {
      return (
        <Alert isInline variant="info" title="Organization usage unavailable">
          Organization token telemetry is not configured for this source or selection.
        </Alert>
      );
    }
    return (
      <>
        <p className="observability-chart-caption">
          Simulated token consumption for configured organizations over the selected {range} window.
        </p>
        <div className="observability-chart-grid observability-chart-grid--2col">
          <Card className="observability-metric-card">
            <CardBody>
              <Title headingLevel="h3" size="md" className="observability-metric-card__title">
                Token consumption by organization
              </Title>
              <p className="observability-consumption-total">
                Total consumption: {usageTotal.toLocaleString()} tokens · Last {range}
              </p>
              <svg
                viewBox="0 0 560 240"
                role="img"
                aria-label="Token consumption by organization"
                className="observability-chart"
                data-total={usageTotal}
              >
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <g key={f}>
                    <line x1="62" x2="550" y1={180 - f * 150} y2={180 - f * 150} stroke="currentColor" opacity="0.1" />
                    <text x="56" y={184 - f * 150} textAnchor="end" fontSize="10" fill="currentColor">
                      {tokenLabel(usageMaximum * f)}
                    </text>
                  </g>
                ))}
                {usage.map((t, i) => {
                  const x = 75 + i * (475 / Math.max(1, usage.length));
                  const width = Math.min(70, 330 / Math.max(1, usage.length));
                  const input = (t.input / usageMaximum) * 150;
                  const output = (t.output / usageMaximum) * 150;
                  const cached = (t.cached / usageMaximum) * 150;
                  return (
                    <g key={t.id}>
                      <rect
                        data-organization={t.id}
                        data-kind="input"
                        x={x}
                        y={180 - input}
                        width={width}
                        height={input}
                        fill="#0066cc"
                        opacity="0.7"
                      />
                      <rect
                        data-kind="output"
                        x={x}
                        y={180 - input - output}
                        width={width}
                        height={output}
                        fill="#3e8635"
                        opacity="0.7"
                      />
                      <rect
                        data-kind="cached"
                        x={x}
                        y={180 - input - output - cached}
                        width={width}
                        height={cached}
                        fill="#6b46c1"
                        opacity="0.7"
                      />
                      <text
                        x={x + width / 2}
                        y={172 - input - output - cached}
                        textAnchor="middle"
                        fontSize="11"
                        fill="currentColor"
                      >
                        {tokenLabel(t.input + t.output + t.cached)}
                      </text>
                      <text x={x + width / 2} y="210" textAnchor="middle" fontSize="12" fill="currentColor">
                        {t.name}
                      </text>
                      <title>
                        {t.name}: {t.input.toLocaleString()} uncached input, {t.output.toLocaleString()} output,{' '}
                        {t.cached.toLocaleString()} cached tokens
                      </title>
                    </g>
                  );
                })}
              </svg>
              <p className="observability-chart-caption">Blue: uncached input · Green: output · Purple: cached input</p>
            </CardBody>
          </Card>
        </div>
        <Card className="observability-metric-card">
          <CardBody>
            <Title headingLevel="h3" size="md" className="observability-metric-card__title">
              Usage by organization
            </Title>
            <div className="grid-table-scroll">
              <table className="grid-table" aria-label="Organization usage">
                <thead>
                  <tr>
                    {['Organization', 'Organization ID', 'Uncached input tokens', 'Output tokens', 'Cached tokens'].map(
                      (h) => (
                        <th key={h}>{h}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {usage.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>
                        <code>{t.id}</code>
                      </td>
                      <td>{t.input.toLocaleString()}</td>
                      <td>{t.output.toLocaleString()}</td>
                      <td>{t.cached.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </>
    );
  };

  return (
    <>
      <Tabs activeKey={tab} onSelect={(_, key) => setTab(key)}>
        <Tab eventKey="cluster" title={<TabTitleText>Cluster</TabTitleText>} />
        <Tab eventKey="models" title={<TabTitleText>Models</TabTitleText>} />
        <Tab eventKey="usage" title={<TabTitleText>Usage</TabTitleText>} />
      </Tabs>
      <div className="observability-dashboard">
        {loading && <p role="status">Loading metrics for the selected site and time range…</p>}
        {error && (
          <Alert isInline variant="danger" title="Monitoring unavailable">
            {error}
          </Alert>
        )}
        {tab === 'cluster' && (
          <>
            <Section title="Overview">
              <p className="observability-chart-caption">
                Metrics summarize the selected {range} window. Cluster availability is current ACM inventory.
              </p>
              <div className="observability-stat-row">
                <Stat
                  label="Available clusters"
                  value={`${clusters.filter((c) => c.status === 'Ready').length}/${clusters.length}`}
                />
                <Stat label="Requests in window" value={metricText(requestTotal)} />
                <Stat
                  label="Average GPU utilization"
                  value={metricText(gpu)}
                  unit="%"
                  warn={gpu !== undefined && gpu > 85}
                />
                <Stat label="Request success rate" value={metricText(success)} unit="%" />
              </div>
            </Section>
            <Section title="Cluster resource overview">{charts(['gpu', 'requests'])}</Section>
            <Section title="Gateway performance">{charts(['errors', 'latency'])}</Section>
            <Section title="Managed clusters">
              <Card className="observability-metric-card">
                <CardBody>
                  <div className="grid-table-scroll">
                    <table className="grid-table">
                      <thead>
                        <tr>
                          {['Cluster', 'Site', 'Location', 'Availability', 'Provisioning'].map((h) => (
                            <th key={h}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {clusters.map((c) => (
                          <tr key={c.name}>
                            <td>{c.name}</td>
                            <td>{c.siteName ?? c.site ?? 'Not assigned'}</td>
                            <td>{c.location ?? '—'}</td>
                            <td>
                              <Label color={c.status === 'Ready' ? 'green' : c.status === 'Offline' ? 'red' : 'grey'}>
                                {c.status}
                              </Label>
                            </td>
                            <td>{c.provisioningStatus}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!clusters.length && <p>No enrolled clusters match this selection.</p>}
                </CardBody>
              </Card>
            </Section>
          </>
        )}
        {tab === 'models' && (
          <>
            {modelsError && (
              <Alert isInline variant="warning" title="Models unavailable">
                {modelsError}
              </Alert>
            )}
            <div className="observability-model-filter">
              <label htmlFor="observability-model">Model deployment</label>
              <FormSelect
                id="observability-model"
                aria-label="Select model deployment"
                value={model}
                onChange={(_, value) => setModel(value)}
              >
                <FormSelectOption value="all" label="All models" />
                {relevantModels.map((m) => (
                  <FormSelectOption key={m.name} value={m.name} label={m.displayName ?? m.name} />
                ))}
              </FormSelect>
            </div>
            <Section title="Model deployments">
              <Card className="observability-metric-card">
                <CardBody>
                  <div className="grid-table-scroll">
                    <table className="grid-table" aria-label="Model deployments">
                      <thead>
                        <tr>
                          {['Model deployment', 'Model', 'Target sites', 'Replicas', 'Configuration'].map((h) => (
                            <th key={h}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleModels.map((m) => (
                          <tr key={m.name}>
                            <td>{m.displayName ?? m.name}</td>
                            <td>{m.modelName ?? m.modelRef.name}</td>
                            <td>
                              {[
                                ...new Set(
                                  clusters
                                    .filter((c) => c.location && m.locations.includes(c.location))
                                    .map((c) => c.siteName ?? c.site ?? c.name),
                                ),
                              ].join(', ') || 'Not assigned'}
                            </td>
                            <td>{m.replicas ?? '—'}</td>
                            <td>{m.phase}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!visibleModels.length && <p>No model deployments match this selection.</p>}
                </CardBody>
              </Card>
            </Section>
            <Section title="Performance metrics">
              {simulated && (
                <p className="observability-chart-caption">
                  Simulated per-model performance for the selected time window.
                </p>
              )}
              <div className="observability-chart-grid observability-chart-grid--2col">
                {modelSeries.map((m) => (
                  <MetricChart key={m.key} metric={m} />
                ))}
              </div>
            </Section>
            <p className="observability-chart-caption">
              Sites reflect saved placement targets. Simulated metrics demonstrate the design and do not confirm
              deployment readiness.
            </p>
          </>
        )}
        {tab === 'usage' && usageTab()}
      </div>
    </>
  );
}
