import type {
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  MaaSSubscription,
  SubscriptionInfoResponse,
  UpdateSubscriptionRequest,
} from './types';

/** The Subscriptions area: MaaS subscriptions and the authorization policies paired with them. */
export interface SubscriptionsService {
  listSubscriptions(): Promise<MaaSSubscription[]>;
  /** The subscription, the models it references and the authorization policies that cover them. */
  getSubscriptionInfo(name: string): Promise<SubscriptionInfoResponse>;
  /** With createAuthPolicy, also creates `<name>-policy`. */
  createSubscription(input: CreateSubscriptionRequest): Promise<CreateSubscriptionResponse>;
  /** Fails with a conflict when `resourceVersion` is not the current one. Keeps the managed <name>-policy in step; never touches other policies. */
  updateSubscription(
    name: string,
    input: UpdateSubscriptionRequest,
    resourceVersion: string,
  ): Promise<CreateSubscriptionResponse>;
  /** Also deletes `<name>-policy` when the backend created it. */
  deleteSubscription(name: string, resourceVersion: string): Promise<void>;
}
