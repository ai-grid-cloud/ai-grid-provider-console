// The Perses DatasourceApi over the BFF's relay, after odh-dashboard's OdhDatasourceApi
// (packages/observability). The dashboard components look datasources up here and send their
// queries to the URLs buildProxyUrl returns; the relay forwards both to the hub's Perses with the
// caller's own token, so Perses decides what the caller may read, within the one project the relay
// passes and the global datasources. Another project's (monitoring.extraDashboards) passes only by
// name: those projects can't be listed, so their datasources are read one by one.
import type {
  BuildDatasourceProxyUrlParams,
  DatasourceApi,
  DatasourceResource,
  DatasourceSelector,
  GlobalDatasourceResource,
} from '@perses-dev/client';
import { PERSES_API } from '../../api/monitoring';
import type { MonitoringExtraProject } from '../../api/types';

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

  /** The datasources the relay passes in each project it reads only by name. */
  private readonly byName: Map<string, string[]>;

  constructor(
    extra: MonitoringExtraProject[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.byName = new Map(extra.map((p) => [p.project, p.datasources]));
  }

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

  listDatasources = async (project: string, pluginKind?: string): Promise<DatasourceResource[]> => {
    const names = this.byName.get(project);
    if (!names) {
      return this.cached(
        `${PERSES_API}/api/v1/projects/${encodeURIComponent(project)}/datasources${kindQuery(pluginKind)}`,
      );
    }
    const found = await Promise.all(names.map((name) => this.named(project, name)));
    return found.filter((d): d is DatasourceResource => !!d && (!pluginKind || d.spec.plugin.kind === pluginKind));
  };

  /** One datasource of a project the relay reads by name: undefined when it isn't there or may not be read. */
  private named = (project: string, name: string): Promise<DatasourceResource | undefined> => {
    const url = `${PERSES_API}/api/v1/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(name)}`;
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < CACHE_MS) {
      return hit.list as Promise<DatasourceResource | undefined>;
    }
    // "Not there" (403, 404) is kept like an answer, so every panel's lookup doesn't ask again; any
    // other failure is dropped, as in cached.
    const one = get<DatasourceResource>(url).catch((err: unknown) => {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) return undefined;
      this.cache.delete(url);
      throw err;
    });
    this.cache.set(url, { at: this.now(), list: one });
    return one;
  };

  listGlobalDatasources = (pluginKind?: string): Promise<GlobalDatasourceResource[]> =>
    this.cached(`${PERSES_API}/api/v1/globaldatasources${kindQuery(pluginKind)}`);

  /** The named datasource, or the project's default one of the kind when the selector names none. */
  getDatasource = async (project: string, selector: DatasourceSelector): Promise<DatasourceResource | undefined> => {
    const names = this.byName.get(project);
    if (names && selector.name) {
      // Only a datasource the relay passes; any other would be its 404.
      const d = names.includes(selector.name) ? await this.named(project, selector.name) : undefined;
      return d && d.spec.plugin.kind === selector.kind ? d : undefined;
    }
    return (await this.listDatasources(project, selector.kind)).find((d) =>
      selector.name ? d.metadata.name === selector.name : d.spec.default,
    );
  };

  getGlobalDatasource = async (selector: DatasourceSelector): Promise<GlobalDatasourceResource | undefined> =>
    (await this.listGlobalDatasources(selector.kind)).find((d) =>
      selector.name ? d.metadata.name === selector.name : d.spec.default,
    );
}
