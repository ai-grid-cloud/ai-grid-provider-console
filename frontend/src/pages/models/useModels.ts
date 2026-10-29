// The Models pages' calls to the backend's Models API over Connect (ai_grid.v1.Models, through the
// BFF's relay), and Subscriptions/List for the subscriptions that use a model. Reads poll as the
// Clusters pages do (useClusters.ts); writes go through useMutation and refetch every Models query
// once they land.
import { useMemo } from 'react';
import { callUnaryMethod, createConnectQueryKey, useMutation, useQuery, useTransport } from '@connectrpc/connect-query';
import { useQueryClient } from '@tanstack/react-query';
import { toServiceError } from '../../api/connect/errors';
import {
  Models,
  type ModelsGetResponse,
  type ModelsListPlacementClustersResponse,
  type ModelsListResponse,
} from '../../gen/ai_grid/v1/models_service_pb';
import {
  create,
  delete$,
  get,
  list,
  listPlacementClusters,
  update,
} from '../../gen/ai_grid/v1/models_service-Models_connectquery';
import { list as listSubscriptions } from '../../gen/ai_grid/v1/subscriptions_service-Subscriptions_connectquery';
import type { Subscription } from '../../gen/ai_grid/v1/subscription_type_pb';
import type { SubscriptionsListResponse } from '../../gen/ai_grid/v1/subscriptions_service_pb';
import { useLoadOptions, useLoaded, type Loaded } from '../clusters/useClusters';
import { createRequestOf, updateRequestOf, type ModelInput } from './modelRequests';
import { isUnsettled, toModelView, type ModelView } from './modelView';

const modelViews = (answer: ModelsListResponse | undefined) => answer?.items.map(toModelView) ?? [];
const modelView = (answer: ModelsGetResponse | undefined) => answer?.object && toModelView(answer.object);
const clusterNames = (answer: ModelsListPlacementClustersResponse | undefined) => answer?.clusters ?? [];
const subscriptionItems = (answer: SubscriptionsListResponse | undefined) => answer?.items ?? [];

/** Whether any model in the answer is still changing (isUnsettled), so the page polls sooner. */
const anyUnsettled = (answer: ModelsListResponse) => modelViews(answer).some(isUnsettled);
const unsettledModel = (answer: ModelsGetResponse) => {
  const model = modelView(answer);
  return !!model && isUnsettled(model);
};

/** Every model, from Models/List. */
export const useModelList = (): Loaded<ModelView[]> =>
  useLoaded(useQuery(list, {}, useLoadOptions(anyUnsettled)), modelViews);

/**
 * One model from Models/Get. `poll: false` loads it once, as the edit page does, so the wizard starts
 * from the version the user saw.
 */
export const useModel = (id: string, { poll = true }: { poll?: boolean } = {}): Loaded<ModelView | undefined> => {
  const options = useLoadOptions(unsettledModel);
  // The edit page passes poll: false on purpose: its wizard holds the snapshot it started from
  // (ModelEditPage), and a save is checked against that version.
  return useLoaded(useQuery(get, { id }, poll ? options : { retry: false, refetchInterval: false }), modelView);
};

/**
 * The clusters a model can be placed on, from Models/ListPlacementClusters: loaded when the wizard
 * opens and again on `refresh`, not polled.
 */
export const usePlacementClusters = (): Loaded<string[]> =>
  useLoaded(useQuery(listPlacementClusters, {}, { retry: false }), clusterNames);

/** What the wizard and the delete dialog write, and how the dialog loads a model again. */
export type ModelWrites = {
  createModel: (input: ModelInput) => Promise<void>;
  /** Sends the changed fields with `lock`; resolves to false when nothing changed. */
  updateModel: (model: ModelView, input: ModelInput) => Promise<boolean>;
  deleteModel: (model: ModelView) => Promise<void>;
  loadModel: (id: string) => Promise<ModelView | undefined>;
};

/**
 * Models/Create, Update and Delete. A failure is the ServiceError the pages already show
 * (toServiceError): Aborted, a stale version, is a conflict; InvalidArgument the backend's message.
 */
export const useModelWrites = (): ModelWrites => {
  const transport = useTransport();
  const queryClient = useQueryClient();
  // Refetch every Models query once a write lands, without waiting for it: useMutation waits for
  // a promise onSuccess returns, and a save is done when the backend answered, not when the pages
  // have read the model again (each Models/Get reads the Git catalog).
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: createConnectQueryKey({ schema: Models, cardinality: undefined }) });
  };
  const creating = useMutation(create, { onSuccess });
  const updating = useMutation(update, { onSuccess });
  const deleting = useMutation(delete$, { onSuccess });
  const { mutateAsync: createAsync } = creating;
  const { mutateAsync: updateAsync } = updating;
  const { mutateAsync: deleteAsync } = deleting;
  return useMemo(() => {
    const call = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        throw toServiceError(err);
      }
    };
    return {
      createModel: async (input) => {
        await call(() => createAsync(createRequestOf(input)));
      },
      updateModel: async (model, input) => {
        const request = updateRequestOf(model, input);
        if (!request) return false;
        await call(() => updateAsync(request));
        return true;
      },
      deleteModel: async (model) => {
        // The version the user confirmed: a stale one is Aborted (ModelsDeleteRequest.resource_version).
        await call(() => deleteAsync({ id: model.id, resourceVersion: model.version }));
      },
      loadModel: async (id) => {
        const { object } = await call(() => callUnaryMethod(transport, get, { id }));
        return object && toModelView(object);
      },
    };
  }, [transport, createAsync, updateAsync, deleteAsync]);
};

/**
 * The CEL filter for the subscriptions with a model ref joined to this model: the backend sets
 * `model_id` on a ref that names the model's MaaSModelRef (SubscriptionModelRef.model_id), and
 * evaluates the filter after that join (subscriptions_server.go, List). Ids are DNS labels, so the
 * id needs no escaping; any other value matches nothing.
 */
export const usingModelFilter = (id: string) =>
  /^[a-z0-9-]+$/.test(id) ? `this.spec.model_refs.exists(r, r.model_id == "${id}")` : 'false';

/** The subscriptions that use the model, from Subscriptions/List; loaded once. */
export const useSubscriptionsUsingModel = (id: string): Loaded<Subscription[]> =>
  useLoaded(useQuery(listSubscriptions, { filter: usingModelFilter(id) }, { retry: false }), subscriptionItems);
