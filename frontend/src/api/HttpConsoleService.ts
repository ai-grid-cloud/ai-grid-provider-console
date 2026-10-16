import { toGridCluster } from './adapters';
import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type { ApiCluster, ConsoleConfig, GridCluster, Tenant, User } from './types';

const API_PREFIX = '/api/v1';

type Envelope<T> = { data: T };
type ErrorBody = { error?: { code?: string; message?: string; fieldErrors?: Record<string, string> } };

export type RequestOptions = {
  body?: unknown;
  /** The version the caller read; sent as `If-Match: "<version>"` unless empty. */
  ifMatch?: string;
};

export class HttpConsoleService implements ConsoleService {
  constructor(private readonly fetchFn: typeof fetch = (...args) => fetch(...args)) {}

  getUser(): Promise<User> {
    return this.request<User>('GET', '/user');
  }

  getConfig(): Promise<ConsoleConfig> {
    return this.request<ConsoleConfig>('GET', '/config');
  }

  async listClusters(): Promise<GridCluster[]> {
    const clusters = await this.request<ApiCluster[]>('GET', '/clusters');
    return clusters.map(toGridCluster);
  }

  async enrollCluster(cluster: GridCluster): Promise<GridCluster> {
    // The BFF replaces the labels map as a whole, so send every label read with the cluster.
    const updated = await this.request<ApiCluster>('PATCH', `/clusters/${encodeURIComponent(cluster.name)}`, {
      body: { labels: { ...cluster.labels, 'ai-grid/enabled': 'true' } },
      ifMatch: cluster.resourceVersion,
    });
    return toGridCluster(updated);
  }

  listTenants(): Promise<Tenant[]> {
    return this.request<Tenant[]>('GET', '/tenants');
  }

  /** Calls the BFF and unwraps its data envelope; `undefined` for 204. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { body, ifMatch } = opts;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    // An object the backend gave no version is read with "": send no
    // precondition then (the BFF answers 422 to an empty entity tag).
    if (ifMatch) {
      headers['If-Match'] = JSON.stringify(ifMatch);
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch {
      throw new ServiceError(0, 'The console backend could not be reached.');
    }
    if (!response.ok) {
      let message = `Request failed with status ${response.status}.`;
      let fieldErrors: Record<string, string> | undefined;
      try {
        const payload = (await response.json()) as ErrorBody;
        if (payload.error?.message) {
          message = payload.error.message;
        }
        fieldErrors = payload.error?.fieldErrors;
      } catch {
        // keep the generic message
      }
      throw new ServiceError(response.status, message, fieldErrors);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const payload = (await response.json()) as Envelope<T>;
    return payload.data;
  }
}
