import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type { ClusterPatch, ConsoleConfig, GridCluster, Tenant, User } from './types';

const API_PREFIX = '/api/v1';

type Envelope<T> = { data: T };
type ErrorBody = { error?: { code?: string; message?: string } };

export class HttpConsoleService implements ConsoleService {
  constructor(private readonly fetchFn: typeof fetch = (...args) => fetch(...args)) {}

  getUser(): Promise<User> {
    return this.request<User>('GET', '/user');
  }

  getConfig(): Promise<ConsoleConfig> {
    return this.request<ConsoleConfig>('GET', '/config');
  }

  listClusters(): Promise<GridCluster[]> {
    return this.request<GridCluster[]>('GET', '/clusters');
  }

  getCluster(name: string): Promise<GridCluster> {
    return this.request<GridCluster>('GET', `/clusters/${encodeURIComponent(name)}`);
  }

  updateCluster(name: string, patch: ClusterPatch): Promise<GridCluster> {
    return this.request<GridCluster>('PATCH', `/clusters/${encodeURIComponent(name)}`, patch);
  }

  listTenants(): Promise<Tenant[]> {
    return this.request<Tenant[]>('GET', '/tenants');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${API_PREFIX}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch (cause) {
      throw new ServiceError(0, 'The console backend could not be reached.');
    }
    if (!response.ok) {
      let message = `Request failed with status ${response.status}.`;
      try {
        const payload = (await response.json()) as ErrorBody;
        if (payload.error?.message) {
          message = payload.error.message;
        }
      } catch {
        // keep the generic message
      }
      throw new ServiceError(response.status, message);
    }
    const payload = (await response.json()) as Envelope<T>;
    return payload.data;
  }
}
