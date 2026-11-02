import type { ModelView } from './modelView';

/**
 * What KServe's terminal Ready=False reasons (ConfigNotFound, RefsInvalid, GatewaysNotReady) mean to
 * an administrator, and what to do next. The backend reports them as the model's reason when it reads
 * a live LLMInferenceService (model_mapper.go); in git mode the reasons are its own.
 */
export const failureExplanations: Record<string, { summary: string; next: string }> = {
  ConfigNotFound: {
    summary: 'A runtime template this model needs isn’t installed on the hub.',
    next: 'Install the template on the hub, or deploy the model with another runtime.',
  },
  RefsInvalid: {
    summary: 'The model refers to a resource that doesn’t exist or isn’t valid.',
    next: 'Check the model URI and the runtime, then deploy the model again.',
  },
  GatewaysNotReady: {
    summary: 'The gateway that serves this model isn’t ready.',
    next: 'Check the AI Grid gateway on the hub.',
  },
};

export const modelPhase = (model: Pick<ModelView, 'phase'>): string => model.phase;

/** Open Data Hub shows a cluster's Pending, Loading, and Standby as Starting. */
export const clusterDeploymentStatus = (phase: string): string => (phase === 'Pending' ? 'Starting' : phase);

/**
 * The model row's status. Pending becomes Starting when every cluster row is Starting, so the
 * model and its clusters don't use two words for that same moment. Synced stays Synced: it is the
 * brief git label while those clusters are already Starting.
 */
export const listStatusOf = (model: Pick<ModelView, 'phase' | 'clusters'>): string => {
  if (
    model.phase === 'Pending' &&
    model.clusters.length > 0 &&
    model.clusters.every((cluster) => clusterDeploymentStatus(cluster.phase) === 'Starting')
  ) {
    return 'Starting';
  }
  return model.phase;
};

/**
 * Git labels and their dialog sentences. Synced keeps its sentence here. The label does not open;
 * Saved to Git and Syncing do.
 */
export const gitStatusMessage: Record<string, string> = {
  'Saved to Git':
    'The model configuration has been saved to Git and is waiting for Argo CD to synchronize. Deployment to the target cluster will begin automatically once synced.',
  Syncing:
    'Argo CD is currently synchronizing the model configuration from Git to the target cluster. Cluster deployment will begin shortly.',
  Synced:
    'Argo CD has successfully synchronized configuration manifests to all target clusters. The cluster is now spinning up the model deployment.',
};

/** A model-row status opens when the dialog adds the git message or the cluster table. */
export const statusOpens = (status: string): boolean =>
  status === 'Partially ready' || status === 'Saved to Git' || status === 'Syncing';

/**
 * Saved to Git and Syncing have no deployment to open yet. The model name stays text until a
 * cluster reports one. Every later status, including Synced, has a model page.
 */
export const deploymentPageAvailable = (status: string): boolean => status !== 'Saved to Git' && status !== 'Syncing';

/** A placed model serving on some of its clusters but not all (the backend's phase, proposal P13). */
export const PARTIALLY_AVAILABLE = 'Partially ready';

/** The status's title: "Deployment failed" for Failed, else the phase. */
export const modelStatusTitle = (model: ModelView): string =>
  modelPhase(model) === 'Failed' ? 'Deployment failed' : modelPhase(model);

/** Whether the model has anything to explain beyond its phase. */
export const hasModelStatusDetails = (model: ModelView): boolean => !!(model.reason || model.statusMessage);

/** The healthy MaaS model ref. The content review calls this Ready; this column says Available. */
export const MAAS_AVAILABLE = 'Available';

/**
 * One MaaS model ref status, as the Availability column shows it. Copy for Ready, Unavailable,
 * Failed (gateway), and the one Pending (awaiting subscription) is the MaaS governance content
 * review. The other Pending controller messages, and an unsupported model kind, use the
 * error-mapping sentences until that review words them. Invalid is left out until that set, and
 * a display that fits the status guidelines, are confirmed.
 */
export type AvailabilityView = {
  /** Available, Pending, Unavailable, or Failed. */
  label: string;
  /** The short reason under the label. Available has none. */
  subtext?: string;
  /** The dialog's section title. Present when the label opens. */
  heading?: string;
  body?: string;
  /** The model needs a subscription, so the dialog links to Subscriptions. */
  subscriptionsLink?: boolean;
  /** The inference service still has to be healthy, so the dialog links to this model's page. */
  modelsLink?: boolean;
};

const AVAILABILITY_PENDING_GOVERNANCE: AvailabilityView = {
  label: 'Pending',
  subtext: 'Awaiting subscription',
  heading: 'Pending MaaS governance',
  body: 'Consumers can’t access this model yet. To enable access, set up a subscription.',
  subscriptionsLink: true,
};

/** Most specific controller phrase first. "Awaiting governance pairing" is a prefix of the longer one. */
const availabilityReports: { phrase: string; view: AvailabilityView }[] = [
  {
    phrase: 'Awaiting governance pairing and backend readiness',
    view: {
      label: 'Pending',
      subtext: 'Awaiting subscription and backend',
      heading: 'Awaiting subscription and backend',
      body: 'Consumers can’t access this model yet. To enable access, set up a subscription. Availability also depends on a healthy inference service. Check the deployment status on the Models page.',
      subscriptionsLink: true,
      modelsLink: true,
    },
  },
  { phrase: 'Awaiting governance pairing', view: AVAILABILITY_PENDING_GOVERNANCE },
  { phrase: 'no MaaSModelRef', view: AVAILABILITY_PENDING_GOVERNANCE },
  {
    phrase: 'Waiting for HTTPRoute to be created',
    view: {
      label: 'Pending',
      subtext: 'Configuring routing',
      heading: 'Configuring routing',
      body: 'The model’s HTTPRoute is being created.',
    },
  },
  {
    phrase: 'Governed but backend is not ready',
    view: {
      label: 'Unavailable',
      subtext: 'Endpoint not serving',
      heading: 'Model unavailable',
      body: 'The inference service is not serving requests. The model server might be starting, crashing, or lacking resources.',
    },
  },
  {
    phrase: 'Gateway not found',
    view: {
      label: 'Failed',
      subtext: 'Gateway not found',
      heading: 'Model setup failed',
      body: 'The model could not be configured.',
    },
  },
  {
    phrase: 'Failed to reconcile HTTPRoute',
    view: {
      label: 'Failed',
      subtext: 'Routing configuration failed',
      heading: 'Model setup failed',
      body: 'The model’s HTTPRoute could not be created or updated.',
    },
  },
  {
    phrase: 'kind not implemented',
    view: {
      label: 'Failed',
      subtext: 'Unsupported model type',
      heading: 'Model setup failed',
      body: 'This model kind or format is not supported.',
    },
  },
];

const availabilityFrom = (reports: string[]): AvailabilityView | undefined => {
  for (const { phrase, view } of availabilityReports) {
    if (reports.some((message) => message.includes(phrase))) return view;
  }
  return undefined;
};

/** A MaaS report that is itself a deployment problem, so it can show before the model is Ready. */
const deploymentProblem = (view: AvailabilityView): boolean => view.label === 'Failed' || view.label === 'Unavailable';

/**
 * Whether tenants can call the model. A review row can name the MaaSModelRef Ready.message
 * (`maasReport`) until that condition is its own field; otherwise the column reads what each
 * cluster reported. Available and Pending show once the deployment is Ready, and Partially
 * available can show them too: some clusters are up while the model ref is still pending.
 * A Failed deployment can still show a report that is the deployment problem (setup failed,
 * invalid configuration, endpoint not serving). Starting, Stopping, Stopped, and the git
 * labels say nothing about MaaS yet. Availability is one value for the model: a subscription
 * is on the model, not on one cluster's deployment.
 */
export const availabilityOf = (
  model: Pick<ModelView, 'phase' | 'clusters' | 'maasReport'>,
): AvailabilityView | undefined => {
  if (
    model.phase === 'Saved to Git' ||
    model.phase === 'Syncing' ||
    model.phase === 'Synced' ||
    model.clusters.length === 0
  ) {
    return undefined;
  }
  const reports = model.maasReport ? [model.maasReport] : model.clusters.map((cluster) => cluster.message ?? '');
  const reported = availabilityFrom(reports);
  const ready =
    reports.some(
      (message) => message.includes('MaaSModelRef ready') || message.includes('Governed and runtime-healthy'),
    ) || model.clusters.every((cluster) => cluster.phase === 'Ready');
  const view = reported ?? (ready ? { label: MAAS_AVAILABLE } : undefined);
  if (!view) return undefined;
  if (model.phase === 'Ready' || model.phase === 'Partially ready') return view;
  if (model.phase === 'Failed' && deploymentProblem(view)) return view;
  return undefined;
};
