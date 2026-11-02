// Review rows for the Models list. A dev build shows them on /models, ahead of the backend's
// models. Names are real models. Deployment status words are the ones Open Data Hub shows
// (Starting, Ready, Failed, Stopped, Stopping, Unknown), plus the grid's Saved to Git and
// Partially ready. Availability is not a backend field. A row's maasReport is the
// MaaSModelRef Ready.message that sample stands in for; availabilityOf reads it.
import type { ClusterView } from '../clusters/clusterView';
import type { ModelClusterView, ModelPhaseWord, ModelView } from './modelView';

export type StatusReviewCluster = Pick<ClusterView, 'name' | 'location' | 'siteName' | 'consoleUrl'>;

/**
 * The live Granite 3B is Pending while its clusters disagree (ready on one, not ready on another).
 * In a dev build it stands in as the second Partially ready sample, with a pending MaaS report.
 * Tests and `?review=1` do not use it.
 */
export const devReviewModel = (model: ModelView): ModelView => {
  if (import.meta.env.MODE !== 'development' || model.id !== 'granite-3b') return model;
  return {
    ...model,
    phase: 'Partially ready',
    maasReport: 'Awaiting governance pairing and backend readiness',
  };
};

const consoleFor = (name: string) => `https://console-openshift-console.apps.${name}.example.com`;

/** The clusters the review models name. site-berlin-1 has no console URL. */
export const statusReviewClusters: StatusReviewCluster[] = (
  [
    ['site-paris-1', 'paris', 'Paris DC1', true],
    ['site-madrid-1', 'madrid', 'Madrid DC1', true],
    ['site-ashburn-1', 'ashburn', 'Ashburn DC1', true],
    ['site-frankfurt-1', 'frankfurt', 'Frankfurt DC1', true],
    ['site-berlin-1', 'berlin', 'Berlin DC1', false],
    ['site-oslo-1', 'oslo', 'Oslo DC1', true],
  ] as [string, string, string, boolean][]
).map(([name, location, siteName, hasConsole]) => ({
  name,
  location,
  siteName,
  consoleUrl: hasConsole ? consoleFor(name) : undefined,
}));

const reported = (cluster: string, phase: ModelPhaseWord, reason: string, message?: string): ModelClusterView => ({
  cluster,
  phase,
  reason,
  message,
});

const reviewModel = (
  id: string,
  displayName: string,
  phase: ModelPhaseWord,
  clusters: ModelClusterView[],
  extra: Partial<ModelView> = {},
): ModelView => ({
  id,
  displayName,
  modelName: id,
  replicas: 1,
  baseRefs: [],
  autoscaled: false,
  env: [],
  annotations: {},
  phase,
  version: 1,
  locations: [
    ...new Set(
      clusters
        .map((cluster) => statusReviewClusters.find((c) => c.name === cluster.cluster)?.location)
        .filter((location): location is string => !!location),
    ),
  ],
  selectedClusters: clusters.map((cluster) => cluster.cluster),
  clusters: clusters.filter((cluster) => cluster.phase !== 'Saved to Git'),
  placed: true,
  creationTimestamp: '2026-10-30T12:00:00.000Z',
  ...extra,
});

/** Sample models, one for each Open Data Hub deployment label, plus the grid-only statuses. */
export const statusReviewModels: ModelView[] = [
  reviewModel('granite-3.3-2b', 'Granite 3.3 2B', 'Saved to Git', [], {
    selectedClusters: ['site-paris-1'],
    locations: ['paris'],
    clusters: [],
  }),
  reviewModel('codestral', 'Codestral', 'Syncing', [], {
    selectedClusters: ['site-paris-1'],
    locations: ['paris'],
    clusters: [],
  }),
  reviewModel('llama-3.2-1b', 'Llama 3.2 1B', 'Synced', [
    reported('site-paris-1', 'Starting', 'Progressing', 'Model deployment is starting.'),
    reported('site-madrid-1', 'Starting', 'Progressing', 'Model deployment is starting.'),
  ]),
  reviewModel('llama-3.2-3b', 'Llama 3.2 3B', 'Starting', [
    reported('site-paris-1', 'Starting', 'Progressing', 'Model deployment is starting.'),
    reported('site-madrid-1', 'Starting', 'Progressing', 'Model deployment is starting.'),
  ]),
  reviewModel(
    'mistral-nemo',
    'Mistral Nemo',
    'Ready',
    [reported('site-paris-1', 'Ready', 'Ready', 'LLMInferenceService ready; no MaaSModelRef report')],
    { maasReport: 'Awaiting governance pairing' },
  ),
  reviewModel('llama-3.1-8b', 'Llama 3.1 8B', 'Ready', [
    reported('site-paris-1', 'Ready', 'Ready', 'LLMInferenceService ready; MaaSModelRef ready'),
  ]),
  reviewModel(
    'phi-4-mini',
    'Phi-4 mini',
    'Failed',
    [
      reported(
        'site-madrid-1',
        'Failed',
        'ConfigNotFound',
        'A runtime template this model needs isn’t installed on the hub. no MaaSModelRef report',
      ),
    ],
    {
      maasReport: 'Gateway not found',
      reason: 'ConfigNotFound',
      statusMessage: 'A runtime template this model needs isn’t installed on the hub.',
    },
  ),
  reviewModel('qwen2.5-7b', 'Qwen2.5 7B', 'Failed', [
    reported('site-frankfurt-1', 'Failed', 'NotAsExpected', 'LLMInferenceService not ready; MaaSModelRef ready'),
  ]),
  reviewModel(
    'llama-3.3-70b',
    'Llama 3.3 70B',
    'Partially ready',
    [
      reported('site-paris-1', 'Ready', 'Ready', 'LLMInferenceService ready; MaaSModelRef ready'),
      reported('site-madrid-1', 'Starting', 'Progressing', 'Model deployment is starting.'),
      reported('site-ashburn-1', 'Failed', 'NotAsExpected', 'The cluster has not reported the model ready.'),
      reported('site-frankfurt-1', 'Ready', 'Ready', 'LLMInferenceService ready; MaaSModelRef ready'),
      reported('site-berlin-1', 'Starting', 'Progressing', 'Model deployment is starting.'),
    ],
    {
      maasReport: 'Waiting for HTTPRoute to be created',
      statusMessage:
        'Not ready on site-madrid-1, site-ashburn-1, and site-berlin-1. Ready on site-paris-1 and site-frankfurt-1.',
    },
  ),
  reviewModel('gemma-2-9b', 'Gemma 2 9B', 'Stopped', [
    reported('site-paris-1', 'Stopped', 'Stopped', 'Offline and not using resources.'),
  ]),
  reviewModel('deepseek-r1-8b', 'DeepSeek R1 Distill', 'Stopping', [
    reported('site-madrid-1', 'Stopping', 'Stopping', 'Waiting for the deployment to stop.'),
  ]),
  reviewModel('mixtral-8x7b', 'Mixtral 8x7B', 'Unknown', [reported('site-oslo-1', 'Unknown', 'Something')]),
];
