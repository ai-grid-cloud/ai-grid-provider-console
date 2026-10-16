import { HttpConsoleService } from '../api/HttpConsoleService';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('HttpConsoleService', () => {
  it('unwraps the data envelope', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: { username: 'u', groups: [], isProviderAdmin: true } }));
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

  it('gets one cluster by name', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: { name: 'site-paris-1', status: 'ready' } }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.getCluster('site-paris-1')).resolves.toMatchObject({ name: 'site-paris-1', status: 'ready' });
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/clusters/site-paris-1', expect.objectContaining({ method: 'GET' }));
  });

  it('patches a cluster with a JSON body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: { name: 'site-paris-1', aiGridEnabled: true } }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.updateCluster('site-paris-1', { aiGridEnabled: true, latitude: null })).resolves.toMatchObject({ aiGridEnabled: true });
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/clusters/site-paris-1',
      expect.objectContaining({
        method: 'PATCH',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiGridEnabled: true, latitude: null }),
      }),
    );
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
});
