import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type { ClusterPatch, ConsoleConfig, GridCluster, ListMeta, ListTenantsParams, Tenant, TenantCreate, TenantPage, TenantPatch, User } from './types';

const API_PREFIX = '/api/v1';

type Envelope<T> = { data: T; meta?: ListMeta };
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

  async listTenants(params: ListTenantsParams = {}): Promise<TenantPage> {
    const query = new URLSearchParams();
    if (params.offset !== undefined) {
      query.set('offset', String(params.offset));
    }
    if (params.limit !== undefined) {
      query.set('limit', String(params.limit));
    }
    const search = params.search?.trim();
    if (search) {
      query.set('search', search);
    }
    const qs = query.toString();
    const envelope = await this.send<Tenant[]>('GET', `/tenants${qs ? `?${qs}` : ''}`);
    const items = envelope.data;
    return { items, meta: envelope.meta ?? { size: items.length, total: items.length, offset: params.offset ?? 0, limit: params.limit } };
  }

  getTenant(id: string): Promise<Tenant> {
    return this.request<Tenant>('GET', `/tenants/${encodeURIComponent(id)}`);
  }

  createTenant(body: TenantCreate): Promise<Tenant> {
    return this.request<Tenant>('POST', '/tenants', body);
  }

  updateTenant(id: string, patch: TenantPatch): Promise<Tenant> {
    return this.request<Tenant>('PATCH', `/tenants/${encodeURIComponent(id)}`, patch);
  }

  async deleteTenant(id: string): Promise<void> {
    await this.send<undefined>('DELETE', `/tenants/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.send<T>(method, path, body)).data;
  }

  /** Performs the call and returns the whole envelope; a 204 yields an empty one. */
  private async send<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
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
    if (response.status === 204) {
      return { data: undefined as T };
    }
    return (await response.json()) as Envelope<T>;
  }
}
