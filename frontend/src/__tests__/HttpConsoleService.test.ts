import { toGridCluster } from '../api/adapters';
import { HttpConsoleService } from '../api/HttpConsoleService';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('HttpConsoleService', () => {
  it('unwraps the data envelope', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { username: 'u', groups: [], isProviderAdmin: true } }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.getUser()).resolves.toEqual({ username: 'u', groups: [], isProviderAdmin: true });
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/user', expect.objectContaining({ method: 'GET' }));
  });

  it('lists tenants', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: '1', name: 't', domains: [] }] }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.listTenants()).resolves.toEqual([{ id: '1', name: 't', domains: [] }]);
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/tenants', expect.objectContaining({ method: 'GET' }));
  });

  it('enrolls a cluster with a JSON PATCH of its whole labels map at the version it was read', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { name: 'site4', aiGridEnabled: true, status: 'ready' } }));
    const read = toGridCluster({
      name: 'site4',
      aiGridEnabled: false,
      provisioned: false,
      status: 'ready',
      resourceVersion: '7',
      labels: { location: 'sydney' },
    });
    await expect(new HttpConsoleService(fetchFn).enrollCluster(read)).resolves.toMatchObject({
      aiGridEnabled: true,
      status: 'Ready',
    });
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/clusters/site4',
      expect.objectContaining({
        method: 'PATCH',
        body: '{"labels":{"location":"sydney","ai-grid/enabled":"true"}}',
        headers: expect.objectContaining({ 'Content-Type': 'application/json', 'If-Match': '"7"' }),
      }),
    );
  });

  it('requests the full cluster list without paging parameters and maps PR 12 clusters', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [{ name: 'site-berlin-1', aiGridEnabled: false, provisioned: false, status: 'importing' }],
        meta: { total: 1 },
      }),
    );
    await expect(new HttpConsoleService(fetchFn).listClusters()).resolves.toEqual([
      expect.objectContaining({
        name: 'site-berlin-1',
        status: 'Unknown',
        state: 'Importing',
        provisioningStatus: 'Not provisioned',
        labels: {},
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/clusters', expect.objectContaining({ method: 'GET' }));
  });

  it('surfaces the BFF error message and status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: '401', message: 'missing header' } }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.getUser()).rejects.toMatchObject({ status: 401, message: 'missing header' });
  });

  it('maps network failures to status 0', async () => {
    const service = new HttpConsoleService(vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(service.listClusters()).rejects.toMatchObject({ status: 0 });
  });

  it('returns undefined for 204', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(new HttpConsoleService(fetchFn).request('DELETE', '/tenants/x')).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/tenants/x', expect.objectContaining({ method: 'DELETE' }));
  });

  it('carries field errors', async () => {
    const body = {
      error: {
        code: '422',
        message: 'The organization is invalid.',
        fieldErrors: { name: 'Use lowercase letters, numbers, and hyphens.' },
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 422 }));
    await expect(new HttpConsoleService(fetchFn).request('POST', '/tenants', { body: {} })).rejects.toMatchObject({
      status: 422,
      fieldErrors: { name: 'Use lowercase letters, numbers, and hyphens.' },
    });
  });
});
