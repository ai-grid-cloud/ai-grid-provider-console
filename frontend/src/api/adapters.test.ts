import getModels from '../../../mock/examples/get-models.json';
import { toGridCluster, toManagedModel, toModelCreate, toOrganization, toSubscription } from './adapters';
import type { ApiCluster, ApiModel, ApiTenant, CreateModelRequest, MaaSSubscription } from './types';

// The cluster JSON of GET /api/v1/clusters (mock/examples/get-clusters.json), trimmed.
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
  ])('maps PR 12 cluster state %s to the PoC availability %s', (status, availability, state) => {
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
      hubAcceptsClient: true,
      location: 'paris',
      site: 'paris-dc1',
      region: 'europe-west',
      siteName: 'Paris DC1',
      latitude: 48.8566,
      longitude: 2.3522,
      openshiftVersion: '4.22.15',
      resourceVersion: '7',
      labels: { 'ai-grid/enabled': 'true' },
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
      status: 'Saved',
      resourceVersion: '3',
      creationTimestamp: '2026-09-01T09:00:00Z',
      identityProvider: apiTenant().identityProvider,
    });
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
  modelName: 'org/widget',
  runtimeImage: 'registry.example/runtime:test',
  replicas: 2,
  cpu: '500m',
  memory: '4Gi',
  gpuCount: 1,
  runtimeArgs: [],
  locations: ['paris', 'madrid'],
  ...overrides,
});

describe('toModelCreate', () => {
  it('builds the PoC placement from locations', () => {
    expect(toModelCreate(wizardInput(), 'ai-grid-models')).toMatchObject({
      placement: {
        matchLabels: { 'ai-grid/enabled': 'true', 'ai-grid/provisioned': 'true' },
        matchExpressions: [{ key: 'location', operator: 'In', values: ['paris', 'madrid'] }],
      },
      rollout: { strategy: 'All' },
    });
  });

  it('puts runtime arguments in VLLM_ADDITIONAL_ARGS', () => {
    const body = toModelCreate(wizardInput({ runtimeArgs: ['--max-model-len=4096', '--enforce-eager'] }), 'ns');
    expect(body.env).toEqual([{ name: 'VLLM_ADDITIONAL_ARGS', value: '--max-model-len=4096 --enforce-eager' }]);
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
        'modelName',
        'runtimeImage',
        'replicas',
        'cpu',
        'memory',
        'gpuCount',
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
      modelName: 'org/widget',
      runtimeImage: 'registry.example/runtime:test',
      replicas: 2,
      cpu: '500m',
      memory: '4Gi',
      gpuCount: 1,
    });
  });
});

describe('toManagedModel', () => {
  // GET /api/v1/models under PR 12's fixtures (mock/examples/get-models.json).
  const models = getModels.body.data as unknown as ApiModel[];
  const byName = (name: string) => toManagedModel(models.find((m) => m.name === name)!);

  it('reads locations from placement.locations', () => {
    expect(byName('granite-8b-instruct').locations).toEqual(['paris']);
    expect(byName('codellama-13b').locations).toEqual([]);
  });

  it('has no locations without a placement', () => {
    expect(byName('tiny-llm').locations).toEqual([]);
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
  });

  it('maps the fields the pages read', () => {
    expect(byName('granite-8b-instruct')).toMatchObject({
      name: 'granite-8b-instruct',
      namespace: 'ai-grid-models',
      displayName: 'Granite 8B Instruct',
      modelRef: { kind: 'LLMInferenceService', name: 'granite-8b-instruct' },
      modelUri: 'hf://example-org/granite-8b-instruct',
      modelName: 'example-org/granite-8b-instruct',
      replicas: 1,
      resourceVersion: '48760230',
      // PR 12 models have no MaaS registration: every one is deployed and open to subscriptions.
      availableForSubscriptions: true,
    });
    expect(byName('granite-8b-instruct').creationTimestamp).toBeTruthy();
  });
});
