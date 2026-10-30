import { act, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { ServiceError } from '../api/ConsoleService';
import { MockConsoleService, seedClusters } from '../api/MockConsoleService';
import type { GridCluster } from '../api/types';
import { create } from '@bufbuild/protobuf';
import { fakeClients } from '../api/connect/testing';
import { ManagedClusterLocationSource, ManagedClusterSchema } from '../gen/ai_grid/v1/managed_cluster_type_pb';
import { renderAt } from './render';
import { EMPTY_VALUE } from '../utilities/format';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/clusters/ClusterDetailsPage';
import { TestApp } from './TestApp';

/** A cluster as today's backend sends it: no claims, capacity or conditions. */
const bare = (): GridCluster => ({
  name: 'bare-1',
  status: 'Ready',
  aiGridEnabled: true,
  provisioned: false,
  provisioningStatus: 'Provisioning',
  location: 'us-east',
  openshiftVersion: '4.21.36',
  creationTimestamp: '2026-10-21T03:56:00Z',
  addons: { 'work-manager': 'available', submariner: 'unreachable' },
  conditions: [],
  labels: { 'ai-grid/enabled': 'true', 'ai-grid/role': 'inference', location: 'us-east' },
});

const details = (label: string) => screen.getByLabelText(label);

it('opens from the Clusters list', async () => {
  const user = userEvent.setup();
  renderAt('/clusters', new MockConsoleService());
  await user.click(await screen.findByRole('link', { name: 'site4' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'site4' })).toBeVisible();
  const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(within(breadcrumb).getByRole('link', { name: 'Clusters' })).toHaveAttribute('href', '/clusters');
});

it('shows a member: AI Grid, the cluster, its capacity and GPUs', async () => {
  renderAt('/clusters/site1', new MockConsoleService());
  expect(await screen.findByRole('heading', { level: 1, name: 'site1' })).toBeVisible();

  expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Provisioned');
  const aiGrid = details('AI Grid membership');
  expect(aiGrid).toHaveTextContent('Combined: A MaaS (ingress) cluster that also serves models.');
  expect(aiGrid).toHaveTextContent('site1');
  // The same order as the list's AI Grid columns: status, location, role (UX review).
  expect(
    within(aiGrid)
      .getAllByRole('term')
      .map((t) => t.textContent),
  ).toEqual(['Status', 'Location label', 'Role']);

  const cluster = details('Cluster');
  // The hub's connection to the cluster is the Cluster card's status, not an unlabeled one in the
  // page header (UX review).
  expect(screen.getByTestId('cluster-status')).toHaveTextContent('Ready');
  expect(
    within(screen.getByRole('heading', { level: 1, name: 'site1' }).parentElement!).queryByText('Ready'),
  ).toBeNull();
  for (const text of ['4.22.15', 'v1.35.6', 'BareMetal', 'OpenShift']) {
    expect(cluster).toHaveTextContent(text);
  }

  const capacity = details('Capacity');
  expect(capacity).toHaveTextContent('192 cores, 186 cores allocatable');
  expect(capacity).toHaveTextContent('1536 GiB, 1504 GiB allocatable');
  expect(screen.getByTestId('cluster-gpus')).toHaveTextContent('16');

  // No Add-ons: the provider admin doesn't need them (UX review).
  expect(screen.queryByRole('heading', { name: 'Add-ons' })).not.toBeInTheDocument();

  // The GPUs: what GPU Feature Discovery reports on the nodes, through ACM Search.
  const gpus = details('GPUs');
  expect(screen.getByTestId('cluster-gpu-capacity')).toHaveTextContent('2 nodes, 16 GPUs');
  expect(screen.getByTestId('cluster-gpu-configurations')).toHaveTextContent(
    'NVIDIA H200, 8 GPUs/node, 140.4 GiB each',
  );
  expect(gpus).toHaveTextContent('ManufacturerNVIDIA');
  expect(gpus).toHaveTextContent('ArchitectureHopper');
  expect(gpus).toHaveTextContent('Driver580.105.08 (CUDA 13.0)');
  const nodes = screen.getByRole('grid', { name: 'GPU nodes' });
  const row = within(nodes).getByRole('row', { name: /gpu-h200-0/ });
  for (const text of [
    'NVIDIA H200',
    '140.4 GiB',
    'Hopper (9.0)',
    '580.105.08 (CUDA 13.0)',
    // Not shared: the empty value, as every missing value.
    EMPTY_VALUE,
    'p5en.48xlarge',
    'Ready',
  ]) {
    expect(row).toHaveTextContent(text);
  }
  expect(within(row).getByRole('cell', { name: '8' })).toBeInTheDocument();

  // No hub conditions: raw API state that the provider admin doesn't need (UX review).
  expect(screen.queryByRole('heading', { name: 'Conditions' })).not.toBeInTheDocument();

  // The cluster's own console opens in a new tab.
  const console = screen.getByRole('link', { name: 'OpenShift console' });
  expect(console).toHaveAttribute('href', 'https://console-openshift-console.apps.site1.example.com');
  expect(console).toHaveAttribute('target', '_blank');
});

it("says what the backend doesn't report yet instead of showing zeros", async () => {
  renderAt('/clusters/bare-1', new MockConsoleService(undefined, [bare()]));
  expect(await screen.findByRole('heading', { level: 1, name: 'bare-1' })).toBeVisible();
  expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Provisioning');
  expect(details('AI Grid membership')).toHaveTextContent('Inference');
  // Versions the labels carry show; claims the backend doesn't send read as empty.
  expect(details('Cluster')).toHaveTextContent('4.21.36');
  expect(details('Cluster')).toHaveTextContent('Platform—');
  expect(screen.getByText("The backend doesn't report this cluster's capacity yet.")).toBeVisible();
  expect(screen.queryByTestId('cluster-gpus')).not.toBeInTheDocument();
  expect(screen.getByText("The backend doesn't report this cluster's GPUs yet.")).toBeVisible();
  expect(screen.queryByRole('link', { name: 'OpenShift console' })).not.toBeInTheDocument();
});

it('words shared and sliced GPUs: time-slicing and MIG', async () => {
  renderAt('/clusters/site2', new MockConsoleService());
  expect(await screen.findByTestId('cluster-gpu-configurations')).toHaveTextContent(
    'NVIDIA L4, 1 GPU/node, 22.5 GiB each, Time-sliced ×4',
  );
  expect(within(screen.getByRole('grid', { name: 'GPU nodes' })).getAllByRole('row')[1]).toHaveTextContent(
    /NVIDIA L4.*Time-sliced ×4/,
  );
});

it('says which GPU count is which on a time-sliced cluster', async () => {
  // site2: 4 L4 nodes, one GPU each, time-sliced ×4, so the hub schedules 16. The Capacity card
  // shows what Kubernetes can schedule, with the GPU Feature Discovery count beside it; the GPUs
  // card and the list show the GPUs themselves.
  renderAt('/clusters/site2', new MockConsoleService());
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent('16 (4 GPUs, Time-sliced ×4)');
  expect(within(details('Capacity')).getByText('Schedulable GPUs')).toBeVisible();
  expect(screen.getByTestId('cluster-gpu-capacity')).toHaveTextContent('4 nodes, 4 GPUs');
});

it('names the sharing beside the schedulable GPUs only when every configuration shares the same way', async () => {
  const clusters = seedClusters();
  // site2's 4 time-sliced L4 nodes plus one unshared H100 node with 8 GPUs: 16 + 8 schedulable, 12 GPUs.
  const site2 = clusters[1];
  const sliced = site2.gpus!.configurations[0];
  site2.capacity = { ...site2.capacity, 'nvidia.com/gpu': '24' };
  site2.gpuCapacity = 24;
  site2.gpus = {
    ...site2.gpus!,
    total: site2.gpus!.total + 8,
    nodeCount: site2.gpus!.nodeCount + 1,
    configurations: [
      sliced,
      {
        ...sliced,
        product: 'NVIDIA-H100-80GB-HBM3',
        gpusPerNode: 8,
        nodeCount: 1,
        sharing: { strategy: 'none', replicas: 1, migCapable: false },
      },
    ],
  };
  renderAt('/clusters/site2', new MockConsoleService(undefined, clusters));
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent(/^24 \(12 GPUs\)$/);
});

it('keeps the sharing wording as the list has it, MPS included', async () => {
  const clusters = seedClusters();
  const site2 = clusters[1];
  site2.gpus = {
    ...site2.gpus!,
    configurations: site2.gpus!.configurations.map((g) => ({
      ...g,
      sharing: { ...g.sharing, strategy: 'mps', replicas: 4 },
    })),
  };
  renderAt('/clusters/site2', new MockConsoleService(undefined, clusters));
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent('16 (4 GPUs, MPS ×4)');
});

it('shows the schedulable GPUs alone when GPU Feature Discovery counts the same, as under MIG single', async () => {
  // site3: MIG 3g.20gb, where GFD counts each MIG device as the hub does.
  renderAt('/clusters/site3', new MockConsoleService());
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent(/^16$/);
});

it('gives each configuration its node count only when a cluster mixes them', async () => {
  // One configuration: Capacity already says how many nodes, so the line doesn't repeat it.
  renderAt('/clusters/site2', new MockConsoleService());
  expect(await screen.findByTestId('cluster-gpu-configurations')).not.toHaveTextContent(/node(s)?$/);
});

it('says how many nodes each configuration has on a cluster that mixes them', async () => {
  const clusters = seedClusters();
  const site1 = clusters[0].gpus!;
  clusters[0].gpus = {
    ...site1,
    total: site1.total + 4,
    nodeCount: site1.nodeCount + 1,
    configurations: [
      ...site1.configurations,
      { ...site1.configurations[0], product: 'NVIDIA-H100-80GB-HBM3', gpusPerNode: 4, nodeCount: 1 },
    ],
  };
  renderAt('/clusters/site1', new MockConsoleService(undefined, clusters));
  const lines = within(await screen.findByTestId('cluster-gpu-configurations')).getAllByRole('listitem');
  expect(lines.map((l) => l.textContent)).toEqual([
    'NVIDIA H200, 8 GPUs/node, 140.4 GiB each, 2 nodes',
    'NVIDIA H100-80GB-HBM3, 4 GPUs/node, 140.4 GiB each, 1 node',
  ]);
});

it('has no OpenShift version row for a cluster that is not OpenShift', async () => {
  // ACM sets version.openshift.io only on OpenShift; an EKS cluster has a Kubernetes version only.
  const eks: GridCluster = {
    ...bare(),
    name: 'eks-1',
    openshiftVersion: undefined,
    product: 'EKS',
    kubernetesVersion: 'v1.33.4',
  };
  renderAt('/clusters/eks-1', new MockConsoleService(undefined, [eks]));
  expect(await screen.findByRole('heading', { level: 1, name: 'eks-1' })).toBeVisible();
  const terms = within(details('Cluster'))
    .getAllByRole('term')
    .map((t) => t.textContent);
  expect(terms).not.toContain('OpenShift version');
  expect(terms).toContain('Kubernetes version');
  expect(details('Cluster')).toHaveTextContent('EKS');
});

it('words a MIG configuration by its profile', async () => {
  renderAt('/clusters/site3', new MockConsoleService());
  expect(await screen.findByTestId('cluster-gpu-configurations')).toHaveTextContent(
    'NVIDIA A100-SXM4-40GB, 8 GPUs/node, 19.5 GiB each, MIG 3g.20gb',
  );
  expect(screen.getByTestId('cluster-gpu-capacity')).toHaveTextContent('2 nodes, 16 GPUs');
});

/**
 * site3's A100 nodes under the GPU Operator's MIG strategy mixed: the device plugin advertises the
 * slices as nvidia.com/mig-<profile>, and nvidia.com/gpu counts only the GPUs without MIG.
 */
const mixedMIG = (schedulable: number) => {
  const clusters = seedClusters();
  const site3 = clusters[2];
  const sharing = { strategy: 'mig', replicas: 1, migCapable: true, migStrategy: 'mixed' };
  site3.capacity = { ...site3.capacity, 'nvidia.com/gpu': String(schedulable), 'nvidia.com/mig-3g.20gb': '32' };
  site3.gpuCapacity = schedulable;
  site3.gpus = {
    ...site3.gpus!,
    configurations: site3.gpus!.configurations.map((g) => ({ ...g, product: 'NVIDIA-A100-SXM4-40GB', sharing })),
    nodes: site3.gpus!.nodes.map((n) => ({ ...n, product: 'NVIDIA-A100-SXM4-40GB', sharing })),
  };
  return clusters;
};

it('says the schedulable GPUs leave out MIG slices under the mixed strategy', async () => {
  // Every GPU sliced: the hub counts none of them as nvidia.com/gpu.
  renderAt('/clusters/site3', new MockConsoleService(undefined, mixedMIG(0)));
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent(/^0 \(16 GPUs, MIG slices not counted\)$/);
});

it('says MIG slices are not counted under the mixed strategy even when no GPU is sliced', async () => {
  renderAt('/clusters/site3', new MockConsoleService(undefined, mixedMIG(16)));
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent(/^16 \(MIG slices not counted\)$/);
});

it('says nothing about MIG slices under the single strategy', async () => {
  renderAt('/clusters/site3', new MockConsoleService());
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent(/^16$/);
});

it('says when the hub counts GPUs but has no details for them', async () => {
  const clusters = seedClusters();
  delete clusters[0].gpus;
  renderAt('/clusters/site1', new MockConsoleService(undefined, clusters));
  expect(await screen.findByTestId('cluster-gpus-not-reported')).toHaveTextContent(
    "The hub reports 16 GPUs in this cluster's capacity, but no details for its GPU nodes",
  );
  expect(screen.queryByRole('grid', { name: 'GPU nodes' })).not.toBeInTheDocument();
});

it('seeds each cluster with its own copy of the GPU inventory', () => {
  const [first] = seedClusters().filter((c) => c.gpus);
  const again = seedClusters().find((c) => c.name === first.name)!;
  expect(again.gpus).toEqual(first.gpus);
  expect(again.gpus).not.toBe(first.gpus);
});

it('marks a GPU node that is not ready', async () => {
  const clusters = seedClusters();
  clusters[0].gpus!.nodes[1] = { ...clusters[0].gpus!.nodes[1], ready: false };
  renderAt('/clusters/site1', new MockConsoleService(undefined, clusters));
  const row = within(await screen.findByRole('grid', { name: 'GPU nodes' })).getByRole('row', { name: /gpu-h200-1/ });
  expect(row).toHaveTextContent('Not ready');
});

it('shows 0 GPUs when the hub reports capacity without any', async () => {
  const clusters = seedClusters();
  renderAt('/clusters/site4', new MockConsoleService(undefined, clusters));
  expect(await screen.findByTestId('cluster-gpus')).toHaveTextContent('0');
  expect(screen.getByTestId('cluster-gpus-not-reported')).toHaveTextContent('The hub reports no GPUs on this cluster.');
  expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Not added');
  // A cluster outside AI Grid has no role to miss.
  expect(screen.queryByTestId('missing-role')).not.toBeInTheDocument();
});

it('adds the cluster to AI Grid from its Actions', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters/site4', service);
  await user.click(await screen.findByRole('button', { name: 'Actions for site4' }));
  await user.click(screen.getByRole('menuitem', { name: 'Add to AI Grid' }));
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('site4 added to AI Grid')).toBeVisible();
  await waitFor(() => expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Provisioning'));
  expect(service.clusters.find((c) => c.name === 'site4')!.labels['ai-grid/role']).toBe('inference');
});

/** Adds site4 from the details page's Actions as an inference cluster. */
const addSite4 = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Actions for site4' }));
  await user.click(screen.getByRole('menuitem', { name: 'Add to AI Grid' }));
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
};

it('shows the added membership while the reload is still running', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  const getCluster = service.getCluster;
  renderAt('/clusters/site4', service);
  expect(await screen.findByTestId('cluster-membership')).toHaveTextContent('Not added');
  // Every load from now on never answers.
  service.getCluster = () => new Promise(() => {});
  await addSite4(user);
  expect(await screen.findByText('site4 added to AI Grid')).toBeVisible();
  expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Provisioning');
  expect(screen.getByLabelText('AI Grid membership')).toHaveTextContent('Inference');
  await user.click(screen.getByRole('button', { name: 'Actions for site4' }));
  expect(screen.getByRole('menuitem', { name: 'Remove from AI Grid' })).toBeVisible();
  service.getCluster = getCluster;
});

it('keeps one history entry for the page after a change, so Back leaves it', async () => {
  let navigate: NavigateFunction = () => undefined;
  const Navigator = () => {
    navigate = useNavigate();
    return null;
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/clusters', '/clusters/site4']} initialIndex={1}>
      <Navigator />
      <TestApp service={new MockConsoleService()} />
    </MemoryRouter>,
  );
  await addSite4(user);
  expect(await screen.findByText('site4 added to AI Grid')).toBeVisible();
  await act(async () => navigate(-1));
  expect(await screen.findByRole('heading', { level: 1, name: 'Clusters' })).toBeVisible();
});

it('keeps the added membership when the reload fails', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters/site4', service);
  expect(await screen.findByTestId('cluster-membership')).toHaveTextContent('Not added');
  service.getCluster = () => Promise.reject(new ServiceError(503, 'the hub is unavailable'));
  await addSite4(user);
  expect(await screen.findByText('Showing the last loaded cluster')).toBeVisible();
  expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Provisioning');
});

it('removes the cluster from AI Grid', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters/site1', service);
  await user.click(await screen.findByRole('button', { name: 'Actions for site1' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove from AI Grid' }));
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.type(within(modal).getByRole('textbox', { name: 'Type site1 to confirm:' }), 'site1');
  await user.click(within(modal).getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('site1 removed from AI Grid')).toBeVisible();
  expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Not added');
  expect(service.clusters.find((c) => c.name === 'site1')!.labels['ai-grid/enabled']).toBeUndefined();
});

it('keeps the modal open with the error when the change fails', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  service.removeClusterFromGrid = () => Promise.reject(new ServiceError(403, 'the hub refused the change'));
  renderAt('/clusters/site1', service);
  await user.click(await screen.findByRole('button', { name: 'Actions for site1' }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove from AI Grid' }));
  const modal = await screen.findByTestId('cluster-membership-modal');
  await user.type(within(modal).getByRole('textbox', { name: 'Type site1 to confirm:' }), 'site1');
  await user.click(within(modal).getByRole('button', { name: 'Remove' }));
  expect(await within(modal).findByText(/the hub refused the change/)).toBeVisible();
  expect(screen.getByTestId('cluster-membership')).toHaveTextContent('Provisioned');
});

/** Opens Add to AI Grid for site4 from its page, typed us-east and Inference, and leaves the dialog open. */
const openAddSite4 = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Actions for site4' }));
  await user.click(screen.getByRole('menuitem', { name: 'Add to AI Grid' }));
  const modal = await screen.findByTestId('cluster-membership-modal');
  const location = within(modal).getByRole('textbox', { name: 'Location' });
  await user.clear(location);
  await user.paste('us-east');
  await user.click(within(modal).getByRole('combobox', { name: 'Role' }));
  await user.click(await screen.findByRole('option', { name: /Inference/ }));
  return modal;
};

it('loads the cluster again into the open dialog after a conflict, so the next Add works', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters/site4', service);
  const modal = await openAddSite4(user);
  // Someone else changes another label while the dialog is open.
  const index = service.clusters.findIndex((c) => c.name === 'site4');
  const before = service.clusters[index];
  service.clusters[index] = {
    ...before,
    labels: { ...before.labels, team: 'blue' },
    resourceVersion: String(Number(before.resourceVersion) + 5),
  };
  const enroll = vi.spyOn(service, 'enrollCluster');

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(
    await within(modal).findByText('This cluster changed since you opened this dialog. Check it and try again.'),
  ).toBeVisible();
  // The user's choices stand when the other change didn't touch them.
  expect(within(modal).getByRole('textbox', { name: 'Location' })).toHaveValue('us-east');

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(await screen.findByText('site4 added to AI Grid')).toBeVisible();
  expect(enroll).toHaveBeenCalledTimes(2);
  expect(enroll.mock.calls[1][0].resourceVersion).toBe(String(Number(before.resourceVersion) + 5));
  expect(service.clusters[index].labels).toMatchObject({
    team: 'blue',
    'ai-grid/enabled': 'true',
    location: 'us-east',
  });
});

it('shows the location and role someone else set meanwhile instead of sending the dialog’s over them', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  renderAt('/clusters/site4', service);
  const modal = await openAddSite4(user);
  const index = service.clusters.findIndex((c) => c.name === 'site4');
  const before = service.clusters[index];
  service.clusters[index] = {
    ...before,
    location: 'eu-west',
    labels: { ...before.labels, location: 'eu-west', 'ai-grid/role': 'ingress' },
    resourceVersion: String(Number(before.resourceVersion) + 1),
  };

  await user.click(within(modal).getByRole('button', { name: 'Add to AI Grid' }));
  expect(
    await within(modal).findByText(
      'Someone else changed the location or role of this cluster since you opened this dialog. The dialog now shows theirs; check them and try again.',
    ),
  ).toBeVisible();
  expect(within(modal).getByRole('textbox', { name: 'Location' })).toHaveValue('eu-west');
  expect(within(modal).getByRole('combobox', { name: 'Role' })).toHaveValue('MaaS (ingress)');
});

it('offers Retry when the cluster could not be loaded', async () => {
  const user = userEvent.setup();
  const service = new MockConsoleService();
  const getCluster = service.getCluster;
  service.getCluster = () => Promise.reject(new ServiceError(503, 'the hub is unavailable'));
  renderAt('/clusters/site1', service);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  service.getCluster = getCluster;
  await user.click(retry);
  expect(await screen.findByTestId('cluster-membership')).toHaveTextContent('Provisioned');
});

it('says when the hub has no such cluster', async () => {
  renderAt('/clusters/nope', new MockConsoleService());
  expect(await screen.findByRole('heading', { name: 'Cluster not found' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Go to Clusters' })).toHaveAttribute('href', '/clusters');
});

it('says where the map puts the cluster, from its cloud region, with how to set it', async () => {
  const transport = fakeClients({
    clusters: {
      get: async () => ({
        object: create(ManagedClusterSchema, {
          id: 'in-region',
          metadata: { name: 'in-region' },
          status: {
            location: {
              latitude: 40.42,
              longitude: -82.91,
              source: ManagedClusterLocationSource.CLOUD_REGION,
              region: 'us-east-2',
            },
          },
        }),
      }),
    },
  }).transport;
  renderAt('/clusters/in-region', new MockConsoleService(), transport);
  const position = await screen.findByTestId('cluster-map-position');
  expect(position).toHaveTextContent('40.42, -82.91 from the cloud region');
  expect(within(position).getByRole('link', { name: "How to set a cluster's position" })).toHaveAttribute(
    'href',
    'https://github.com/ai-grid-cloud/ai-grid-provider-backend/blob/main/README.md#cluster-locations',
  );
  // The cloud region is the Region, not a data center.
  expect(screen.queryByTestId('cluster-data-center')).not.toBeInTheDocument();
  expect(screen.getByText('us-east-2')).toBeVisible();
});

it('says what to fix when the coordinate annotations are wrong', async () => {
  const transport = fakeClients({
    clusters: {
      get: async () => ({
        object: create(ManagedClusterSchema, {
          id: 'wrong',
          metadata: { name: 'wrong' },
          status: {
            location: {
              source: ManagedClusterLocationSource.NONE,
              problem: 'ai-grid/latitude "39,96" is not a decimal number of degrees',
              region: 'us-east-2',
            },
          },
        }),
      }),
    },
  }).transport;
  renderAt('/clusters/wrong', new MockConsoleService(), transport);
  expect(await screen.findByTestId('cluster-map-position')).toHaveTextContent(
    'Not on the map: ai-grid/latitude "39,96" is not a decimal number of degrees',
  );
});
