import {
  toGridCluster,
  toManagedModel,
  toModelCreate,
  toOrganization,
  toSubscription,
  toSubscriptionInfo,
} from './adapters';
import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type {
  ApiCluster,
  ApiModel,
  ApiTenant,
  ConsoleConfig,
  CreateModelRequest,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  GridCluster,
  GridOverview,
  GridRange,
  MaaSSubscription,
  ManagedModel,
  Organization,
  OrganizationInput,
  SubscriptionInfoResponse,
  UpdateSubscriptionRequest,
  User,
} from './types';

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

  async listOrganizations(): Promise<Organization[]> {
    return (await this.request<ApiTenant[]>('GET', '/tenants')).map(toOrganization);
  }

  async getOrganization(id: string): Promise<Organization> {
    return toOrganization(await this.request<ApiTenant>('GET', `/tenants/${encodeURIComponent(id)}`));
  }

  async createOrganization(input: OrganizationInput): Promise<Organization> {
    const { name, domains, identityProvider } = input;
    return toOrganization(
      await this.request<ApiTenant>('POST', '/tenants', { body: { name, domains, identityProvider } }),
    );
  }

  /** PATCHes only what the PoC can change: the domains and the identity provider, not the name. */
  async updateOrganization(id: string, input: OrganizationInput, resourceVersion: string): Promise<Organization> {
    const { domains, identityProvider } = input;
    return toOrganization(
      await this.request<ApiTenant>('PATCH', `/tenants/${encodeURIComponent(id)}`, {
        body: { domains, identityProvider },
        ifMatch: resourceVersion,
      }),
    );
  }

  deleteOrganization(id: string, resourceVersion: string): Promise<void> {
    return this.request<void>('DELETE', `/tenants/${encodeURIComponent(id)}`, { ifMatch: resourceVersion });
  }

  async listModels(): Promise<ManagedModel[]> {
    return (await this.request<ApiModel[]>('GET', '/models')).map(toManagedModel);
  }

  listLocations(): Promise<string[]> {
    return this.request<string[]>('GET', '/locations');
  }

  /** POSTs PR 12's ModelCreate with only the wizard's keys, in the configured models namespace. */
  async createModel(input: CreateModelRequest): Promise<ManagedModel> {
    const { modelsNamespace } = await this.getConfig();
    return toManagedModel(
      await this.request<ApiModel>('POST', '/models', { body: toModelCreate(input, modelsNamespace) }),
    );
  }

  deleteModel(namespace: string, name: string, resourceVersion: string): Promise<void> {
    return this.request<void>('DELETE', `/models/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, {
      ifMatch: resourceVersion,
    });
  }

  async listSubscriptions(): Promise<MaaSSubscription[]> {
    return (await this.request<MaaSSubscription[]>('GET', '/subscriptions')).map(toSubscription);
  }

  /** The subscription, with its referenced models as PR 12's model JSON mapped by toManagedModel. */
  async getSubscriptionInfo(name: string): Promise<SubscriptionInfoResponse> {
    const info = await this.request<Omit<SubscriptionInfoResponse, 'modelRefs'> & { modelRefs?: ApiModel[] }>(
      'GET',
      `/subscriptions/${encodeURIComponent(name)}`,
    );
    return toSubscriptionInfo({ ...info, modelRefs: (info.modelRefs ?? []).map(toManagedModel) });
  }

  async createSubscription(input: CreateSubscriptionRequest): Promise<CreateSubscriptionResponse> {
    const out = await this.request<CreateSubscriptionResponse>('POST', '/subscriptions', { body: input });
    return { ...out, subscription: toSubscription(out.subscription) };
  }

  async updateSubscription(
    name: string,
    input: UpdateSubscriptionRequest,
    resourceVersion: string,
  ): Promise<CreateSubscriptionResponse> {
    const out = await this.request<CreateSubscriptionResponse>('PUT', `/subscriptions/${encodeURIComponent(name)}`, {
      body: input,
      ifMatch: resourceVersion,
    });
    return { ...out, subscription: toSubscription(out.subscription) };
  }

  deleteSubscription(name: string, resourceVersion: string): Promise<void> {
    return this.request<void>('DELETE', `/subscriptions/${encodeURIComponent(name)}`, { ifMatch: resourceVersion });
  }

  async getGridOverview(
    range: GridRange,
    opts: { site?: string; includeMetrics?: boolean } = {},
  ): Promise<GridOverview> {
    const query = new URLSearchParams({ range });
    if (opts.site) {
      query.set('site', opts.site);
    }
    if (opts.includeMetrics === false) {
      query.set('metrics', 'false');
    }
    const overview = await this.request<Omit<GridOverview, 'clusters'> & { clusters: ApiCluster[] }>(
      'GET',
      `/grid/overview?${query}`,
    );
    return { ...overview, clusters: overview.clusters.map(toGridCluster) };
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
