// The Subscriptions pages' calls to the backend over Connect (docs/connect.md): Subscriptions/List,
// Get, Create, Update and Delete, Models/List for the models the subscriptions name, and
// Tenants/List for the organization select. Reads poll as the Clusters and Models pages do
// (useClusters.ts); writes are sent from the app root (useBackgroundWrites), which refetches every
// Subscriptions query once they land.
import { useMemo } from 'react';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { callUnaryMethod, useQuery, useTransport } from '@connectrpc/connect-query';
import { skipToken } from '@tanstack/react-query';
import { useBackgroundWrites } from '../../notifications/useBackgroundWrites';
import { sentSubscriptionFields } from '../../notifications/writeFields';
import type { ModelsListResponse } from '../../gen/ai_grid/v1/models_service_pb';
import { list as listModels } from '../../gen/ai_grid/v1/models_service-Models_connectquery';
import type { Subscription } from '../../gen/ai_grid/v1/subscription_type_pb';
import {
  type SubscriptionsCreateRequestSchema,
  type SubscriptionsGetResponse,
  type SubscriptionsListResponse,
  type SubscriptionsUpdateRequestSchema,
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
import { displayNameOf, toModelView, type ModelView } from '../models/modelView';
import { changingSubscriptionInfoOf, changingSubscriptionOf } from './subscriptionText';

const subscriptionItems = (answer: SubscriptionsListResponse | undefined) => answer?.items ?? [];
const subscriptionInfo = (answer: SubscriptionsGetResponse | undefined) => (answer?.object ? answer : undefined);
const modelViews = (answer: ModelsListResponse | undefined) => answer?.items.map(toModelView) ?? [];
const tenantItems = (answer: TenantsListResponse | undefined) => answer?.items ?? [];

/** The subscriptions in the answer still changing (changingSubscriptionOf); undefined when none is. */
const anyUnsettled = (answer: SubscriptionsListResponse) =>
  answer.items.map(changingSubscriptionOf).filter(Boolean).join('\n') || undefined;

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
 * The organizations, and whether they are `known`: listed without an error since the page mounted
 * (Loaded's `fresh`). A list the cache kept from an earlier page may predate an organization
 * created since, so only a known list may call an organization missing (isOrganizationMissing).
 */
export const useOrganizations = (): Loaded<Tenant[]> & { known: boolean } => {
  const organizations = useTenantList();
  return { ...organizations, known: organizations.fresh && !organizations.error };
};

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
  const options = useLoadOptions(changingSubscriptionInfoOf, false);
  return useLoaded(useQuery(get, { id }, poll ? options : { retry: false, refetchInterval: false }), subscriptionInfo);
};

/**
 * Subscriptions/Create, Update and Delete, sent from the app root (useBackgroundWrites): a write
 * that outlasts the form's short wait keeps running when the form leaves (`pending`), and the
 * notification center reports how it ended. The center refetches the subscriptions once a write
 * lands. A failure that comes back within the wait is the ConnectError, as before.
 */
export const useSubscriptionWrites = () => {
  const transport = useTransport();
  const { submitWrite } = useBackgroundWrites();
  return useMemo(
    () => ({
      /**
       * `draft` is the subscription as sent (JSON), kept should the backend refuse it after the form
       * left; `organization` its organization's name, for the notification that it is active.
       */
      createSubscription: (
        request: MessageInitShape<typeof SubscriptionsCreateRequestSchema>,
        name: string,
        draft?: unknown,
        organization?: string,
      ) =>
        submitWrite(
          {
            subject: 'subscription',
            op: 'create',
            id: request.object?.id ?? '',
            name,
            // What a lost answer's read-back must find to confirm this write.
            expected: sentSubscriptionFields(request.object),
            ...(organization ? { organization } : {}),
            draft,
          },
          () => callUnaryMethod(transport, create, request),
          // The backend may add a suffix to the requested id: its answer names the subscription.
          (response) => response.object?.id,
        ),
      updateSubscription: (request: MessageInitShape<typeof SubscriptionsUpdateRequestSchema>, name: string) =>
        submitWrite(
          {
            subject: 'subscription',
            op: 'update',
            id: request.object?.id ?? '',
            name,
            version: request.object?.metadata?.version ?? 0,
            expected: sentSubscriptionFields(request.object, request.updateMask?.paths),
          },
          () => callUnaryMethod(transport, update, request),
        ),
      deleteSubscription: (subscription: Subscription) =>
        submitWrite(
          { subject: 'subscription', op: 'delete', id: subscription.id, name: displayNameOf(subscription) },
          // The version read; the backend refuses a stale one (zero would skip the check).
          () =>
            callUnaryMethod(transport, remove, {
              id: subscription.id,
              resourceVersion: subscription.metadata?.version ?? 0,
            }),
        ),
      /** The subscription as the backend has it now, for a retry after a failed delete. */
      reload: async (id: string) => (await callUnaryMethod(transport, get, { id })).object,
    }),
    [transport, submitWrite],
  );
};
