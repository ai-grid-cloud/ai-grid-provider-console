import type {
  ApiCluster,
  ApiModel,
  ApiModelCreate,
  ApiTenant,
  ClusterState,
  ClusterStatus,
  CreateModelRequest,
  GridCluster,
  IdentityProvider,
  ManagedModel,
  Organization,
} from './types';

// The one place that turns the BFF's JSON into the types the pages read. It renames
// fields and picks display words; anything the backend should decide stays there.

const availability: Record<string, ClusterStatus> = { ready: 'Ready', offline: 'Offline' };

const states: Record<string, ClusterState> = {
  pendingimport: 'Pending import',
  importing: 'Importing',
  importfailed: 'Import failed',
  detaching: 'Detaching',
  notaccepted: 'Not accepted',
};

/**
 * Maps a cluster of GET /clusters, PATCH /clusters/{name}, or GET /grid/overview to the
 * PoC's GridCluster. Ready and offline keep their words; every other ACM state, and a
 * cluster without one, is Unknown, with the ACM word in `state`.
 */
export const toGridCluster = (json: ApiCluster): GridCluster => ({
  name: json.name,
  status: availability[json.status ?? ''] ?? 'Unknown',
  state: states[json.status ?? ''],
  statusMessage: json.statusMessage,
  aiGridEnabled: json.aiGridEnabled,
  provisioned: json.provisioned,
  provisioningStatus: json.provisioned ? 'Provisioned' : json.aiGridEnabled ? 'Provisioning' : 'Not provisioned',
  hubAcceptsClient: json.hubAcceptsClient ?? false,
  location: json.location,
  site: json.site,
  region: json.region,
  siteName: json.siteName,
  latitude: json.latitude,
  longitude: json.longitude,
  openshiftVersion: json.openshiftVersion,
  resourceVersion: json.resourceVersion,
  labels: json.labels ?? {},
});

const toIdentityProvider = (json: NonNullable<ApiTenant['identityProvider']>): IdentityProvider => {
  const config = json.config ?? {};
  return {
    title: json.title ?? '',
    description: json.description ?? '',
    // The backend refuses a disabled identity provider, as the PoC does.
    enabled: true,
    config: {
      clientId: config.clientId ?? '',
      clientSecretSecret: { name: config.clientSecretSecret?.name ?? '' },
      issuer: config.issuer ?? '',
      authorizationUrl: config.authorizationUrl ?? '',
      tokenUrl: config.tokenUrl ?? '',
      defaultScopes: config.defaultScopes ?? '',
      userInfoUrl: config.userInfoUrl ?? '',
      jwksUrl: config.jwksUrl ?? '',
      logoutUrl: config.logoutUrl ?? '',
      validateSignature: config.validateSignature ?? true,
    },
  };
};

/**
 * Maps a tenant of GET/POST/PATCH /tenants to the PoC's organization: "Saved" when enabled,
 * "Disabled" otherwise; the backend's version and creation time, empty when it sends none.
 */
export const toOrganization = (json: ApiTenant): Organization => {
  const out: Organization = {
    id: json.id,
    name: json.name,
    domains: json.domains ?? [],
    status: json.enabled ? 'Saved' : 'Disabled',
    resourceVersion: json.resourceVersion ?? '',
    creationTimestamp: json.createTime ?? '',
  };
  if (json.identityProvider) {
    out.identityProvider = toIdentityProvider(json.identityProvider);
  }
  return out;
};

const modelPhases: Record<string, string> = { pending: 'Pending', ready: 'Ready', failed: 'Failed' };

/**
 * Maps a model of GET/POST /models to the PoC's ManagedModel. Status is PR 12's phase (Pending
 * before the backend reports one); locations are the placement's decided locations (P8). PR 12
 * models have no MaaS registration, so every model counts as deployed and open to subscriptions.
 */
export const toManagedModel = (json: ApiModel): ManagedModel => ({
  name: json.name,
  namespace: json.namespace,
  displayName: json.displayName,
  description: json.description,
  modelRef: { kind: 'LLMInferenceService', name: json.name },
  phase: json.phase ? (modelPhases[json.phase] ?? json.phase) : 'Pending',
  reason: json.reason,
  statusMessage: json.message,
  creationTimestamp: json.creationTimestamp,
  resourceVersion: json.resourceVersion ?? '',
  locations: json.placement?.locations ?? [],
  availableForSubscriptions: true,
  modelUri: json.modelUri,
  modelName: json.modelName,
  runtimeImage: json.runtimeImage,
  replicas: json.replicas,
});

/**
 * The wizard's input as PR 12's POST /models body, with only the keys the PoC writes. The
 * Placement is the PoC's (backend/placements.mjs): enrolled, provisioned clusters at the chosen
 * locations, rolled out to all at once. Runtime arguments go in VLLM_ADDITIONAL_ARGS, as the
 * PoC's deployment does (backend/models.mjs deploymentResources).
 */
export const toModelCreate = (input: CreateModelRequest, namespace: string): ApiModelCreate => ({
  name: input.name,
  namespace,
  // The BFF takes the display name and description as annotations, as on PATCH; empty ones are left out.
  annotations: {
    ...(input.displayName ? { 'openshift.io/display-name': input.displayName } : {}),
    ...(input.description ? { 'openshift.io/description': input.description } : {}),
  },
  modelUri: input.modelUri,
  modelName: input.modelName,
  runtimeImage: input.runtimeImage,
  replicas: input.replicas,
  cpu: input.cpu,
  memory: input.memory,
  gpuCount: input.gpuCount,
  ...(input.runtimeArgs.length > 0
    ? { env: [{ name: 'VLLM_ADDITIONAL_ARGS', value: input.runtimeArgs.join(' ') }] }
    : {}),
  placement: {
    matchLabels: { 'ai-grid/enabled': 'true', 'ai-grid/provisioned': 'true' },
    matchExpressions: [{ key: 'location', operator: 'In', values: [...input.locations] }],
  },
  rollout: { strategy: 'All' },
});
