import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ADDON_LABEL_PREFIX, MockConsoleService, deriveStatus, seedClusters } from '../api/MockConsoleService';
import { ServiceError } from '../api/ConsoleService';
import type { ClusterCondition } from '../api/types';
import { ClustersPage } from '../pages/ClustersPage';

const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const admin = (service = new MockConsoleService()) => <ClustersPage service={service} canEdit />;
const actionsToggle = (name: string) => screen.getByRole('button', { name: `Actions for ${name}` });
/** Opens the row's kebab and clicks the named action. */
const runAction = async (name: string, item: 'Enrol in grid' | 'Remove from grid') => {
  fireEvent.click(actionsToggle(name));
  const menuItem = await screen.findByRole('menuitem', { name: item });
  await act(async () => {
    fireEvent.click(menuItem);
  });
};

describe('ClustersPage', () => {
  it('shows a status label per state with the ACM console colours', async () => {
    render(admin());
    await screen.findByText('local-cluster');

    // PatternFly renders grey as the default label with no colour modifier.
    const expectStatus = (name: string, text: string, color: string) => {
      const label = screen.getByTestId(`status-${name}`);
      expect(label).toHaveTextContent(text);
      if (color === 'grey') {
        expect(label.className).not.toMatch(/pf-m-(green|red|orange|blue)/);
      } else {
        expect(label.className).toContain(`pf-m-${color}`);
      }
    };
    expectStatus('site-paris-1', 'Ready', 'green');
    expectStatus('site-ashburn-1', 'Offline', 'red');
    expectStatus('site-madrid-1', 'Unknown', 'orange');
    expectStatus('site-berlin-1', 'Importing', 'blue');
    expectStatus('site-oslo-1', 'Pending import', 'blue');
    expectStatus('site-dublin-1', 'Import failed', 'red');
    expectStatus('site-lisbon-1', 'Not accepted', 'grey');
    expectStatus('edge-lyon-2', 'Detaching', 'grey');
    expect(screen.getByTestId('status-site-madrid-1')).toHaveAttribute('title', 'Registration agent stopped updating its lease.');
  });

  it('shows GPU capacity and the console link from the claim', async () => {
    render(admin());
    await screen.findByText('site-paris-1');
    const paris = row('site-paris-1');
    expect(within(paris).getByText('16')).toBeInTheDocument();
    expect(within(paris).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      'https://console-openshift-console.apps.site-paris-1.example.com',
    );
    const berlin = row('site-berlin-1');
    expect(within(berlin).queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('enrols a cluster through updateCluster and refreshes the list', async () => {
    const service = new MockConsoleService();
    const spy = vi.spyOn(service, 'updateCluster');
    render(admin(service));
    await screen.findByText('site-frankfurt-1');

    expect(within(row('site-frankfurt-1')).getByText('Not enrolled')).toBeInTheDocument();
    await runAction('site-frankfurt-1', 'Enrol in grid');

    await waitFor(() => expect(within(row('site-frankfurt-1')).getByText('Member')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith('site-frankfurt-1', { aiGridEnabled: true });
    fireEvent.click(actionsToggle('site-frankfurt-1'));
    expect(await screen.findByRole('menuitem', { name: 'Remove from grid' })).toBeInTheDocument();
    expect(service.clusters.find((c) => c.name === 'site-frankfurt-1')?.labels['ai-grid/enabled']).toBe('true');
  });

  it('removes a cluster from the grid', async () => {
    const service = new MockConsoleService();
    render(admin(service));
    await screen.findByText('site-paris-1');
    await runAction('site-paris-1', 'Remove from grid');
    await waitFor(() => expect(within(row('site-paris-1')).getByText('Not enrolled')).toBeInTheDocument());
  });

  it('shows the backend error when the update is rejected', async () => {
    const service = new MockConsoleService();
    service.updateCluster = async () => {
      throw new ServiceError(409, "object with identifier 'site-frankfurt-1' has resource version 5, the request carries \"4\"");
    };
    render(admin(service));
    await screen.findByText('site-frankfurt-1');
    await runAction('site-frankfurt-1', 'Enrol in grid');

    expect(await screen.findByText('Cluster site-frankfurt-1 could not be updated')).toBeInTheDocument();
    expect(screen.getByText(/resource version 5/)).toBeInTheDocument();
    expect(within(row('site-frankfurt-1')).getByText('Not enrolled')).toBeInTheDocument();
    await waitFor(() => expect(actionsToggle('site-frankfurt-1')).toBeEnabled());
  });

  it('does not offer enrolment on a detaching cluster', async () => {
    render(admin());
    await screen.findByText('edge-lyon-2');
    expect(actionsToggle('edge-lyon-2')).toBeDisabled();
    expect(actionsToggle('site-frankfurt-1')).toBeEnabled();
  });

  it('hides the actions from a user who is not a provider admin', async () => {
    const service = new MockConsoleService({ username: 'viewer', groups: [], isProviderAdmin: false });
    render(<ClustersPage service={service} canEdit={false} />);
    await screen.findByText('site-frankfurt-1');
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    // The service enforces it too, like the fake backend does for a denied token.
    await expect(service.updateCluster('site-frankfurt-1', { aiGridEnabled: true })).rejects.toMatchObject({ status: 403 });
  });

  it('only disables the row being updated', async () => {
    const service = new MockConsoleService();
    let release: () => void = () => undefined;
    service.updateCluster = () => new Promise((resolve) => (release = () => resolve(service.clusters[0])));
    render(admin(service));
    await screen.findByText('site-frankfurt-1');
    await runAction('site-frankfurt-1', 'Enrol in grid');
    expect(actionsToggle('site-frankfurt-1')).toBeDisabled();
    expect(actionsToggle('site-paris-1')).toBeEnabled();
    release();
    await waitFor(() => expect(actionsToggle('site-frankfurt-1')).toBeEnabled());
  });

  it('keeps every pending row disabled until its own update settles', async () => {
    const service = new MockConsoleService();
    const pending: Array<() => void> = [];
    service.updateCluster = (name) =>
      new Promise((resolve) => pending.push(() => resolve(service.clusters.find((c) => c.name === name)!)));
    render(admin(service));
    await screen.findByText('site-frankfurt-1');
    await runAction('site-frankfurt-1', 'Enrol in grid');
    await runAction('site-paris-1', 'Remove from grid');
    expect(pending).toHaveLength(2);
    expect(actionsToggle('site-frankfurt-1')).toBeDisabled();
    expect(actionsToggle('site-paris-1')).toBeDisabled();
    expect(actionsToggle('site-madrid-1')).toBeEnabled();

    // Paris, started second, finishes first: only its row is released.
    await act(async () => {
      pending[1]();
    });
    await waitFor(() => expect(actionsToggle('site-paris-1')).toBeEnabled());
    expect(actionsToggle('site-frankfurt-1')).toBeDisabled();

    await act(async () => {
      pending[0]();
    });
    await waitFor(() => expect(actionsToggle('site-frankfurt-1')).toBeEnabled());
  });
});

/**
 * The browser mock must not drift from the fake backend's fixture: same
 * clusters, same derived states, GPUs, add-ons and console URLs.
 */
describe('seedClusters mirrors mock/fixtures/managedclusters.json', () => {
  type FixtureCondition = { type: string; status?: string; reason?: string; message?: string; lastTransitionTime: string };
  type Fixture = {
    name: string;
    hubAcceptsClient?: boolean;
    labels: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
    resourceVersion: string;
    status?: { capacity?: Record<string, string>; clusterClaims?: { name: string; value: string }[]; conditions?: FixtureCondition[] };
  };
  const fixture = JSON.parse(readFileSync(join(process.cwd(), '..', 'mock', 'fixtures', 'managedclusters.json'), 'utf8')) as { clusters: Fixture[] };
  const protoStatus = (s?: string): ClusterCondition['status'] => (s === 'CONDITION_STATUS_TRUE' ? 'True' : s === 'CONDITION_STATUS_FALSE' ? 'False' : 'Unknown');

  it('has the same clusters with the same state, GPUs, add-ons, console URL and annotations', () => {
    const seeds = new Map(seedClusters().map((c) => [c.name, c]));
    expect([...seeds.keys()].sort()).toEqual(fixture.clusters.map((c) => c.name).sort());
    for (const f of fixture.clusters) {
      const s = seeds.get(f.name)!;
      const conditions = (f.status?.conditions ?? []).map((c) => ({ ...c, status: protoStatus(c.status) }) as ClusterCondition);
      expect(s.status, f.name).toBe(deriveStatus(conditions, f.deletionTimestamp !== undefined));
      expect(s.conditions.map((c) => [c.type, c.status, c.reason, c.message]), f.name).toEqual(conditions.map((c) => [c.type, c.status, c.reason, c.message]));
      expect(s.gpuCapacity, f.name).toBe(Number(f.status?.capacity?.['nvidia.com/gpu'] ?? 0));
      expect(s.labels, f.name).toEqual(f.labels);
      expect(s.annotations, f.name).toEqual(f.annotations ?? {});
      expect(s.hubAcceptsClient, f.name).toBe(f.hubAcceptsClient ?? false);
      expect(s.resourceVersion, f.name).toBe(f.resourceVersion);
      const claim = (name: string) => f.status?.clusterClaims?.find((c) => c.name === name)?.value;
      expect(s.consoleUrl, f.name).toBe(claim('consoleurl.cluster.open-cluster-management.io'));
      expect(s.platform, f.name).toBe(claim('platform.open-cluster-management.io'));
      expect(s.product, f.name).toBe(claim('product.open-cluster-management.io'));
      const addonLabels = Object.keys(f.labels).filter((k) => k.startsWith(ADDON_LABEL_PREFIX)).length;
      expect(Object.keys(s.addons).length, f.name).toBe(addonLabels);
    }
  });
});

describe('MockConsoleService', () => {
  it('derives the status like the fake backend', () => {
    const accepted = { type: 'HubAcceptedManagedCluster', status: 'True' as const, lastTransitionTime: 't' };
    const joined = { type: 'ManagedClusterJoined', status: 'True' as const, lastTransitionTime: 't' };
    expect(deriveStatus([])).toBeUndefined();
    expect(deriveStatus([joined], true)).toBe('detaching');
    expect(deriveStatus([{ ...accepted, status: 'False' }, joined])).toBe('notaccepted');
    expect(deriveStatus([accepted])).toBe('pendingimport');
    expect(deriveStatus([accepted, { type: 'ManagedClusterImportSucceeded', status: 'False', reason: 'ManagedClusterImporting', lastTransitionTime: 't' }])).toBe('importing');
    expect(deriveStatus([accepted, { type: 'ManagedClusterImportSucceeded', status: 'False', reason: 'ManagedClusterImportFailed', lastTransitionTime: 't' }])).toBe('importfailed');
    expect(deriveStatus([accepted, joined, { type: 'ManagedClusterConditionAvailable', status: 'True', lastTransitionTime: 't' }])).toBe('ready');
    expect(deriveStatus([accepted, joined, { type: 'ManagedClusterConditionAvailable', status: 'False', lastTransitionTime: 't' }])).toBe('offline');
    expect(deriveStatus([accepted, joined, { type: 'ManagedClusterConditionAvailable', status: 'Unknown', lastTransitionTime: 't' }])).toBe('unknown');
    expect(deriveStatus([accepted, joined])).toBe('unknown');
  });

  it('answers 404 for an unknown cluster and 422 for a bad coordinate', async () => {
    const service = new MockConsoleService();
    await expect(service.getCluster('nope')).rejects.toMatchObject({ status: 404 });
    await expect(service.updateCluster('site-paris-1', { latitude: 91 })).rejects.toMatchObject({ status: 422 });
    await expect(service.updateCluster('site-paris-1', { longitude: -181 })).rejects.toMatchObject({ status: 422 });
    const updated = await service.updateCluster('site-paris-1', { siteName: '', latitude: null, location: 'lyon' });
    expect(updated.siteName).toBeUndefined();
    expect(updated.latitude).toBeUndefined();
    expect(updated.location).toBe('lyon');
    expect(updated.resourceVersion).toBe('48811205');
  });

  it('does not write on an empty patch, like the BFF', async () => {
    const service = new MockConsoleService();
    const before = await service.getCluster('site-paris-1');
    const after = await service.updateCluster('site-paris-1', {});
    expect(after).toEqual(before);
    expect(after.resourceVersion).toBe('48811204');
    // A field that is present is a write even when the value is unchanged, as the BFF sends the map back.
    const written = await service.updateCluster('site-paris-1', { location: 'paris' });
    expect(written.resourceVersion).toBe('48811205');
  });
});
