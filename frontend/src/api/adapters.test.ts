import getModels from '../../../mock/examples/get-models.json';
import {
  consolePlacement,
  consolePlacementLocations,
  runtimeArgsOf,
  toGridCluster,
  toManagedModel,
  toModelCreate,
  toOrganization,
  toSubscription,
  toSubscriptionInfo,
  withRuntimeArgs,
} from './adapters';
import type {
  ApiCluster,
  ApiModel,
  ApiTenant,
  CreateModelRequest,
  MaaSAuthPolicy,
  MaaSSubscription,
  SubscriptionInfoResponse,
} from './types';

// A cluster of GET /api/v1/grid/overview (mock/examples/get-grid-overview.json), trimmed.
const apiCluster = (overrides: Partial<ApiCluster> = {}): ApiCluster => ({
  name: 'site-paris-1',
  aiGridEnabled: true,
  provisioned: true,
  hubAcceptsClient: true,
  location: 'paris',
  site: 'paris-dc1',
  region: 'europe-west',
  siteName: 'Paris DC1',
  latitude: 48.8566,
  longitude: 2.3522,
  openshiftVersion: '4.22.15',
  status: 'ready',
  statusMessage: 'Managed cluster is available',
  resourceVersion: '7',
  labels: { 'ai-grid/enabled': 'true' },
  ...overrides,
});

describe('toGridCluster', () => {
  it.each([
    ['ready', 'Ready', undefined],
    ['offline', 'Offline', undefined],
    ['unknown', 'Unknown', undefined],
    ['pendingimport', 'Unknown', 'Pending import'],
    ['importing', 'Unknown', 'Importing'],
    ['importfailed', 'Unknown', 'Import failed'],
    ['detaching', 'Unknown', 'Detaching'],
    ['notaccepted', 'Unknown', 'Not accepted'],
    [undefined, 'Unknown', undefined],
  ])("maps the BFF's cluster state %s to the PoC availability %s", (status, availability, state) => {
    const cluster = toGridCluster(apiCluster({ status }));
    expect(cluster.status).toBe(availability);
    expect(cluster.state).toBe(state);
  });

  it('keeps the backend status message for the tooltip', () => {
    expect(toGridCluster(apiCluster({ status: 'importing', statusMessage: 'Import in progress' }))).toMatchObject({
      state: 'Importing',
      statusMessage: 'Import in progress',
    });
  });

  it('shows the provisioning word', () => {
    expect(toGridCluster(apiCluster()).provisioningStatus).toBe('Provisioned');
    expect(toGridCluster(apiCluster({ provisioned: false })).provisioningStatus).toBe('Provisioning');
    expect(toGridCluster(apiCluster({ aiGridEnabled: false, provisioned: false })).provisioningStatus).toBe(
      'Not provisioned',
    );
    // Just removed: the hub still reports it provisioned until its Policy lets go.
    expect(toGridCluster(apiCluster({ aiGridEnabled: false, provisioned: true })).provisioningStatus).toBe(
      'Not provisioned',
    );
  });

  it('reads coordinates and keeps them absent when the backend sends none', () => {
    expect(toGridCluster(apiCluster())).toMatchObject({ latitude: 48.8566, longitude: 2.3522 });
    const unmapped = toGridCluster(apiCluster({ latitude: undefined, longitude: undefined }));
    expect(unmapped.latitude).toBeUndefined();
    expect(unmapped.longitude).toBeUndefined();
  });

  it('keeps the shared fields and only those', () => {
    const json = {
      ...apiCluster(),
      conditions: [{ type: 'ManagedClusterConditionAvailable', status: 'True' }],
      annotations: { 'ai-grid/latitude': '48.8566' },
      gpuCapacity: 8,
    } as ApiCluster;
    expect(toGridCluster(json)).toEqual({
      name: 'site-paris-1',
      status: 'Ready',
      state: undefined,
      statusMessage: 'Managed cluster is available',
      aiGridEnabled: true,
      provisioned: true,
      provisioningStatus: 'Provisioned',
      location: 'paris',
      site: 'paris-dc1',
      region: 'europe-west',
      siteName: 'Paris DC1',
      latitude: 48.8566,
      longitude: 2.3522,
      openshiftVersion: '4.22.15',
      gpuCapacity: 8,
      addons: {},
      conditions: [{ type: 'ManagedClusterConditionAvailable', status: 'True' }],
      resourceVersion: '7',
      labels: { 'ai-grid/enabled': 'true' },
    });
  });

  it('keeps the hub details the details page shows', () => {
    const json = {
      ...apiCluster(),
      consoleUrl: 'https://console.example.com',
      kubernetesVersion: 'v1.35.6',
      platform: 'AWS',
      product: 'ROSA',
      capacity: { cpu: '32', 'nvidia.com/gpu': '1' },
      gpuCapacity: 1,
      allocatable: { cpu: '31' },
      creationTimestamp: '2026-10-21T00:15:04Z',
      addons: { submariner: 'available' },
    } as ApiCluster;
    expect(toGridCluster(json)).toMatchObject({
      consoleUrl: 'https://console.example.com',
      kubernetesVersion: 'v1.35.6',
      platform: 'AWS',
      product: 'ROSA',
      capacity: { cpu: '32', 'nvidia.com/gpu': '1' },
      gpuCapacity: 1,
      allocatable: { cpu: '31' },
      creationTimestamp: '2026-10-21T00:15:04Z',
      addons: { submariner: 'available' },
    });
  });

  it('gives a cluster without labels an empty map', () => {
    expect(toGridCluster(apiCluster({ labels: undefined })).labels).toEqual({});
  });
});

const base: MaaSSubscription = {
  name: 'team-a',
  resourceVersion: '1',
  owner: { groups: [{ name: 'team-a' }] },
  modelRefs: [{ name: 'granite-8b-instruct', tokenRateLimits: [{ limit: 1000, window: '1h' }] }],
};

describe('toSubscription', () => {
  it("picks the Ready condition into the subscription's status fields", () => {
    const json: MaaSSubscription = {
      ...base,
      phase: 'Degraded',
      conditions: [
        { type: 'SpecPriorityDuplicate', status: 'False', reason: 'NoDuplicatePeers' },
        {
          type: 'Ready',
          status: 'False',
          reason: 'PartialFailure',
          message: '1 of 1 TokenRateLimitPolicies not accepted',
          lastTransitionTime: '2026-10-16T09:00:01Z',
        },
      ],
    };
    expect(toSubscription(json)).toEqual({
      ...json,
      status: 'False',
      reason: 'PartialFailure',
      statusMessage: '1 of 1 TokenRateLimitPolicies not accepted',
      conditionType: 'Ready',
      lastTransitionTime: '2026-10-16T09:00:01Z',
    });
  });

  it('leaves a subscription the controller has not reconciled without a phase', () => {
    expect(toSubscription({ ...base, conditions: [] }).phase).toBeUndefined();
    expect(toSubscription(base).phase).toBeUndefined();
  });
});

describe('toSubscriptionInfo', () => {
  it("picks each policy's Ready condition into its status fields, as the subscription's", () => {
    // The BFF sends a policy's conditions only (the backend's internal/servers/subscription_mapper.go).
    const policy: MaaSAuthPolicy = {
      name: 'team-a-policy',
      phase: 'Active',
      modelRefs: [{ name: 'granite-8b-instruct' }],
      subjects: { groups: [{ name: 'team-a' }] },
      conditions: [
        { type: 'ConflictingAuthPolicy', status: 'False', reason: 'NoConflict' },
        {
          type: 'Ready',
          status: 'True',
          reason: 'Reconciled',
          message: 'Ready on site-a',
          lastTransitionTime: '2026-10-16T09:00:01Z',
        },
      ],
    };
    const info = toSubscriptionInfo({ subscription: base, modelRefs: [], authPolicies: [policy] });
    expect(info.authPolicies).toEqual([
      {
        ...policy,
        status: 'True',
        reason: 'Reconciled',
        statusMessage: 'Ready on site-a',
        conditionType: 'Ready',
        lastTransitionTime: '2026-10-16T09:00:01Z',
      },
    ]);
  });

  it('leaves a policy without a Ready condition, and a missing list, as they are', () => {
    const policy: MaaSAuthPolicy = { name: 'p', modelRefs: [], subjects: {} };
    expect(toSubscriptionInfo({ subscription: base, modelRefs: [], authPolicies: [policy] }).authPolicies).toEqual([
      policy,
    ]);
    const missing = { subscription: base, modelRefs: [] } as unknown as SubscriptionInfoResponse;
    expect(toSubscriptionInfo(missing).authPolicies).toBeUndefined();
  });
});

// A tenant of GET /api/v1/tenants (mock/examples/get-tenants.json), trimmed.
const apiTenant = (overrides: Partial<ApiTenant> = {}): ApiTenant => ({
  id: '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c',
  name: 'acme-robotics',
  alias: 'acme-robotics',
  enabled: true,
  description: 'Acme Robotics, EU region',
  domains: ['acme-robotics.example.com', 'acme.example.org'],
  domainDetails: [],
  attributes: {},
  resourceVersion: '3',
  createTime: '2026-09-01T09:00:00Z',
  identityProvider: {
    title: 'Acme Robotics SSO',
    description: '',
    enabled: true,
    config: {
      clientId: 'ai-grid',
      clientSecretSecret: { name: 'acme-robotics-oidc-client' },
      issuer: 'https://sso.example.com/realms/acme-robotics',
      authorizationUrl: 'https://sso.example.com/realms/acme-robotics/auth',
      tokenUrl: 'https://sso.example.com/realms/acme-robotics/token',
      defaultScopes: 'openid profile email',
      userInfoUrl: '',
      jwksUrl: '',
      logoutUrl: '',
      validateSignature: false,
    },
  },
  ...overrides,
});

describe('toOrganization', () => {
  it('maps a tenant to an organization', () => {
    expect(toOrganization(apiTenant())).toEqual({
      id: '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c',
      name: 'acme-robotics',
      domains: ['acme-robotics.example.com', 'acme.example.org'],
      description: 'Acme Robotics, EU region',
      status: 'Enabled',
      resourceVersion: '3',
      creationTimestamp: '2026-09-01T09:00:00Z',
      identityProvider: apiTenant().identityProvider,
    });
  });

  it('keeps attributes and which domains are verified, when the tenant has them', () => {
    const organization = toOrganization(
      apiTenant({
        attributes: { 'billing-account': 'ACME-0042' },
        domainDetails: [{ name: 'acme-robotics.example.com', verified: true, autoRedirect: true }],
      }),
    );
    expect(organization.attributes).toEqual({ 'billing-account': 'ACME-0042' });
    expect(organization.domainDetails).toEqual([{ name: 'acme-robotics.example.com', verified: true }]);
  });

  it('shows Disabled for a disabled tenant', () => {
    expect(toOrganization(apiTenant({ enabled: false })).status).toBe('Disabled');
  });

  it('has no identity provider when the tenant has none', () => {
    const organization = toOrganization(apiTenant({ identityProvider: undefined, resourceVersion: undefined }));
    expect(organization.identityProvider).toBeUndefined();
    expect(organization.resourceVersion).toBe('');
  });

  it('reads omitted identity provider booleans as true', () => {
    const config = { clientId: 'ai-grid', clientSecretSecret: { name: 's' }, issuer: 'https://sso.example.com' };
    const organization = toOrganization(apiTenant({ identityProvider: { title: 'SSO', config } }));
    expect(organization.identityProvider?.enabled).toBe(true);
    expect(organization.identityProvider?.config.validateSignature).toBe(true);
  });

  it('shows the registered date', () => {
    expect(toOrganization(apiTenant()).creationTimestamp).toBe('2026-09-01T09:00:00Z');
  });

  it('shows a dash without a creation time', () => {
    // The list prints a dash for an empty creationTimestamp.
    expect(toOrganization(apiTenant({ createTime: undefined })).creationTimestamp).toBe('');
  });
});

// The wizard's input (the PoC's CreateModelRequest).
const wizardInput = (overrides: Partial<CreateModelRequest> = {}): CreateModelRequest => ({
  name: 'widget',
  displayName: 'Widget',
  description: 'A test model',
  modelUri: 'hf://org/widget',
  runtimeImage: 'registry.example/runtime:test',
  replicas: 2,
  cpu: '500m',
  memory: '4Gi',
  gpuCount: 1,
  runtimeArgs: [],
  baseRefs: [],
  locations: ['site-paris-1', 'site-madrid-1'],
  ...overrides,
});

describe('toModelCreate', () => {
  it("places the model on the chosen clusters by name, as the backend's placement does", () => {
    expect(toModelCreate(wizardInput(), 'ai-grid-models')).toMatchObject({
      placement: {
        matchExpressions: [{ key: 'name', operator: 'In', values: ['site-paris-1', 'site-madrid-1'] }],
      },
      rollout: { strategy: 'All' },
    });
  });

  it('puts runtime arguments in VLLM_ADDITIONAL_ARGS', () => {
    const body = toModelCreate(wizardInput({ runtimeArgs: ['--max-model-len=4096', '--enforce-eager'] }), 'ns');
    expect(body.env).toEqual([{ name: 'VLLM_ADDITIONAL_ARGS', value: '--max-model-len=4096 --enforce-eager' }]);
  });

  it("sends the model server's presets, and an empty image so the preset's image applies", () => {
    const cpu = ['v3-6-0-kserve-config-llm-template-cpu'];
    expect(toModelCreate(wizardInput({ baseRefs: cpu, runtimeImage: '' }), 'ns')).toMatchObject({
      baseRefs: cpu,
      runtimeImage: '',
    });
    expect(toModelCreate(wizardInput(), 'ns').baseRefs).toEqual([]);
  });

  it('omits env without runtime arguments', () => {
    expect(toModelCreate(wizardInput(), 'ns')).not.toHaveProperty('env');
  });

  it("sends only the wizard's keys", () => {
    const body = toModelCreate(wizardInput({ runtimeArgs: ['--enforce-eager'] }), 'ai-grid-models');
    expect(Object.keys(body).sort()).toEqual(
      [
        'name',
        'namespace',
        'annotations',
        'modelUri',
        'runtimeImage',
        'replicas',
        'cpu',
        'memory',
        'gpuCount',
        'baseRefs',
        'env',
        'placement',
        'rollout',
      ].sort(),
    );
    expect(body).toMatchObject({
      name: 'widget',
      namespace: 'ai-grid-models',
      annotations: { 'openshift.io/display-name': 'Widget', 'openshift.io/description': 'A test model' },
      modelUri: 'hf://org/widget',
      runtimeImage: 'registry.example/runtime:test',
      replicas: 2,
      cpu: '500m',
      memory: '4Gi',
      gpuCount: 1,
    });
  });
});

describe('toManagedModel', () => {
  it("maps each cluster's phase and a partially available model (P13)", () => {
    const json = {
      ...(getModels.body.data.find((m) => m.name === 'granite-8b-instruct') as unknown as ApiModel),
      phase: 'partiallyavailable',
      rollout: {
        works: [
          { cluster: 'site-paris-1', phase: 'ready', feedback: { ready: 'True' }, conditions: [] },
          {
            cluster: 'site-madrid-1',
            phase: 'failed',
            reason: 'AppliedManifestWorkFailed',
            message: 'Failed to apply manifest work',
          },
        ],
      },
    } as ApiModel;
    const model = toManagedModel(json);
    expect(model.phase).toBe('Partially available');
    expect(model.works).toEqual([
      { cluster: 'site-paris-1', phase: 'Ready', reason: undefined, message: undefined, ready: 'True', conditions: [] },
      {
        cluster: 'site-madrid-1',
        phase: 'Failed',
        reason: 'AppliedManifestWorkFailed',
        message: 'Failed to apply manifest work',
        ready: undefined,
        conditions: [],
      },
    ]);
    // A hub model has no works.
    expect(
      toManagedModel(getModels.body.data.find((m) => m.name === 'tiny-llm') as unknown as ApiModel).works,
    ).toBeUndefined();
  });

  // GET /api/v1/models over the fake's fixtures (mock/examples/get-models.json).
  const models = getModels.body.data as unknown as ApiModel[];
  const byName = (name: string) => toManagedModel(models.find((m) => m.name === name)!);

  it('reads locations from placement.locations', () => {
    expect(byName('granite-8b-instruct').locations).toEqual(['paris']);
    expect(byName('codellama-13b').locations).toEqual([]);
  });

  it('reads the presets the model was deployed with, none when absent', () => {
    const json = { name: 'm', namespace: 'ns', modelUri: 'hf://x', modelName: 'x' };
    expect(toManagedModel({ ...json, baseRefs: ['custom-preset'] }).baseRefs).toEqual(['custom-preset']);
    expect(toManagedModel(json).baseRefs).toEqual([]);
  });

  it('has no locations without a placement', () => {
    expect(byName('tiny-llm').locations).toEqual([]);
  });

  it('reads the clusters the placement chose, by name, from placement.selectedClusters', () => {
    expect(byName('granite-8b-instruct').selectedClusters).toEqual(['site-paris-1']);
    expect(byName('mistral-7b-instruct').selectedClusters).toEqual(['site-frankfurt-1', 'site-paris-1']);
    expect(byName('codellama-13b').selectedClusters).toEqual([]);
    expect(byName('tiny-llm').selectedClusters).toEqual([]);
  });

  it('shows the phase with its reason and message', () => {
    expect(byName('granite-8b-instruct').phase).toBe('Ready');
    expect(byName('codellama-13b')).toMatchObject({ phase: 'Pending', reason: 'PlacementDecisionEmpty' });
    expect(byName('llama-3-70b')).toMatchObject({
      phase: 'Failed',
      reason: 'ConfigNotFound',
      statusMessage: expect.stringContaining('not found in namespaces'),
    });
    expect(toManagedModel({ name: 'new', namespace: 'ns', modelUri: 'hf://x', modelName: 'x' }).phase).toBe('Pending');
    // Git mode: the backend reports no phase, only that the model was saved to Git.
    const saved = { name: 'new', namespace: 'ns', modelUri: 'hf://x', modelName: 'x', reason: 'SavedToGit' };
    expect(toManagedModel(saved)).toMatchObject({ phase: 'Saved to Git', reason: 'SavedToGit' });
    // A real phase wins over the reason.
    expect(toManagedModel({ ...saved, phase: 'ready' }).phase).toBe('Ready');
  });

  it('maps the fields the pages read', () => {
    expect(byName('granite-8b-instruct')).toMatchObject({
      name: 'granite-8b-instruct',
      namespace: 'ai-grid-models',
      displayName: 'Granite 8B Instruct',
      modelRef: { kind: 'LLMInferenceService', name: 'granite-8b-instruct' },
      modelUri: 'hf://example-org/granite-8b-instruct',
      modelName: 'granite-8b-instruct',
      replicas: 1,
      resourceVersion: '48760230',
    });
    expect(byName('granite-8b-instruct').creationTimestamp).toBeTruthy();
  });

  it('keeps what an edit needs: requests, env, annotations and the placement spec', () => {
    const model = toManagedModel({
      name: 'chat',
      namespace: 'ns',
      modelUri: 'hf://x',
      modelName: 'x',
      requests: { cpu: '8', memory: '32Gi', 'nvidia.com/gpu': '1' },
      env: [{ name: 'A', value: '1' }],
      annotations: { 'openshift.io/display-name': 'Chat', team: 'x' },
      placement: { ...consolePlacement(['paris']), locations: ['paris'] },
    });
    expect(model).toMatchObject({ cpu: '8', memory: '32Gi', gpuCount: 1, autoscaled: false });
    expect(model.env).toEqual([{ name: 'A', value: '1' }]);
    expect(model.annotations).toEqual({ 'openshift.io/display-name': 'Chat', team: 'x' });
    // The spec without the decision's locations.
    expect(model.placementSpec).toEqual(consolePlacement(['paris']));
    expect(
      toManagedModel({ name: 'k', namespace: 'ns', modelUri: 'hf://x', modelName: 'x', scaling: {} }).autoscaled,
    ).toBe(true);
  });
});

describe('consolePlacementLocations', () => {
  it('reads the clusters of a placement the console wrote', () => {
    expect(consolePlacementLocations(consolePlacement(['site-a', 'site-b']))).toEqual(['site-a', 'site-b']);
  });

  it.each([
    ['a hub-only model', undefined],
    ['cluster sets', { ...consolePlacement(['paris']), clusterSets: ['global'] }],
    ['labels', { ...consolePlacement(['paris']), matchLabels: { 'ai-grid/enabled': 'true' } }],
    [
      'another expression',
      { ...consolePlacement(['paris']), matchExpressions: [{ key: 'name', operator: 'NotIn', values: ['x'] }] },
    ],
    ['the location label', { matchExpressions: [{ key: 'location', operator: 'In', values: ['paris'] }] }],
    [
      'a second expression',
      {
        matchExpressions: [
          ...consolePlacement(['paris']).matchExpressions,
          { key: 'zone', operator: 'In', values: ['a'] },
        ],
      },
    ],
    ['a cluster count', { ...consolePlacement(['paris']), numberOfClusters: 1 }],
  ])('is undefined for any other shape: %s', (_, spec) => {
    expect(consolePlacementLocations(spec)).toBeUndefined();
  });
});

describe('runtime arguments in env', () => {
  it('reads and replaces VLLM_ADDITIONAL_ARGS, keeping every other variable', () => {
    const env = [
      { name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' },
      { name: 'VLLM_ADDITIONAL_ARGS', value: '--max-model-len 4096 --enforce-eager -tp=2' },
    ];
    // One line per flag, its value kept with it.
    expect(runtimeArgsOf(env)).toEqual(['--max-model-len 4096', '--enforce-eager', '-tp=2']);
    expect(withRuntimeArgs(env, ['--enforce-eager'])).toEqual([
      { name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' },
      { name: 'VLLM_ADDITIONAL_ARGS', value: '--enforce-eager' },
    ]);
    // No arguments drop the variable, not the others.
    expect(withRuntimeArgs(env, [])).toEqual([{ name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' }]);
    expect(runtimeArgsOf(undefined)).toEqual([]);
  });

  it('keeps quoted values whole, flag-like text and spacing included, so an edit round-trips them', () => {
    const value = `--served-model-name "alpha  --beta" --chat-template '{{ x }} --y' --enforce-eager`;
    const args = runtimeArgsOf([{ name: 'VLLM_ADDITIONAL_ARGS', value }]);
    expect(args).toEqual([`--served-model-name "alpha  --beta"`, `--chat-template '{{ x }} --y'`, '--enforce-eager']);
    // Joined again the way the wizard joins its lines, the value is unchanged.
    expect(withRuntimeArgs([], args)).toEqual([{ name: 'VLLM_ADDITIONAL_ARGS', value }]);
  });
});
