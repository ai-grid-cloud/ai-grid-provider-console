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

  it('lists tenants with the page meta and the query', async () => {
    const tenant = { id: '1', name: 't', alias: 't', enabled: true, description: '', domains: [], domainDetails: [], attributes: {} };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: [tenant], meta: { size: 1, total: 7, offset: 2, limit: 1 } }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.listTenants({ offset: 2, limit: 1, search: 'a b' })).resolves.toEqual({ items: [tenant], meta: { size: 1, total: 7, offset: 2, limit: 1 } });
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/tenants?offset=2&limit=1&search=a+b', expect.objectContaining({ method: 'GET' }));

    // A list from a BFF that sends no meta still yields a page; a blank search is dropped.
    fetchFn.mockResolvedValue(jsonResponse(200, { data: [tenant] }));
    await expect(service.listTenants({ search: '   ' })).resolves.toEqual({ items: [tenant], meta: { size: 1, total: 1, offset: 0, limit: undefined } });
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/tenants', expect.objectContaining({ method: 'GET' }));
  });

  it('gets, creates, updates and deletes a tenant', async () => {
    const tenant = { id: 'abc', name: 't', alias: 't', enabled: true, description: '', domains: [], domainDetails: [], attributes: {} };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: tenant }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.getTenant('a/b')).resolves.toEqual(tenant);
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/tenants/a%2Fb', expect.objectContaining({ method: 'GET' }));

    fetchFn.mockResolvedValue(jsonResponse(201, { data: tenant }));
    await expect(service.createTenant({ name: 't', domains: ['t.example.com'] })).resolves.toEqual(tenant);
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/tenants',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 't', domains: ['t.example.com'] }) }),
    );

    fetchFn.mockResolvedValue(jsonResponse(200, { data: { ...tenant, enabled: false } }));
    await expect(service.updateTenant('abc', { enabled: false })).resolves.toMatchObject({ enabled: false });
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/tenants/abc', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }));

    fetchFn.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(service.deleteTenant('abc')).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/tenants/abc', expect.objectContaining({ method: 'DELETE' }));

    fetchFn.mockResolvedValue(jsonResponse(409, { error: { code: '409', message: 'A organization with the same name already exists.' } }));
    await expect(service.createTenant({ name: 't' })).rejects.toMatchObject({ status: 409, message: 'A organization with the same name already exists.' });
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
