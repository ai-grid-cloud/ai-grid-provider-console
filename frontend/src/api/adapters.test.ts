import { toGridCluster, toOrganization } from './adapters';
import type { ApiCluster, ApiTenant } from './types';

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
