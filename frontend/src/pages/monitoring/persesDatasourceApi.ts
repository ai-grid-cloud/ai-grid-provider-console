// The Perses DatasourceApi over the BFF's relay, after odh-dashboard's OdhDatasourceApi
// (packages/observability). The dashboard components look datasources up here and send their
// queries to the URLs buildProxyUrl returns; the relay forwards both to the hub's Perses with the
// caller's own token, so Perses decides what the caller may read, within the one project the relay
// passes and the global datasources.
import type {
  BuildDatasourceProxyUrlParams,
  DatasourceApi,
  DatasourceResource,
  DatasourceSelector,
  GlobalDatasourceResource,
} from '@perses-dev/client';
import { PERSES_API } from '../../api/monitoring';

const get = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  if (!res.ok) {
    // With the status, as Perses's own fetch errors have it, so a 401 can ask after the session
    // (watchUnauthorized).
    throw Object.assign(new Error(`Perses answered ${res.status} for ${url}`), { status: res.status });
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

  /**
   * The relay path of a project's or a global datasource's proxy. A datasource a dashboard defines
   * has none: Perses would send the caller's token on to whatever server its author chose, so the
   * relay refuses it (docs/plan/bff-api.md, "The Perses relay"). Perses calls this inside its async
   * datasource lookup, so the throw becomes the panel's query error, shown in the panel. Without a
   * name, Perses asks for its unsaved-datasource proxy (to test a datasource before saving it),
   * which the relay doesn't serve either.
   */
  buildProxyUrl = ({ project, dashboard, name }: BuildDatasourceProxyUrlParams): string => {
    if (!name) {
      throw new Error('The console queries only saved datasources.');
    }
    if (dashboard) {
      throw new Error(
        `The datasource ${name} is defined in the dashboard itself; the console queries only its project's and the global datasources.`,
      );
    }
    const path = project
      ? `projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(name)}`
      : `globaldatasources/${encodeURIComponent(name)}`;
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
