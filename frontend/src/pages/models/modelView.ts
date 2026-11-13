// What the Models pages and the AI grid map show of a Model from the backend's Models
// API (ai_grid.v1, read over Connect): a thin selector layer over the generated message (ADR-0002),
// as clusterView.ts is for clusters. Each field reads one documented field or key and words it; the
// backend decides the phase, the clusters the placement chose, and each placed cluster's status
// (ModelStatus in the backend's proto/ai_grid/v1/model_type.proto).
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  ModelDeploymentState,
  ModelMaasState,
  ModelPhase,
  ModelState,
  ModelSyncState,
  ModelViewTarget,
  type Model,
  type ModelEnvVar,
  type ModelSpec,
} from '../../gen/ai_grid/v1/model_type_pb';

/** The annotations the backend documents for a model's display name and description. */
export const DISPLAY_NAME = 'openshift.io/display-name';
export const DESCRIPTION = 'openshift.io/description';

/** The display name an object's annotations give it, if they give one (a model's, a subscription's). */
export const displayNameAnnotation = (annotations: { [key: string]: string } | undefined): string | undefined =>
  annotations?.[DISPLAY_NAME] || undefined;

/** The name a page shows for a backend object: its display name annotation, else its id. */
export const displayNameOf = (object: { id: string; metadata?: { annotations: { [key: string]: string } } }) =>
  displayNameAnnotation(object.metadata?.annotations) ?? object.id;

/** The main container's request keys the console reads and writes. */
const REQUEST_CPU = 'cpu';
const REQUEST_MEMORY = 'memory';

/** An accelerator a model requests: an extended resource, such as nvidia.com/gpu, and how many. */
export type AcceleratorRequest = { resource: string; count: string };

/** The reason the backend gives a model it saved to Git that no cluster has reported yet. */
const SAVED_TO_GIT = 'SavedToGit';

/** A model's phase as the pages word it. */
export type ModelPhaseWord = 'Ready' | 'Pending' | 'Failed' | 'Partially ready' | 'Saved to Git' | 'Unknown';

/**
 * A model's rollout, Git sync and deployment in one word, as the Status column shows it
 * (the backend's ModelState): Saved to Git, Syncing, Synced, Starting, Ready,
 * Partially ready (a model only), Failed, Stopped; Unknown for a value newer than the pin.
 */
export type StateWord =
  'Saved to Git' | 'Syncing' | 'Synced' | 'Starting' | 'Ready' | 'Partially ready' | 'Failed' | 'Stopped' | 'Unknown';

/**
 * Whether Argo CD has applied Git's change on a cluster (ModelSyncState): Synced, Out of sync (not
 * applied yet, or being retried) or Sync failed; none while the cluster has no Application.
 */
export type SyncWord = 'Synced' | 'Out of sync' | 'Sync failed' | 'Unknown';

/** A model in MaaS as the Availability column words it (ModelMaasState); none while unreported. */
export type MaaSWord =
  | 'Available'
  | 'Awaiting subscription'
  | 'Configuring route'
  | 'Awaiting subscription and backend'
  | 'Unavailable'
  | 'Failed'
  | 'Unknown';

/** The model on one cluster its placement names, as the backend reports it (`status.clusters`). */
export type ModelClusterView = {
  cluster: string;
  /**
   * Ready, Failed or Pending: every report from the cluster ready, one failed, or one not ready or
   * missing. On a combined cluster its MaaSModelRef and ExternalModel reports count too.
   */
  phase: ModelPhaseWord;
  /** Ready, Failed, NotReady, Stopped or NoReport. */
  reason: string;
  /** What the cluster reported, for example "LLMInferenceService not ready". */
  message?: string;
  /**
   * What the cluster's LLMInferenceService reports (`deployment`), whatever MaaS reports on a
   * combined cluster and Argo CD's sync: Running (Ready), Starting, Stopped, Failed, or Unknown
   * while it isn't on the cluster.
   */
  deployment: ModelDeploymentWord;
  /** KServe's message about the deployment, for example "Deployment does not have minimum availability.". */
  deploymentMessage?: string;
  /** Whether Argo CD has applied the model on the cluster as Git has it; undefined with no report. */
  sync?: SyncWord;
  /**
   * Whether Argo CD's sync of the model to the cluster failed and it stopped retrying (`sync`
   * FAILED): the revision Git holds never lands there, an admission refusal or a bad manifest.
   */
  syncFailed?: boolean;
  /** Argo CD's sync operation message while the sync failed or is being retried (`sync_message`). */
  syncMessage?: string;
  /** Git sync and deployment in one word (ModelClusterStatus.state); undefined with no report. */
  state?: StateWord;
  /** Where to see the model on this cluster (view_url); undefined when the hub can't link it. */
  viewUrl?: string;
  /** Whether viewUrl opens OpenShift AI or the OpenShift console. */
  viewTarget?: 'OpenShift AI' | 'OpenShift console';
};

/** What a placed cluster's LLMInferenceService reports, in words (ModelDeploymentState). */
export type ModelDeploymentWord = 'Running' | 'Starting' | 'Stopped' | 'Failed' | 'Unknown';

const deploymentWords: Record<ModelDeploymentState, ModelDeploymentWord> = {
  [ModelDeploymentState.UNSPECIFIED]: 'Unknown',
  [ModelDeploymentState.STARTING]: 'Starting',
  [ModelDeploymentState.RUNNING]: 'Running',
  [ModelDeploymentState.FAILED]: 'Failed',
  [ModelDeploymentState.STOPPED]: 'Stopped',
};

/** The model in MaaS on one ingress cluster, as the backend reports it (`status.ingress`). */
export type ModelIngressView = {
  cluster: string;
  /** Undefined while the cluster hasn't reported the model. */
  maas?: MaaSWord;
  /** Whether MaaS or Argo CD reports the model failed there. */
  failed: boolean;
  /** MaaS's or Argo CD's message, for example "Awaiting governance pairing". */
  message?: string;
};

/** A Model as the pages show it. */
export type ModelView = {
  /** The model's id, which is also its metadata.name and the page's URL. */
  id: string;
  displayName?: string;
  description?: string;
  /** The name clients send in the request's model field (spec.model.name). */
  modelName?: string;
  modelUri?: string;
  runtimeImage?: string;
  /**
   * The LLMInferenceServiceConfig presets (spec.base_refs) the model is built on; empty for KServe's
   * default. The console deploys none: preset names carry the OpenShift AI version.
   */
  baseRefs: string[];
  replicas?: number;
  /** KEDA scales the model (spec.scaling), so it has no fixed replica count. */
  autoscaled: boolean;
  cpu?: string;
  memory?: string;
  /** The main container's requests for extended resources (a name with a domain), by name. */
  acceleratorRequests: AcceleratorRequest[];
  /** The main container's requests as read, every resource, sent back whole by an edit that changes one. */
  requests: Record<string, string>;
  env: ModelEnvVar[];
  /** The annotations as read, sent back whole by an edit. */
  annotations: Record<string, string>;
  phase: ModelPhaseWord;
  reason?: string;
  statusMessage?: string;
  /** status.url: the external URL, when the backend knows it. */
  url?: string;
  creationTimestamp?: string;
  /** metadata.version, sent back with `lock` by an edit and with a delete. */
  version: number;
  /** The clusters the placement chose, by name (status.placement.selected_clusters). */
  selectedClusters: string[];
  /** Each placed cluster's status; empty while no cluster has reported the model. */
  clusters: ModelClusterView[];
  /** The model in MaaS over the ingress clusters (status.maas); undefined while none has reported. */
  maas?: MaaSWord;
  /**
   * Whether the model failed in MaaS (`status.maas` FAILED): MaaS or the AI gateway reports it
   * failed on an ingress cluster, or Argo CD couldn't sync it there.
   */
  maasFailed: boolean;
  /**
   * Why the backend reads the model as Unavailable in MaaS (status.maas_message): no placed cluster
   * runs it, or its deployment serves a name other than its id. Undefined for every other word.
   */
  maasMessage?: string;
  /** The rollout in one word (status.state): what the Status column shows. */
  state: StateWord;
  /** Each ingress cluster's MaaS status; empty while no cluster has reported the model. */
  ingress: ModelIngressView[];
  /**
   * The clusters a `name In [...]` placement names, the only shape the console edits; undefined
   * for a model without a placement or with any other one.
   */
  placementClusters?: string[];
  /** Whether the model has a placement at all. */
  placed: boolean;
};

const phaseWords: Record<ModelPhase, ModelPhaseWord> = {
  [ModelPhase.UNSPECIFIED]: 'Unknown',
  [ModelPhase.PENDING]: 'Pending',
  [ModelPhase.READY]: 'Ready',
  [ModelPhase.FAILED]: 'Failed',
  [ModelPhase.PARTIALLY_AVAILABLE]: 'Partially ready',
};

const syncWords: Partial<Record<ModelSyncState, SyncWord>> = {
  [ModelSyncState.SYNCED]: 'Synced',
  [ModelSyncState.OUT_OF_SYNC]: 'Out of sync',
  [ModelSyncState.FAILED]: 'Sync failed',
};

const maasWords: Partial<Record<ModelMaasState, MaaSWord>> = {
  [ModelMaasState.AVAILABLE]: 'Available',
  [ModelMaasState.AWAITING_SUBSCRIPTION]: 'Awaiting subscription',
  [ModelMaasState.CONFIGURING_ROUTING]: 'Configuring route',
  [ModelMaasState.AWAITING_SUBSCRIPTION_AND_BACKEND]: 'Awaiting subscription and backend',
  [ModelMaasState.UNAVAILABLE]: 'Unavailable',
  [ModelMaasState.FAILED]: 'Failed',
};

const stateWords: Partial<Record<ModelState, StateWord>> = {
  [ModelState.SAVED_TO_GIT]: 'Saved to Git',
  [ModelState.SYNCING]: 'Syncing',
  [ModelState.SYNCED]: 'Synced',
  [ModelState.STARTING]: 'Starting',
  [ModelState.READY]: 'Ready',
  [ModelState.PARTIALLY_READY]: 'Partially ready',
  [ModelState.FAILED]: 'Failed',
  [ModelState.STOPPED]: 'Stopped',
};

/** The rollout in words: undefined when unreported (0), Unknown for a value newer than the pin. */
export const stateWordOf = (state: ModelState | undefined): StateWord | undefined =>
  state ? (stateWords[state] ?? 'Unknown') : undefined;

const viewTargets: Partial<Record<ModelViewTarget, 'OpenShift AI' | 'OpenShift console'>> = {
  [ModelViewTarget.OPENSHIFT_AI]: 'OpenShift AI',
  [ModelViewTarget.OPENSHIFT_CONSOLE]: 'OpenShift console',
};

/** The sync in words: undefined when unreported (0), Unknown for a value newer than the pin. */
export const syncWordOf = (state: ModelSyncState | undefined): SyncWord | undefined =>
  state ? (syncWords[state] ?? 'Unknown') : undefined;

/** The MaaS status in words: undefined when unreported (0), Unknown for a value newer than the pin. */
export const maasWordOf = (state: ModelMaasState | undefined): MaaSWord | undefined =>
  state ? (maasWords[state] ?? 'Unknown') : undefined;

/**
 * The phase in words. The backend leaves the phase unspecified with reason SavedToGit while no
 * cluster has reported the model; any other unspecified phase, or a value newer than the pin, is
 * Unknown.
 */
export const phaseWordOf = (phase: ModelPhase | undefined, reason?: string): ModelPhaseWord =>
  phase === ModelPhase.UNSPECIFIED && reason === SAVED_TO_GIT
    ? 'Saved to Git'
    : (phaseWords[phase ?? ModelPhase.UNSPECIFIED] ?? 'Unknown');

/**
 * The clusters of a placement that names clusters by `name In [...]` and nothing else, the shape
 * the backend's git mode takes (ModelSpec.placement); undefined for any other shape.
 */
export const placementClustersOf = (spec: ModelSpec | undefined): string[] | undefined => {
  const placement = spec?.placement;
  if (!placement) return undefined;
  const selector = placement.labelSelector;
  const expressions = selector?.matchExpressions ?? [];
  const [expression, ...others] = expressions;
  if (
    placement.clusterSets.length > 0 ||
    placement.numberOfClusters !== undefined ||
    Object.keys(selector?.matchLabels ?? {}).length > 0 ||
    others.length > 0 ||
    expression?.key !== 'name' ||
    expression.operator !== 'In'
  ) {
    return undefined;
  }
  return [...expression.values];
};

const nonEmpty = (value: string | undefined) => (value ? value : undefined);

export const toModelView = (model: Model): ModelView => {
  const annotations = model.metadata?.annotations ?? {};
  const spec = model.spec;
  const requests = spec?.main?.requests ?? {};
  const status = model.status;
  const created = model.metadata?.creationTimestamp;
  return {
    id: model.id,
    displayName: displayNameAnnotation(annotations),
    description: nonEmpty(annotations[DESCRIPTION]),
    modelName: nonEmpty(spec?.model?.name),
    modelUri: nonEmpty(spec?.model?.uri),
    runtimeImage: nonEmpty(spec?.main?.image),
    baseRefs: [...(spec?.baseRefs ?? [])],
    replicas: spec?.replicas,
    autoscaled: spec?.scaling !== undefined,
    cpu: nonEmpty(requests[REQUEST_CPU]),
    memory: nonEmpty(requests[REQUEST_MEMORY]),
    acceleratorRequests: Object.entries(requests)
      .filter(([resource]) => resource.includes('/'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([resource, count]) => ({ resource, count })),
    requests: { ...requests },
    env: [...(spec?.main?.env ?? [])],
    annotations: { ...annotations },
    phase: phaseWordOf(status?.phase, status?.reason),
    reason: nonEmpty(status?.reason),
    statusMessage: nonEmpty(status?.message),
    url: nonEmpty(status?.url),
    creationTimestamp: created ? timestampDate(created).toISOString() : undefined,
    version: model.metadata?.version ?? 0,
    selectedClusters: [...(status?.placement?.selectedClusters ?? [])],
    clusters: (status?.clusters ?? []).map((c) => ({
      cluster: c.cluster,
      phase: phaseWordOf(c.phase, c.reason),
      reason: c.reason,
      message: nonEmpty(c.message),
      deployment: deploymentWords[c.deployment] ?? 'Unknown',
      deploymentMessage: nonEmpty(c.deploymentMessage),
      sync: syncWordOf(c.sync),
      syncFailed: c.sync === ModelSyncState.FAILED,
      syncMessage: nonEmpty(c.syncMessage),
      state: stateWordOf(c.state),
      viewUrl: nonEmpty(c.viewUrl),
      viewTarget: viewTargets[c.viewTarget],
    })),
    maas: maasWordOf(status?.maas),
    maasFailed: status?.maas === ModelMaasState.FAILED,
    maasMessage: nonEmpty(status?.maasMessage),
    // A backend that doesn't report a state yet leaves only the phase: Saved to Git while it says so.
    state:
      stateWordOf(status?.state) ??
      (phaseWordOf(status?.phase, status?.reason) === 'Saved to Git' ? 'Saved to Git' : 'Unknown'),
    ingress: (status?.ingress ?? []).map((i) => ({
      cluster: i.cluster,
      maas: maasWordOf(i.state),
      failed: i.state === ModelMaasState.FAILED,
      message: nonEmpty(i.message),
    })),
    placementClusters: placementClustersOf(spec),
    placed: spec?.placement !== undefined,
  };
};

/**
 * The name a model still serves instead of its id, for one saved before the backend served every
 * model as its id; undefined for any other model. The backend reports the name a model serves
 * (spec.model.name) and switches it to the id on the model's next update.
 */
export const olderServedNameOf = (model: Pick<ModelView, 'id' | 'modelName'>): string | undefined =>
  model.modelName && model.modelName !== model.id ? model.modelName : undefined;

/** The name a page shows for the model: its display name, else its id. */
export const titleOf = (model: Pick<ModelView, 'id' | 'displayName'>) => model.displayName ?? model.id;

/** Phases a model or one of its clusters leaves on its own, so the pages poll sooner while one shows. */
const unsettledPhases: ReadonlySet<ModelPhaseWord> = new Set(['Pending', 'Saved to Git', 'Unknown']);

/** A placed cluster's states that leave on their own (ModelClusterStatus.state). */
const changingStates: ReadonlySet<StateWord> = new Set(['Syncing', 'Synced', 'Starting']);

/**
 * Whether a placed cluster's report is still changing: Syncing, Synced or Starting. Ready, Failed and
 * Stopped stay so until someone acts, and a cluster drifting from Git while it serves reads Ready. An
 * entry without a state, from a backend that doesn't report it, goes by its phase.
 */
const clusterUnsettled = (c: ModelClusterView): boolean =>
  c.state ? changingStates.has(c.state) : unsettledPhases.has(c.phase);

/** MaaS states that leave on their own once a cluster serves the model. */
const maasChanging: ReadonlySet<MaaSWord> = new Set(['Configuring route', 'Awaiting subscription and backend']);

/**
 * Whether anything the model's pages show is still changing, so they poll sooner: the model is
 * Saved to Git, or Unknown, or Pending with no cluster entry; a placed cluster is (clusterUnsettled);
 * or MaaS is still routing the model, or hasn't reported it, while a cluster serves it (MaaS never
 * routes a model stopped or failed everywhere). A model without a placement goes to no cluster, so
 * nothing changes until it is edited.
 */
export const isUnsettled = (model: Pick<ModelView, 'phase' | 'state' | 'clusters' | 'placed' | 'ingress'>): boolean =>
  model.placed &&
  (model.state === 'Saved to Git' ||
    model.phase === 'Saved to Git' ||
    model.phase === 'Unknown' ||
    (model.clusters.length === 0 && model.phase === 'Pending') ||
    model.clusters.some(clusterUnsettled) ||
    (model.ingress.some((i) => !i.maas || maasChanging.has(i.maas)) &&
      model.clusters.some((c) => c.deployment === 'Running')));

/**
 * What the model's pages show of a model still changing (isUnsettled), in its status words: its id,
 * state and phase, each placed cluster's state, phase, sync and deployment, and each ingress
 * cluster's MaaS word. No messages, which can change while nothing moves. A model that stays on the
 * same words is stuck, and the pages stop polling it fast (useLoadOptions); undefined when settled.
 */
export const changingOf = (
  model: Pick<ModelView, 'id' | 'phase' | 'state' | 'clusters' | 'placed' | 'ingress'>,
): string | undefined =>
  isUnsettled(model)
    ? [
        model.id,
        model.state,
        model.phase,
        ...model.clusters.map((c) => `${c.cluster}=${c.state ?? ''}/${c.phase}/${c.sync ?? ''}/${c.deployment}`),
        ...model.ingress.map((i) => `${i.cluster}=${i.maas ?? ''}`),
      ].join(' ')
    : undefined;
