import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import {
  ManagedClusterLocationSource,
  ManagedClusterSchema,
  ManagedClusterState,
  type ManagedCluster,
  type ManagedClusterLocationSchema,
} from '../../gen/ai_grid/v1/managed_cluster_type_pb';
import { toClusterView } from './clusterView';

/** A ManagedCluster as Clusters/List answers it, with what the test sets. */
const cluster = (init: {
  labels?: Record<string, string>;
  member?: boolean;
  state?: ManagedClusterState;
  stateMessage?: string;
  provisioning?: string;
  capacity?: Record<string, string>;
  claims?: Record<string, string>;
  location?: MessageInitShape<typeof ManagedClusterLocationSchema>;
}): ManagedCluster =>
  create(ManagedClusterSchema, {
    id: 'site-a',
    metadata: {
      name: 'site-a',
      version: 6141364,
      labels: init.labels ?? {},
      creationTimestamp: timestampFromDate(new Date('2026-10-20T14:00:00Z')),
    },
    spec: { hubAcceptsClient: true },
    status: {
      availableCondition: 'True',
      aiGridMember: init.member ?? false,
      state: init.state ?? ManagedClusterState.READY,
      stateMessage: init.stateMessage ?? '',
      provisioning: init.provisioning ?? '',
      kubernetesVersion: 'v1.34.9',
      capacity: init.capacity ?? {},
      clusterClaims: Object.entries(init.claims ?? {}).map(([name, value]) => ({ name, value })),
      location: init.location ?? { source: ManagedClusterLocationSource.NONE },
    },
  });

describe('toClusterView', () => {
  it('reads the documented labels, claims and location', () => {
    const view = toClusterView(
      cluster({
        labels: { location: 'us-east', 'ai-grid/site': 'ashburn-dc1', openshiftVersion: '4.21.36' },
        claims: {
          'consoleurl.cluster.open-cluster-management.io': 'https://console.example.com',
          'platform.open-cluster-management.io': 'AWS',
          'product.open-cluster-management.io': 'OpenShift',
        },
        location: {
          siteName: 'Ashburn DC1',
          latitude: 39.0438,
          longitude: -77.4874,
          source: ManagedClusterLocationSource.ANNOTATIONS,
          region: 'us-east-1',
        },
      }),
    );
    expect(view).toMatchObject({
      name: 'site-a',
      version: 6141364,
      location: 'us-east',
      site: 'ashburn-dc1',
      siteName: 'Ashburn DC1',
      latitude: 39.0438,
      longitude: -77.4874,
      locationSource: 'annotations',
      region: 'us-east-1',
      openshiftVersion: '4.21.36',
      consoleUrl: 'https://console.example.com',
      platform: 'AWS',
      product: 'OpenShift',
      kubernetesVersion: 'v1.34.9',
      creationTimestamp: '2026-10-20T14:00:00.000Z',
    });
  });

  it("words the backend's location: approximate from the cloud region, or none with the problem to fix", () => {
    const approximate = toClusterView(
      cluster({
        location: {
          latitude: 40.4173,
          longitude: -82.9071,
          source: ManagedClusterLocationSource.CLOUD_REGION,
          region: 'us-east-2',
        },
      }),
    );
    expect(approximate).toMatchObject({ latitude: 40.4173, locationSource: 'cloud region', region: 'us-east-2' });
    const wrong = toClusterView(
      cluster({
        location: {
          siteName: 'Paris DC1',
          source: ManagedClusterLocationSource.NONE,
          problem: 'ai-grid/latitude "48,85" is not a decimal number of degrees',
        },
      }),
    );
    expect(wrong).toMatchObject({
      siteName: 'Paris DC1',
      locationSource: 'none',
      locationProblem: 'ai-grid/latitude "48,85" is not a decimal number of degrees',
    });
    expect(wrong.latitude).toBeUndefined();
    expect(wrong.longitude).toBeUndefined();
  });

  it("words the backend's lifecycle state: Ready, Unavailable (ACM's Offline), or Unknown with the ACM state behind it", () => {
    const view = (state: ManagedClusterState) => toClusterView(cluster({ state, stateMessage: 'why' }));
    expect(view(ManagedClusterState.READY)).toMatchObject({ status: 'Ready', statusMessage: 'why' });
    expect(view(ManagedClusterState.READY).state).toBeUndefined();
    expect(view(ManagedClusterState.OFFLINE).status).toBe('Unavailable');
    expect(view(ManagedClusterState.UNKNOWN).status).toBe('Unknown');
    expect(view(ManagedClusterState.UNSPECIFIED).status).toBe('Unknown');
    expect(view(ManagedClusterState.DETACHING)).toMatchObject({ status: 'Unknown', state: 'Detaching' });
    expect(view(ManagedClusterState.NOT_ACCEPTED)).toMatchObject({ status: 'Unknown', state: 'Not accepted' });
    // A state added to the backend after this console was built.
    expect(view(99 as ManagedClusterState)).toMatchObject({ status: 'Unknown', state: undefined });
  });

  it("takes membership from the backend's ai_grid_member, not from the labels", () => {
    const labelled = cluster({ labels: { 'ai-grid/enabled': 'true' }, provisioning: 'Compliant' });
    expect(toClusterView(labelled)).toMatchObject({ aiGridEnabled: false, provisioningStatus: 'Not provisioned' });
    expect(toClusterView(cluster({ member: true, provisioning: 'Compliant' }))).toMatchObject({
      aiGridEnabled: true,
      provisioningStatus: 'Provisioned',
    });
    for (const provisioning of ['', 'Pending', 'NonCompliant']) {
      expect(toClusterView(cluster({ member: true, provisioning })).provisioningStatus).toBe('Provisioning');
    }
  });

  it('counts the GPUs in the capacity as the device plugin writes them, and keeps 0 apart from none', () => {
    expect(toClusterView(cluster({ capacity: { 'nvidia.com/gpu': '16' } })).gpuCapacity).toBe(16);
    expect(toClusterView(cluster({ capacity: { cpu: '8' } })).gpuCapacity).toBe(0);
    // Another quantity spelling reads as 0, as the BFF read it.
    expect(toClusterView(cluster({ capacity: { 'nvidia.com/gpu': '1e1' } })).gpuCapacity).toBe(0);
    expect(toClusterView(cluster({ capacity: { 'nvidia.com/gpu': '-1' } })).gpuCapacity).toBeUndefined();
    const none = toClusterView(cluster({}));
    expect(none.capacity).toBeUndefined();
    expect(none.gpuCapacity).toBeUndefined();
  });

  it('shows nothing for empty values rather than empty strings', () => {
    const view = toClusterView(
      cluster({ labels: { location: '' }, claims: { 'platform.open-cluster-management.io': '' } }),
    );
    expect(view.location).toBeUndefined();
    expect(view.platform).toBeUndefined();
    expect(view.site).toBeUndefined();
    expect(view.siteName).toBeUndefined();
    expect(view.region).toBeUndefined();
    expect(view.locationProblem).toBeUndefined();
  });
});
