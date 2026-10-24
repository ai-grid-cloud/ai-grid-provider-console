// The Perses DatasourceApi over the BFF's relay, after odh-dashboard's OdhDatasourceApi
// (packages/observability). The dashboard components look datasources up here and send their
// queries to the URLs buildProxyUrl returns; the relay forwards both to the hub's Perses with the
// caller's own token, so Perses decides what the caller may read.
import type {
  DatasourceApi,
  DatasourceResource,
  DatasourceSelector,
  GlobalDatasourceResource,
} from '@perses-dev/client';
import { PERSES_API } from '../../api/monitoring';

const get = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`Perses answered ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
};

const kindQuery = (pluginKind?: string) => (pluginKind ? `?kind=${encodeURIComponent(pluginKind)}` : '');

/** How long a datasource list is reused, as odh-dashboard's CachedDatasourceAPI does. */
const CACHE_MS = 5 * 60 * 1000;

export class RelayDatasourceApi implements DatasourceApi {
  // Every panel looks its datasource up before each query, so without a cache a dashboard's
  // refresh lists the same datasources once per panel, one after another (seconds on a dashboard
  // with a few dozen panels). A pending list is shared; a failed one is dropped, not reused.
  private readonly cache = new Map<string, { at: number; list: Promise<unknown> }>();

  constructor(private readonly now: () => number = Date.now) {}

  private cached<T>(url: string): Promise<T> {
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < CACHE_MS) {
      return hit.list as Promise<T>;
    }
    const list = get<T>(url).catch((err: unknown) => {
      this.cache.delete(url);
      throw err;
    });
    this.cache.set(url, { at: this.now(), list });
    return list;
  }

  buildProxyUrl = ({ project, dashboard, name }: { project?: string; dashboard?: string; name: string }): string => {
    let path = `${project || dashboard ? 'datasources' : 'globaldatasources'}/${encodeURIComponent(name)}`;
    if (dashboard) path = `dashboards/${encodeURIComponent(dashboard)}/${path}`;
    if (project) path = `projects/${encodeURIComponent(project)}/${path}`;
    return `${PERSES_API}/proxy/${path}`;
  };

  listDatasources = (project: string, pluginKind?: string): Promise<DatasourceResource[]> =>
    this.cached(`${PERSES_API}/api/v1/projects/${encodeURIComponent(project)}/datasources${kindQuery(pluginKind)}`);

  listGlobalDatasources = (pluginKind?: string): Promise<GlobalDatasourceResource[]> =>
    this.cached(`${PERSES_API}/api/v1/globaldatasources${kindQuery(pluginKind)}`);

  /** The named datasource, or the project's default one of the kind when the selector names none. */
  getDatasource = async (project: string, selector: DatasourceSelector): Promise<DatasourceResource | undefined> =>
    (await this.listDatasources(project, selector.kind)).find((d) =>
      selector.name ? d.metadata.name === selector.name : d.spec.default,
    );

  getGlobalDatasource = async (selector: DatasourceSelector): Promise<GlobalDatasourceResource | undefined> =>
    (await this.listGlobalDatasources(selector.kind)).find((d) =>
      selector.name ? d.metadata.name === selector.name : d.spec.default,
    );
}
