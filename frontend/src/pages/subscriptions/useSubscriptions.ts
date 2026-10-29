// The Subscriptions pages' calls to the backend over Connect (docs/connect.md): Subscriptions/List,
// Get, Create, Update and Delete, Models/List for the models the subscriptions name, and
// Tenants/List for the organization select. Reads poll as the Clusters and Models pages do
// (useClusters.ts); writes go through useMutation and refetch every Subscriptions query.
import { useCallback } from 'react';
import { callUnaryMethod, createConnectQueryKey, useMutation, useQuery, useTransport } from '@connectrpc/connect-query';
import { skipToken, useQueryClient } from '@tanstack/react-query';
import type { ModelsListResponse } from '../../gen/ai_grid/v1/models_service_pb';
import { list as listModels } from '../../gen/ai_grid/v1/models_service-Models_connectquery';
import type { Subscription } from '../../gen/ai_grid/v1/subscription_type_pb';
import {
  Subscriptions,
  type SubscriptionsGetResponse,
  type SubscriptionsListResponse,
} from '../../gen/ai_grid/v1/subscriptions_service_pb';
import {
  create,
  delete$ as remove,
  get,
  list,
  update,
} from '../../gen/ai_grid/v1/subscriptions_service-Subscriptions_connectquery';
import type { Tenant } from '../../gen/ai_grid/v1/tenant_type_pb';
import type { TenantsListResponse } from '../../gen/ai_grid/v1/tenants_service_pb';
import { list as listTenants } from '../../gen/ai_grid/v1/tenants_service-Tenants_connectquery';
import { useLoadOptions, useLoaded, type Loaded } from '../clusters/useClusters';
import { toModelView, type ModelView } from '../models/modelView';
import { isUnsettledSubscription, isUnsettledSubscriptionInfo } from './subscriptionText';

const subscriptionItems = (answer: SubscriptionsListResponse | undefined) => answer?.items ?? [];
const subscriptionInfo = (answer: SubscriptionsGetResponse | undefined) => (answer?.object ? answer : undefined);
const modelViews = (answer: ModelsListResponse | undefined) => answer?.items.map(toModelView) ?? [];
const tenantItems = (answer: TenantsListResponse | undefined) => answer?.items ?? [];

const anyUnsettled = (answer: SubscriptionsListResponse) => answer.items.some(isUnsettledSubscription);

/** Every subscription, from Subscriptions/List. */
export const useSubscriptionList = (): Loaded<Subscription[]> =>
  useLoaded(useQuery(list, {}, useLoadOptions(anyUnsettled)), subscriptionItems);

/**
 * The CEL filter for the models with these ids (Model.id, DNS labels, so they need no escaping;
 * any other value is left out). The backend evaluates it (Models/List, listModelItems).
 */
export const modelsFilter = (ids: string[]) =>
  `this.id in [${ids
    .filter((id) => /^[a-z0-9-]+$/.test(id))
    .map((id) => `"${id}"`)
    .join(', ')}]`;

/**
 * The models with these ids, from Models/List with a CEL filter on their ids: the models the
 * subscriptions on screen name, not the whole fleet. No ids, no call: an empty list.
 */
export const useModelsByIds = (ids: string[]): Loaded<ModelView[]> => {
  const models = useLoaded(
    useQuery(listModels, ids.length ? { filter: modelsFilter(ids) } : skipToken, useLoadOptions()),
    modelViews,
  );
  return ids.length ? models : { ...models, loaded: true };
};

/** Every organization, from Tenants/List: the organization select, and the organizations' names. */
export const useTenantList = (): Loaded<Tenant[]> =>
  useLoaded(useQuery(listTenants, {}, useLoadOptions()), tenantItems);

/**
 * One subscription with its auth policies and model registrations, from Subscriptions/Get. By
 * default it loads once: the edit page keeps the first answer (EditSubscriptionPage), so a save is
 * checked against the version it started from. `poll: true`, as its page passes, polls while the
 * subscription or a model registration is still changing (isUnsettledSubscriptionInfo), and stops
 * once nothing is.
 */
export const useSubscription = (
  id: string,
  { poll = false }: { poll?: boolean } = {},
): Loaded<SubscriptionsGetResponse | undefined> => {
  const options = useLoadOptions(isUnsettledSubscriptionInfo, false);
  return useLoaded(useQuery(get, { id }, poll ? options : { retry: false, refetchInterval: false }), subscriptionInfo);
};

/** Subscriptions/Create, Update and Delete; each refetches the subscriptions once it lands. */
export const useSubscriptionWrites = () => {
  const queryClient = useQueryClient();
  const transport = useTransport();
  // Refetch every Subscriptions query once a write lands, without waiting for it: useMutation
  // waits for a promise onSuccess returns, and a save is done when the backend answered.
  const onSuccess = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: createConnectQueryKey({ schema: Subscriptions, cardinality: undefined }),
    });
  }, [queryClient]);
  const createSubscription = useMutation(create, { onSuccess });
  const updateSubscription = useMutation(update, { onSuccess });
  const deleteSubscription = useMutation(remove, { onSuccess });
  /** The subscription as the backend has it now, for a retry after a failed delete. */
  const reload = useCallback(async (id: string) => (await callUnaryMethod(transport, get, { id })).object, [transport]);
  return { createSubscription, updateSubscription, deleteSubscription, reload };
};
