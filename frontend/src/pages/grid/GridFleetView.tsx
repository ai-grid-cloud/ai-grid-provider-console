// Layout adapted from the reference VisionModelFleetPage.
// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridFleetView.tsx at 62319b8.
import { useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  DrawerContent,
  DrawerContentBody,
  DrawerHead,
  DrawerPanelBody,
  DrawerPanelContent,
  Label,
  SearchInput,
  Title,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';
import { AngleLeftIcon, CubesIcon } from '@patternfly/react-icons';
import { Link } from 'react-router-dom';
import type { GridCluster, ManagedModel } from '../../api/types';
import { GridFleetMap } from './GridFleetMap';
import type { TileLayerConfig } from './tiles';
import './grid-fleet.css';

type Selection = { kind: 'cluster' | 'model'; name: string };

type Props = {
  clusters: GridCluster[];
  models: ManagedModel[];
  modelsError?: string;
  tiles: TileLayerConfig | null | undefined;
};

const matches = (model: ManagedModel, cluster: GridCluster) =>
  Boolean(cluster.location && model.locations.includes(cluster.location));

const displayName = (model: ManagedModel) => model.displayName ?? model.name;

const siteOf = (cluster: GridCluster) => cluster.siteName ?? cluster.site ?? cluster.name;

const statusColor = (cluster: GridCluster) =>
  cluster.status === 'Ready' ? 'green' : cluster.status === 'Offline' ? 'red' : 'grey';

const availabilityFilters = [
  ['all', 'All'],
  ['Ready', 'Available'],
  ['Offline', 'Offline'],
  ['Unknown', 'Unknown'],
];

const Fields: React.FC<{ items: Array<[string, string]> }> = ({ items }) => (
  <dl className="fleet-details">
    {items.map(([label, value]) => (
      <div key={label}>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

export const GridFleetView: React.FC<Props> = ({ clusters, models, modelsError, tiles }) => {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [history, setHistory] = useState<Selection[]>([]);
  const [mode, setMode] = useState<'cluster' | 'model'>('cluster');
  const [search, setSearch] = useState('');
  const [availability, setAvailability] = useState('all');

  const selectedCluster = selection?.kind === 'cluster' ? clusters.find((c) => c.name === selection.name) : undefined;
  const selectedModel = selection?.kind === 'model' ? models.find((m) => m.name === selection.name) : undefined;
  const relevantModels = models.filter((m) => m.locations.length === 0 || clusters.some((c) => matches(m, c)));
  const query = search.toLowerCase();
  const visibleClusters = clusters.filter(
    (c) =>
      (availability === 'all' || c.status === availability) &&
      `${c.name} ${c.site ?? ''} ${c.siteName ?? ''} ${models
        .filter((m) => matches(m, c))
        .map(displayName)
        .join(' ')}`
        .toLowerCase()
        .includes(query),
  );
  const visibleModels = relevantModels.filter((m) =>
    `${m.name} ${displayName(m)} ${m.modelName ?? ''} ${clusters
      .filter((c) => matches(m, c))
      .map(siteOf)
      .join(' ')}`
      .toLowerCase()
      .includes(query),
  );

  const open = (next: Selection) => {
    if (selection) {
      setHistory((previous) => [...previous, selection]);
    }
    setSelection(next);
  };
  const reset = () => {
    setSelection(null);
    setHistory([]);
  };
  const back = () => {
    setSelection(history.at(-1) ?? null);
    setHistory((previous) => previous.slice(0, -1));
  };

  const mapClusters = selectedModel
    ? clusters.filter((c) => matches(selectedModel, c))
    : mode === 'cluster'
      ? visibleClusters
      : clusters.filter((c) => visibleModels.some((m) => matches(m, c)));
  const relatedModels = selectedCluster ? models.filter((m) => matches(m, selectedCluster)) : [];
  const relatedClusters = selectedModel ? clusters.filter((c) => matches(selectedModel, c)) : [];

  const siteLinks = (model: ManagedModel) => {
    const targets = clusters.filter((c) => matches(model, c));
    return targets.length ? (
      <div className="fleet-related-links">
        {targets.map((c) => (
          <Button key={c.name} variant="link" isInline onClick={() => open({ kind: 'cluster', name: c.name })}>
            {siteOf(c)} · {c.name}
          </Button>
        ))}
      </div>
    ) : (
      <p className="fleet-details-note">
        {model.locations.length ? 'No matching enrolled sites in this view.' : 'No sites assigned.'}
      </p>
    );
  };

  const modelLinks = (cluster: GridCluster) => {
    const assigned = models.filter((m) => matches(m, cluster));
    return assigned.length ? (
      <div className="fleet-related-links">
        {assigned.map((m) => (
          <Button key={m.name} variant="link" isInline onClick={() => open({ kind: 'model', name: m.name })}>
            {displayName(m)}
          </Button>
        ))}
      </div>
    ) : (
      <p className="fleet-details-note">
        {modelsError ? 'Model assignments unavailable.' : 'No models assigned to this location.'}
      </p>
    );
  };

  const objects = mode === 'cluster' ? 'clusters' : 'models';

  const head =
    selection && (selectedCluster || selectedModel) ? (
      <div className="fleet-detail-header">
        <Button variant="link" isInline icon={<AngleLeftIcon />} onClick={back}>
          {history.length ? 'Back' : mode === 'cluster' ? 'Clusters' : 'Models'}
        </Button>
        <Title headingLevel="h2" size="lg">
          {selectedCluster?.name ?? (selectedModel && displayName(selectedModel))}
        </Title>
        <span>{selectedCluster ? (selectedCluster.siteName ?? selectedCluster.site) : selectedModel?.name}</span>
      </div>
    ) : (
      <div className="fleet-panel-toolbar">
        <SearchInput
          aria-label={`Search grid ${objects}`}
          placeholder={`Search ${objects}`}
          value={search}
          onChange={(_, value) => setSearch(value)}
          onClear={() => setSearch('')}
        />
        <ToggleGroup aria-label="Grid object type" isCompact>
          {(['cluster', 'model'] as const).map((value) => (
            <ToggleGroupItem
              key={value}
              text={value === 'cluster' ? 'Clusters' : 'Models'}
              buttonId={`grid-type-${value}`}
              isSelected={mode === value}
              onChange={() => {
                setMode(value);
                setSearch('');
                reset();
              }}
            />
          ))}
        </ToggleGroup>
      </div>
    );

  const clusterDetails = (cluster: GridCluster) => (
    <>
      <div className="fleet-detail-badges">
        <Label color={statusColor(cluster)}>{cluster.status}</Label>
        <Label color={cluster.provisioned ? 'green' : 'blue'}>{cluster.provisioningStatus}</Label>
      </div>
      <section className="fleet-detail-section">
        <Title headingLevel="h3" size="md">
          Site and cluster
        </Title>
        <Fields
          items={[
            ['Site', cluster.siteName ?? cluster.site ?? 'Not assigned'],
            ['Site identifier', cluster.site ?? 'Not assigned'],
            ['Region', cluster.region ?? 'Not assigned'],
            ['Placement location', cluster.location ?? 'Not assigned'],
            [
              'Coordinates',
              cluster.latitude !== undefined ? `${cluster.latitude}, ${cluster.longitude}` : 'Not assigned',
            ],
            ['AI Grid membership', cluster.aiGridEnabled ? 'Enrolled' : 'Not enrolled'],
          ]}
        />
      </section>
      <section className="fleet-detail-section">
        <div className="fleet-panel-heading">
          <Title headingLevel="h3" size="md">
            Models at this location
          </Title>
          <Label isCompact>{relatedModels.length}</Label>
        </div>
        {modelLinks(cluster)}
        <p className="fleet-details-note">
          Assignments reflect saved model placement targets. Serving readiness is not verified.
        </p>
      </section>
      <Link to="/clusters">Manage clusters →</Link>
    </>
  );

  const modelDetails = (model: ManagedModel) => (
    <>
      <div className="fleet-detail-badges">
        <Label color="blue">{model.phase}</Label>
        {model.availableForSubscriptions && <Label color="green">Available for subscriptions</Label>}
      </div>
      <section className="fleet-detail-section">
        <Title headingLevel="h3" size="md">
          Model configuration
        </Title>
        <Fields
          items={[
            ['Deployment name', model.name],
            ['Model', model.modelName ?? model.modelRef.name],
            ['Resource type', model.modelRef.kind],
            ['Replicas', model.replicas !== undefined ? String(model.replicas) : 'Not specified'],
            ['Model URI', model.modelUri ?? 'Not specified'],
            ['Runtime image', model.runtimeImage ?? 'Not specified'],
            ['Placement locations', model.locations.join(', ') || 'Not assigned'],
          ]}
        />
      </section>
      <section className="fleet-detail-section">
        <div className="fleet-panel-heading">
          <Title headingLevel="h3" size="md">
            Target sites and clusters
          </Title>
          <Label isCompact>{relatedClusters.length}</Label>
        </div>
        {siteLinks(model)}
        <p className="fleet-details-note">
          These are intended placement targets, not confirmation of a running deployment.
        </p>
      </section>
      <Link to="/models">Manage models →</Link>
    </>
  );

  const list = (
    <>
      <div className="fleet-panel-heading">
        <Title headingLevel="h2" size="md">
          {mode === 'cluster' ? 'Clusters' : 'Models'}
        </Title>
        <Label isCompact>{mode === 'cluster' ? visibleClusters.length : visibleModels.length}</Label>
      </div>
      {mode === 'cluster' && (
        <ToggleGroup aria-label="Filter cluster availability" isCompact>
          {availabilityFilters.map(([value, label]) => (
            <ToggleGroupItem
              key={value}
              text={label}
              buttonId={`availability-${value}`}
              isSelected={availability === value}
              onChange={() => setAvailability(value)}
            />
          ))}
        </ToggleGroup>
      )}
      <div className="fleet-cluster-list">
        {mode === 'cluster'
          ? visibleClusters.map((c) => (
              <article key={c.name} className="fleet-cluster-card">
                <Button
                  variant="link"
                  isInline
                  onClick={() => open({ kind: 'cluster', name: c.name })}
                  aria-label={`View ${c.name} details`}
                >
                  <CubesIcon /> {c.name}
                </Button>
                <Label isCompact color={statusColor(c)}>
                  {c.status === 'Ready' ? 'Available' : c.status === 'Offline' ? 'Unavailable' : 'Unknown'}
                </Label>
                <p>{c.siteName ?? c.site ?? 'Site unassigned'}</p>
                <Fields
                  items={[
                    ['Location', c.location ?? '—'],
                    ['Provisioning', c.provisioningStatus],
                  ]}
                />
                <h3 className="fleet-card-section-title">Models</h3>
                {modelLinks(c)}
              </article>
            ))
          : visibleModels.map((m) => (
              <article key={m.name} className="fleet-cluster-card">
                <Button
                  variant="link"
                  isInline
                  onClick={() => open({ kind: 'model', name: m.name })}
                  aria-label={`View ${displayName(m)} details`}
                >
                  {displayName(m)}
                </Button>
                <p>{m.modelName ?? m.modelRef.name}</p>
                <Label isCompact color="blue">
                  {m.phase}
                </Label>
                <h3 className="fleet-card-section-title">Sites</h3>
                {siteLinks(m)}
              </article>
            ))}
      </div>
      {!(mode === 'cluster' ? visibleClusters.length : visibleModels.length) && (
        <p>No {objects} match these filters.</p>
      )}
      <p className="fleet-details-note">
        {mode === 'cluster'
          ? `${clusters.filter((c) => c.latitude === undefined || c.longitude === undefined).length} clusters without coordinates remain available in this list.`
          : 'Site associations come from saved placement locations.'}
      </p>
    </>
  );

  const panel = (
    <DrawerPanelContent widths={{ default: 'width_33' }} className="fleet-drawer">
      <DrawerHead>{head}</DrawerHead>
      <DrawerPanelBody>
        {modelsError && (
          <Alert isInline variant="warning" title="Models unavailable">
            {modelsError}
          </Alert>
        )}
        {selectedCluster ? clusterDetails(selectedCluster) : selectedModel ? modelDetails(selectedModel) : list}
      </DrawerPanelBody>
    </DrawerPanelContent>
  );

  const summary: [label: string, value: string, sub: string][] = [
    ['Clusters', `${clusters.filter((c) => c.status === 'Ready').length}/${clusters.length}`, 'Available / enrolled'],
    ['Sites', String(new Set(clusters.flatMap((c) => (c.site ? [c.site] : []))).size), 'ACM site labels'],
    ['Models', String(relevantModels.length), 'Registered / saved'],
  ];

  return (
    <div className="ai-grid-future-vision">
      <div className="ai-grid-future-vision__fleet" aria-label="AI Grid map and drawer">
        <Drawer isExpanded isInline isStatic>
          <DrawerContent panelContent={panel}>
            <DrawerContentBody>
              <div className="fleet-map-area">
                <GridFleetMap
                  clusters={mapClusters}
                  selected={selectedCluster?.name ?? null}
                  onSelect={(name) => open({ kind: 'cluster', name })}
                  tiles={tiles}
                />
                <div className="vision-attention-strip">
                  {mapClusters
                    .filter((c) => c.status !== 'Ready')
                    .map((c) => (
                      <Label
                        key={c.name}
                        color={c.status === 'Offline' ? 'red' : 'grey'}
                        isCompact
                        onClick={() => open({ kind: 'cluster', name: c.name })}
                      >
                        {c.name}: {c.status === 'Offline' ? 'Unavailable' : 'Availability unknown'}
                      </Label>
                    ))}
                </div>
              </div>
              <div className="vision-summary-strip" aria-label="Fleet summary">
                <div className="vision-summary-strip__tiles">
                  {summary.map(([label, value, sub]) => (
                    <div className="vision-summary-tile" key={label}>
                      <div className="vision-summary-tile__label">{label}</div>
                      <div className="vision-summary-tile__value">{value}</div>
                      <div className="vision-summary-tile__sub">{sub}</div>
                    </div>
                  ))}
                </div>
              </div>
            </DrawerContentBody>
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  );
};
