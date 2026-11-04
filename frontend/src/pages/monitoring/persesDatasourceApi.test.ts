import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayDatasourceApi } from './persesDatasourceApi';

const datasource = (name: string, isDefault = false) => ({
  kind: 'Datasource',
  metadata: { name, project: 'p' },
  spec: { default: isDefault, plugin: { kind: 'PrometheusDatasource', spec: {} } },
});

/** Answers every fetch with `body` (a fresh Response each time) and records the URLs. */
const answer = (body: unknown, status = 200) => {
  const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
};

describe('RelayDatasourceApi', () => {
  // A fresh API per test: each has its own cache.
  let api = new RelayDatasourceApi();
  beforeEach(() => {
    api = new RelayDatasourceApi();
  });

  it("builds the relay's proxy paths, encoding each name", () => {
    expect(api.buildProxyUrl({ project: 'open-cluster-management-observability', name: 'thanos' })).toBe(
      '/perses/api/proxy/projects/open-cluster-management-observability/datasources/thanos',
    );
    expect(api.buildProxyUrl({ project: 'p', name: 'a/b' })).toBe('/perses/api/proxy/projects/p/datasources/a%2Fb');
    expect(api.buildProxyUrl({ name: 'global' })).toBe('/perses/api/proxy/globaldatasources/global');
  });

  it("refuses a datasource a dashboard defines, which the relay doesn't query", () => {
    expect(() => api.buildProxyUrl({ project: 'p', dashboard: 'd', name: 'thanos' })).toThrow(
      /defined in the dashboard/,
    );
  });

  it("refuses an unsaved datasource, whose proxy the relay doesn't serve", () => {
    expect(() => api.buildProxyUrl({ project: 'p' })).toThrow(/only saved datasources/);
  });

  it("finds a named datasource, or the project's default one of the kind", async () => {
    const fetchFn = answer([datasource('a'), datasource('b', true)]);
    expect((await api.getDatasource('p', { kind: 'PrometheusDatasource', name: 'a' }))?.metadata.name).toBe('a');
    expect((await api.getDatasource('p', { kind: 'PrometheusDatasource' }))?.metadata.name).toBe('b');
    expect(await api.getDatasource('p', { kind: 'PrometheusDatasource', name: 'missing' })).toBeUndefined();
    expect(fetchFn.mock.calls[0][0]).toBe('/perses/api/api/v1/projects/p/datasources?kind=PrometheusDatasource');
  });

  it('reads global datasources the same way', async () => {
    const fetchFn = answer([datasource('g', true)]);
    expect((await api.getGlobalDatasource({ kind: 'PrometheusDatasource' }))?.metadata.name).toBe('g');
    expect(fetchFn.mock.calls[0][0]).toBe('/perses/api/api/v1/globaldatasources?kind=PrometheusDatasource');
  });

  it('lists a project once for many lookups, and again after five minutes', async () => {
    let now = 0;
    api = new RelayDatasourceApi([], () => now);
    const fetchFn = answer([datasource('a'), datasource('b', true)]);
    await Promise.all([api.getDatasource('p', { kind: 'K', name: 'a' }), api.getDatasource('p', { kind: 'K' })]);
    await api.getDatasource('p', { kind: 'K', name: 'b' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 5 * 60 * 1000;
    await api.getDatasource('p', { kind: 'K' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a failed list", async () => {
    answer({ message: 'unavailable' }, 503);
    await expect(api.listDatasources('p')).rejects.toThrow('Perses answered 503');
    const fetchFn = answer([datasource('a', true)]);
    expect((await api.getDatasource('p', { kind: 'K' }))?.metadata.name).toBe('a');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fails on an answer that is not 2xx', async () => {
    answer({ message: 'forbidden' }, 403);
    await expect(api.listDatasources('p')).rejects.toThrow('Perses answered 403');
  });

  describe('in a project the relay reads only by name', () => {
    const acm = {
      project: 'acm',
      dashboards: [{ name: 'acm-clusters-overview' }],
      datasources: ['rbac-query-proxy-datasource', 'gone'],
    };
    const proxy = {
      ...datasource('rbac-query-proxy-datasource'),
      metadata: { name: 'rbac-query-proxy-datasource', project: 'acm' },
    };
    /** Answers the listed datasource, 404 for any other URL. */
    const byURL = () => {
      const fetchFn = vi.fn<typeof fetch>((url) =>
        Promise.resolve(
          String(url).endsWith('/projects/acm/datasources/rbac-query-proxy-datasource')
            ? new Response(JSON.stringify(proxy))
            : new Response('{}', { status: 404 }),
        ),
      );
      vi.stubGlobal('fetch', fetchFn);
      return fetchFn;
    };
    beforeEach(() => {
      api = new RelayDatasourceApi([acm]);
    });

    it('reads a named datasource by itself, never the list', async () => {
      const fetchFn = byURL();
      expect(
        (await api.getDatasource('acm', { kind: 'PrometheusDatasource', name: 'rbac-query-proxy-datasource' }))
          ?.metadata.name,
      ).toBe('rbac-query-proxy-datasource');
      expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
        '/perses/api/api/v1/projects/acm/datasources/rbac-query-proxy-datasource',
      ]);
    });

    it("asks for nothing the relay doesn't pass, and finds no datasource of another kind", async () => {
      const fetchFn = byURL();
      expect(await api.getDatasource('acm', { kind: 'PrometheusDatasource', name: 'other' })).toBeUndefined();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(
        await api.getDatasource('acm', { kind: 'LokiDatasource', name: 'rbac-query-proxy-datasource' }),
      ).toBeUndefined();
    });

    it('lists the passed datasources that are there, of the kind asked for', async () => {
      byURL();
      expect((await api.listDatasources('acm', 'PrometheusDatasource')).map((d) => d.metadata.name)).toEqual([
        'rbac-query-proxy-datasource',
      ]);
      expect(await api.listDatasources('acm', 'LokiDatasource')).toEqual([]);
    });

    it("finds the project's default datasource among the passed ones when the selector names none", async () => {
      const fallback = { ...proxy, spec: { ...proxy.spec, default: true } };
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(fallback)))),
      );
      api = new RelayDatasourceApi([{ ...acm, datasources: ['rbac-query-proxy-datasource'] }]);
      expect((await api.getDatasource('acm', { kind: 'PrometheusDatasource' }))?.metadata.name).toBe(
        'rbac-query-proxy-datasource',
      );
    });

    it('asks once for a passed datasource that is not there', async () => {
      const fetchFn = byURL();
      expect(await api.getDatasource('acm', { kind: 'PrometheusDatasource', name: 'gone' })).toBeUndefined();
      expect(await api.getDatasource('acm', { kind: 'PrometheusDatasource', name: 'gone' })).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('still lists the main project as before', async () => {
      const fetchFn = answer([datasource('a', true)]);
      expect((await api.getDatasource('p', { kind: 'K' }))?.metadata.name).toBe('a');
      expect(fetchFn.mock.calls[0][0]).toBe('/perses/api/api/v1/projects/p/datasources?kind=K');
    });
  });
});
