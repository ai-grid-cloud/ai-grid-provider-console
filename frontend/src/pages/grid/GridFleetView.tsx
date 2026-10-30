// Layout adapted from the reference VisionModelFleetPage.
// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/grid/GridFleetView.tsx at 62319b8.
// The console makes each card one control (no links nested in it), drops the map's status chips
// (the legend and the cards already show status), moves the summary above the map, and lays the
// drawer details out as the other pages do.
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Drawer,
  DrawerContent,
  DrawerContentBody,
  DrawerHead,
  DrawerPanelBody,
  DrawerPanelContent,
  Flex,
  FlexItem,
  Grid,
  Label,
  SearchInput,
  Stack,
  Title,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';
import { AngleLeftIcon } from '@patternfly/react-icons';
import { Link, useSearchParams } from 'react-router-dom';
import { titleOf, type ModelView } from '../models/modelView';
import type { ClusterView } from '../clusters/clusterView';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { StatCard } from '../../components/StatCard';
import { StatusLabel } from '../../components/StatusLabel';
import { SubtleText } from '../../components/SubtleText';
import { NoResultsState } from '../../components/states/NoResultsState';
import { modelPath } from '../models/modelUtils';
import { EMPTY_VALUE } from '../../utilities/format';
import { LOCATION_DOCS_URL } from '../clusters/site';
import { GridFleetMap } from './GridFleetMap';
import type { TileLayerConfig } from './tiles';
import './grid-fleet.css';

/** What the map and its drawer show of a cluster (clusterView.ts). */
export type FleetCluster = Pick<
  ClusterView,
  'name' | 'status' | 'location' | 'site' | 'siteName' | 'region' | 'latitude' | 'longitude' | 'provisioningStatus'
> &
  Partial<Pick<ClusterView, 'locationSource' | 'locationProblem'>>;

/** A cluster by its name, or a model by its id. */
type Selection = { kind: 'cluster' | 'model'; name: string };

type Props = {
  clusters: FleetCluster[];
  models: ModelView[];
  modelsError?: string;
  tiles: TileLayerConfig | null | undefined;
};

// A model is on the clusters its placement chose, by name (status.placement.selected_clusters): its
// `locations` are `location` labels, which several clusters can share.
const matches = (model: ModelView, cluster: FleetCluster) => model.selectedClusters.includes(cluster.name);

/** Where a cluster is, for its card and drawer: "data center · region", either alone, or nothing. */
const whereOf = (cluster: FleetCluster) => [cluster.siteName, cluster.region].filter(Boolean).join(' · ');

const hasCoordinates = (c: FleetCluster) => c.latitude !== undefined && c.longitude !== undefined;

/** The availability filter: All, then each cluster status by the word the labels use. */
const availabilityFilters: FleetCluster['status'][] = ['Ready', 'Offline', 'Unknown'];

/** A link can open the drawer on a cluster (?cluster=<name>) or a model (?model=<id>, the model's id). */
const selectionFrom = (params: URLSearchParams): Selection | null => {
  const cluster = params.get('cluster');
  const model = params.get('model');
  return cluster ? { kind: 'cluster', name: cluster } : model ? { kind: 'model', name: model } : null;
};

/** A card in the drawer's list: one control that opens the item, with its status beside the name. */
const FleetCard: React.FC<{
  id: string;
  title: string;
  status: string;
  actionLabel: string;
  onOpen: () => void;
  children: React.ReactNode;
}> = ({ id, title, status, actionLabel, onOpen, children }) => (
  <Card isClickable isCompact id={`fleet-card-${id}`}>
    <CardHeader
      selectableActions={{
        onClickAction: onOpen,
        selectableActionId: `fleet-card-action-${id}`,
        selectableActionAriaLabel: actionLabel,
      }}
    >
      {/* In the title, not in actions: PatternFly's clickable-only cards may not carry actions. */}
      <CardTitle>
        <Flex
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          alignItems={{ default: 'alignItemsFlexStart' }}
          flexWrap={{ default: 'nowrap' }}
          spaceItems={{ default: 'spaceItemsSm' }}
        >
          <span className="pf-v6-u-text-break-word">{title}</span>
          <StatusLabel isCompact status={status} />
        </Flex>
      </CardTitle>
    </CardHeader>
    <CardBody>
      <Stack>{children}</Stack>
    </CardBody>
  </Card>
);

export const GridFleetView: React.FC<Props> = ({ clusters, models, modelsError, tiles }) => {
  const [params, setParams] = useSearchParams();
  // The URL is the drawer's state: a link or a reload opens the same thing, closing it clears the
  // URL, and navigating to plain /ai-grid (the nav link) closes it.
  const selection = selectionFrom(params);
  const setSelection = (next: Selection | null) => {
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        updated.delete('cluster');
        updated.delete('model');
        if (next) updated.set(next.kind, next.name);
        return updated;
      },
      { replace: true },
    );
  };
  // The Back trail belongs to the selection it was built for. When the URL moves the drawer some
  // other way (browser back, a link, the nav), the trail no longer applies and reads as empty.
  const [trail, setTrail] = useState<{ at: string | null; items: Selection[] }>({ at: null, items: [] });
  const keyOf = (s: Selection | null) => (s ? `${s.kind}:${s.name}` : null);
  const history = trail.at === keyOf(selection) ? trail.items : [];
  const [mode, setMode] = useState<'cluster' | 'model'>(() => selectionFrom(params)?.kind ?? 'cluster');
  const [search, setSearch] = useState('');
  const [availability, setAvailability] = useState('all');

  const selectedCluster = selection?.kind === 'cluster' ? clusters.find((c) => c.name === selection.name) : undefined;
  const selectedModel = selection?.kind === 'model' ? models.find((m) => m.id === selection.name) : undefined;
  const relevantModels = models.filter((m) => m.selectedClusters.length === 0 || clusters.some((c) => matches(m, c)));
  const modelsAt = (cluster: FleetCluster) => models.filter((m) => matches(m, cluster));
  const clustersOf = (model: ModelView) => clusters.filter((c) => matches(model, c));
  const query = search.toLowerCase();
  const visibleClusters = clusters.filter(
    (c) =>
      (availability === 'all' || c.status === availability) &&
      `${c.name} ${whereOf(c)} ${modelsAt(c).map(titleOf).join(' ')}`.toLowerCase().includes(query),
  );
  const visibleModels = relevantModels.filter((m) =>
    `${m.id} ${titleOf(m)} ${m.modelName ?? ''} ${clustersOf(m)
      .map((c) => c.name)
      .join(' ')}`
      .toLowerCase()
      .includes(query),
  );
  const isFiltered = search !== '' || (mode === 'cluster' && availability !== 'all');
  const clearFilters = () => {
    setSearch('');
    setAvailability('all');
  };

  const open = (next: Selection) => {
    setTrail({ at: keyOf(next), items: selection ? [...history, selection] : [] });
    setSelection(next);
  };
  const reset = () => {
    setSelection(null);
    setTrail({ at: null, items: [] });
  };
  const back = () => {
    const previous = history.at(-1) ?? null;
    setTrail({ at: keyOf(previous), items: history.slice(0, -1) });
    setSelection(previous);
  };

  const mapClusters = selectedModel
    ? clustersOf(selectedModel)
    : mode === 'cluster'
      ? visibleClusters
      : clusters.filter((c) => visibleModels.some((m) => matches(m, c)));

  const clusterLinks = (model: ModelView) => {
    const targets = clustersOf(model);
    return targets.length ? (
      <Flex
        direction={{ default: 'column' }}
        flexWrap={{ default: 'nowrap' }}
        alignItems={{ default: 'alignItemsFlexStart' }}
        spaceItems={{ default: 'spaceItemsSm' }}
      >
        {targets.map((c) => (
          <Button key={c.name} variant="link" isInline onClick={() => open({ kind: 'cluster', name: c.name })}>
            {c.name}
          </Button>
        ))}
      </Flex>
    ) : (
      <SubtleText>
        {model.selectedClusters.length ? 'None of its clusters is in AI Grid.' : 'No clusters yet.'}
      </SubtleText>
    );
  };

  const modelLinks = (cluster: FleetCluster) => {
    const assigned = modelsAt(cluster);
    return assigned.length ? (
      <Flex
        direction={{ default: 'column' }}
        flexWrap={{ default: 'nowrap' }}
        alignItems={{ default: 'alignItemsFlexStart' }}
        spaceItems={{ default: 'spaceItemsSm' }}
      >
        {assigned.map((m) => (
          <Button key={m.id} variant="link" isInline onClick={() => open({ kind: 'model', name: m.id })}>
            {titleOf(m)}
          </Button>
        ))}
      </Flex>
    ) : (
      <SubtleText>{modelsError ? 'Model assignments unavailable.' : 'No models on this cluster.'}</SubtleText>
    );
  };

  const objects = mode === 'cluster' ? 'clusters' : 'models';

  // The same header for a cluster and a model: back, the name with its status, and what it is.
  const head =
    selection && (selectedCluster || selectedModel) ? (
      <Stack hasGutter>
        <div>
          <Button variant="link" isInline icon={<AngleLeftIcon />} onClick={back}>
            {history.length ? 'Back' : mode === 'cluster' ? 'Clusters' : 'Models'}
          </Button>
        </div>
        <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
          <Title headingLevel="h2" size="lg" className="pf-v6-u-text-break-word">
            {selectedCluster?.name ?? (selectedModel && titleOf(selectedModel))}
          </Title>
          <StatusLabel isCompact status={selectedCluster?.status ?? selectedModel?.phase ?? 'Unknown'} />
        </Flex>
        {(selectedModel || (selectedCluster && whereOf(selectedCluster))) && (
          <SubtleText>
            {selectedCluster ? whereOf(selectedCluster) : (selectedModel?.modelName ?? selectedModel?.id)}
          </SubtleText>
        )}
      </Stack>
    ) : (
      <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
        <FlexItem grow={{ default: 'grow' }}>
          <SearchInput
            aria-label={`Filter grid ${objects}`}
            placeholder="Filter by name"
            value={search}
            onChange={(_, value) => setSearch(value)}
            onClear={() => setSearch('')}
          />
        </FlexItem>
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
      </Flex>
    );

  const clusterDetails = (cluster: FleetCluster) => (
    <Stack hasGutter>
      <DetailsSection title="Cluster" headingLevel="h3">
        <DetailsList
          aria-label="Cluster"
          items={[
            { term: 'Data center', value: cluster.siteName },
            { term: 'Region', value: cluster.region },
            { term: 'Location label', value: cluster.location },
            {
              term: 'Coordinates',
              value: hasCoordinates(cluster) ? (
                <>
                  {cluster.latitude}, {cluster.longitude}
                  {cluster.locationSource === 'cloud region' && (
                    <>
                      {' '}
                      <SubtleText>from the cloud region</SubtleText>
                    </>
                  )}
                </>
              ) : undefined,
            },
            { term: 'Position problem', value: cluster.locationProblem },
            { term: 'Provisioning', value: <StatusLabel isCompact status={cluster.provisioningStatus} /> },
          ]}
        />
      </DetailsSection>
      <DetailsSection
        title="Models on this cluster"
        headingLevel="h3"
        count={modelsAt(cluster).length}
        help="The models whose placement chose this cluster. A model listed here may still be starting."
      >
        {modelLinks(cluster)}
      </DetailsSection>
      <Link to="/clusters">View in Clusters</Link>
    </Stack>
  );

  const modelDetails = (model: ModelView) => (
    <Stack hasGutter>
      <DetailsSection title="Model configuration" headingLevel="h3">
        <DetailsList
          aria-label="Model configuration"
          items={[
            { term: 'Resource name', value: model.id },
            { term: 'Model', value: model.modelName },
            { term: 'Replicas', value: model.replicas },
            { term: 'Model URI', value: model.modelUri },
            { term: 'Runtime image', value: model.runtimeImage },
          ]}
        />
      </DetailsSection>
      <DetailsSection
        title="Clusters"
        headingLevel="h3"
        count={clustersOf(model).length}
        help="The AI Grid clusters this model's placement chose. They are where it should run, not proof that it is serving there."
      >
        {clusterLinks(model)}
      </DetailsSection>
      <Link to={modelPath(model)}>View model</Link>
    </Stack>
  );

  const noResults = <NoResultsState body={`Change the filter to see more ${objects}.`} onClear={clearFilters} />;

  // Not on the map: no position (no annotations, no known cloud region), or annotations to fix.
  const notOnMap = clusters.filter((c) => !hasCoordinates(c));
  const withProblem = notOnMap.filter((c) => c.locationProblem).length;
  const withoutPosition = notOnMap.length - withProblem;

  const list = (
    <Stack hasGutter>
      <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
        <Title headingLevel="h2" size="md">
          {mode === 'cluster' ? 'Clusters' : 'Models'}
        </Title>
        <Label isCompact>{mode === 'cluster' ? visibleClusters.length : visibleModels.length}</Label>
      </Flex>
      {mode === 'cluster' && (
        <ToggleGroup aria-label="Filter cluster availability" isCompact>
          {['all', ...availabilityFilters].map((value) => (
            <ToggleGroupItem
              key={value}
              text={value === 'all' ? 'All' : value}
              buttonId={`availability-${value}`}
              isSelected={availability === value}
              onChange={() => setAvailability(value)}
            />
          ))}
        </ToggleGroup>
      )}
      {(mode === 'cluster' ? visibleClusters.length : visibleModels.length) === 0 && noResults}
      <Stack hasGutter>
        {mode === 'cluster'
          ? visibleClusters.map((c) => {
              const at = modelsAt(c);
              return (
                <FleetCard
                  key={c.name}
                  id={c.name}
                  title={c.name}
                  status={c.status}
                  actionLabel={`View ${c.name} details`}
                  onOpen={() => open({ kind: 'cluster', name: c.name })}
                >
                  {whereOf(c) && <span>{whereOf(c)}</span>}
                  <SubtleText>{at.length ? `Models: ${at.map(titleOf).join(', ')}` : 'No models'}</SubtleText>
                </FleetCard>
              );
            })
          : visibleModels.map((m) => {
              const names = clustersOf(m).map((c) => c.name);
              return (
                <FleetCard
                  key={m.id}
                  id={m.id.replace(/\W/g, '-')}
                  title={titleOf(m)}
                  status={m.phase}
                  actionLabel={`View ${titleOf(m)} details`}
                  onOpen={() => open({ kind: 'model', name: m.id })}
                >
                  <span>{m.modelName ?? m.id}</span>
                  <SubtleText>{names.length ? `Clusters: ${names.join(', ')}` : 'No clusters'}</SubtleText>
                </FleetCard>
              );
            })}
      </Stack>
      {mode === 'cluster' && notOnMap.length > 0 && (
        <SubtleText>
          {notOnMap.length} {notOnMap.length === 1 ? "cluster isn't" : "clusters aren't"} on the map:{' '}
          {[
            withoutPosition && `${withoutPosition} without a position`,
            withProblem && `${withProblem} with coordinate annotations to fix`,
          ]
            .filter(Boolean)
            .join(', ')}
          .{' '}
          <a href={LOCATION_DOCS_URL} target="_blank" rel="noreferrer">
            How to set a cluster&apos;s position
          </a>
        </SubtleText>
      )}
    </Stack>
  );

  const panel = (
    <DrawerPanelContent widths={{ default: 'width_33' }} className="fleet-drawer">
      <DrawerHead>{head}</DrawerHead>
      <DrawerPanelBody>
        <Stack hasGutter>
          {modelsError && (
            <Alert isInline variant="warning" title="Unable to load models">
              {modelsError}
            </Alert>
          )}
          {selectedCluster ? clusterDetails(selectedCluster) : selectedModel ? modelDetails(selectedModel) : list}
        </Stack>
      </DrawerPanelBody>
    </DrawerPanelContent>
  );

  const ready = clusters.filter((c) => c.status === 'Ready').length;
  const summary: [label: string, value: string, detail?: string][] = [
    ['Clusters', `${ready}/${clusters.length}`, 'Ready'],
    // The clusters are the AI Grid members (each is one grid site), so the second count is the
    // distinct cloud regions they run in.
    // With no region reported (on-premises clusters have no cloud region claim), a dash, not 0.
    ['Regions', String(new Set(clusters.flatMap((c) => (c.region ? [c.region] : []))).size || EMPTY_VALUE)],
    ['Models', String(relevantModels.length)],
  ];

  return (
    <Stack hasGutter>
      <Grid hasGutter md={4} role="region" aria-label="Fleet summary">
        {summary.map(([label, value, detail]) => (
          <StatCard key={label} label={label} value={value} detail={detail} />
        ))}
      </Grid>
      <Card className="fleet-region" role="region" aria-label="AI Grid map and drawer">
        <Drawer isExpanded isInline isStatic>
          <DrawerContent panelContent={panel}>
            <DrawerContentBody>
              <div className="fleet-map-area">
                <GridFleetMap
                  clusters={mapClusters}
                  selected={selectedCluster?.name ?? null}
                  onSelect={(name) => open({ kind: 'cluster', name })}
                  tiles={tiles}
                  isFiltered={isFiltered && !selectedModel}
                />
              </div>
            </DrawerContentBody>
          </DrawerContent>
        </Drawer>
      </Card>
    </Stack>
  );
};
