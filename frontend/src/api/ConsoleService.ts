import type { ClustersService } from './clusters';
import type { GridService } from './grid';
import type { ModelsService } from './models';
import type { OrganizationsService } from './organizations';
import type { SubscriptionsService } from './subscriptions';
import type { ConsoleConfig, User } from './types';

/** The signed-in user, for pages that show actions only to provider admins. */
export interface UserService {
  getUser(): Promise<User>;
}

/**
 * Every page talks to the BFF through this interface only, and each page takes
 * just the areas it uses. The HTTP implementation is used in the browser; tests
 * use an in-memory one.
 */
export interface ConsoleService
  extends ClustersService, OrganizationsService, ModelsService, SubscriptionsService, GridService, UserService {
  getConfig(): Promise<ConsoleConfig>;
}

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Per-field messages keyed by the JSON path of the request body. */
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ServiceError';
  }

  /** The BFF answers 501 when the backend has no RPC for this yet. */
  get isNotImplemented(): boolean {
    return this.status === 501;
  }

  /** Someone else changed the resource, or the form never read its version. */
  get isConflict(): boolean {
    return this.status === 409 || this.status === 412 || this.status === 428;
  }

  /** The session is gone; the proxy will start a new login on reload. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}
