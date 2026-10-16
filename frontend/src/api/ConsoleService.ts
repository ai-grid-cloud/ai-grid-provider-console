import type { ClusterPatch, ConsoleConfig, GridCluster, Tenant, User } from './types';

/**
 * Every page talks to the BFF through this interface only. The HTTP
 * implementation is used in the browser; tests use an in-memory one.
 */
export interface ConsoleService {
  getUser(): Promise<User>;
  getConfig(): Promise<ConsoleConfig>;
  listClusters(): Promise<GridCluster[]>;
  getCluster(name: string): Promise<GridCluster>;
  updateCluster(name: string, patch: ClusterPatch): Promise<GridCluster>;
  listTenants(): Promise<Tenant[]>;
}

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }

  /** The BFF answers 501 when the backend has no RPC for this yet. */
  get isNotImplemented(): boolean {
    return this.status === 501;
  }

  /** The session is gone; the proxy will start a new login on reload. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}
