// The backend's Subscriptions API for page tests, in memory, joined to the models of
// connectModels.ts's FakeModels. It answers as the backend's git mode does at
// .backend-api-version (internal/servers/subscriptions_server.go and subscriptions_git.go): Active,
// Pending or no phase; a managed <id>-policy; a model ref joined to its model by model_id; versions
// from 1, Aborted on a stale one; refs to a model that doesn't exist refused.
import { clone, create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import type { FakeBackend } from '../api/connect/testing';
import type { GridCluster } from '../api/types';
import { ConditionStatus } from '../gen/ai_grid/v1/condition_type_pb';
import { MetadataSchema } from '../gen/ai_grid/v1/metadata_type_pb';
import type { Model } from '../gen/ai_grid/v1/model_type_pb';
import {
  AuthPolicySchema,
  ModelRegistrationSchema,
  SubscriptionSchema,
  SubscriptionSpecSchema,
  type AuthPolicy,
  type ModelRegistration,
  type Subscription,
} from '../gen/ai_grid/v1/subscription_type_pb';
import { DESCRIPTION, DISPLAY_NAME } from '../pages/models/modelView';
import { modelsOf, type FakeModels } from './connectModels';
import { ACME_ID } from './connectTenants';

/** The backend's default subscription namespace (AI_GRID_SUBSCRIPTION_NAMESPACE), where refs point. */
export const SUBSCRIPTION_NAMESPACE = 'models-as-a-service';
/** The fixture organization acme-robotics (connectTenants.ts). */
export { ACME_ID };

const ready = (message: string) => ({
  type: 'Ready',
  status: ConditionStatus.TRUE,
  reason: 'Ready',
  message,
});

const annotations = (displayName?: string, description?: string) => ({
  ...(displayName ? { [DISPLAY_NAME]: displayName } : {}),
  ...(description ? { [DESCRIPTION]: description } : {}),
});

const limits = (...pairs: [number, string][]) => pairs.map(([limit, window]) => ({ limit: BigInt(limit), window }));

/**
 * The PoC's subscriptions (MockConsoleService's former seed), as git mode reports them: engineering
 * Active in acme-robotics, data-science Pending, research with no report yet and a ref to a model
 * the catalog doesn't have.
 */
export const seedSubscriptions = (): Subscription[] => [
  create(SubscriptionSchema, {
    id: 'engineering',
    metadata: {
      name: 'engineering',
      version: 1,
      annotations: annotations('Engineering', 'Production models for the engineering team.'),
      creationTimestamp: timestampFromDate(new Date('2026-09-01T09:00:00Z')),
    },
    spec: {
      owner: { groups: ['engineering'] },
      priority: 100,
      organization: { id: ACME_ID },
      tokenMetadata: { costCenter: 'engineering', labels: { environment: 'production' } },
      modelRefs: [
        {
          name: 'granite-3-8b',
          namespace: SUBSCRIPTION_NAMESPACE,
          tokenRateLimits: limits([100000, '1h'], [10000, '1m']),
          billingRate: { perToken: '0.000002' },
        },
      ],
    },
    status: { phase: 'Active' },
  }),
  create(SubscriptionSchema, {
    id: 'data-science',
    metadata: {
      name: 'data-science',
      version: 1,
      annotations: annotations('Data science', 'Shared model access for data scientists.'),
    },
    spec: {
      owner: { groups: ['data-scientists', 'platform-admins'] },
      priority: 10,
      modelRefs: ['granite-3-8b', 'llama-3-70b'].map((name) => ({
        name,
        namespace: SUBSCRIPTION_NAMESPACE,
        tokenRateLimits: limits([50000, '1h']),
      })),
    },
    status: { phase: 'Pending' },
  }),
  create(SubscriptionSchema, {
    id: 'research',
    metadata: { name: 'research', version: 1, annotations: annotations('Research', 'Experimental endpoint access.') },
    spec: {
      owner: { groups: ['research'] },
      modelRefs: [{ name: 'retired-llm', namespace: SUBSCRIPTION_NAMESPACE, tokenRateLimits: limits([1000, '1h']) }],
    },
  }),
];

/** Each seed subscription's managed policy, Active with its Ready condition. */
const seedPolicies = (subscriptions: Subscription[]): AuthPolicy[] =>
  subscriptions.map((s) =>
    create(AuthPolicySchema, {
      id: `${s.id}-policy`,
      metadata: {
        name: `${s.id}-policy`,
        annotations: annotations(`${s.metadata?.annotations[DISPLAY_NAME]} policy`),
      },
      subjectGroups: s.spec?.owner?.groups ?? [],
      modelRefs: (s.spec?.modelRefs ?? []).map(({ name, namespace }) => ({ name, namespace })),
      phase: 'Active',
      conditions: [ready('Ready on site1')],
    }),
  );

/** The service a test renders: its clusters place FakeModels' models. */
export type SubscriptionsSource = {
  clusters?: GridCluster[];
};

/** A service without clusters places models on none; one stand-in per service, so its FakeModels stays. */
const noClusters = new WeakMap<object, { clusters: GridCluster[] }>();

/** The FakeModels of a test's service (connectModels.ts, modelsOf), the same the transport serves. */
export const fleetOf = (service: SubscriptionsSource): FakeModels => {
  if (service.clusters) return modelsOf(service as { clusters: GridCluster[] });
  let source = noClusters.get(service);
  if (!source) {
    source = { clusters: [] };
    noClusters.set(service, source);
  }
  return modelsOf(source);
};

type Impl = Required<NonNullable<FakeBackend['subscriptions']>>;
type Method = 'list' | 'get' | 'create' | 'update' | 'delete';

/** The one filter the console sends: the subscriptions whose refs name a model (the backend's README). */
const MODEL_FILTER = /^this\.spec\.model_refs\.exists\(r, r\.model_id == "([^"]*)"\)$/;

/** The in-memory subscriptions, their policies and their models' registrations. */
export class FakeSubscriptions {
  /** The subscriptions, kept in FakeModels so its delete check and ModelReferences read the same. */
  get subscriptions(): Subscription[] {
    return this.fleet.subscriptions;
  }
  set subscriptions(next: Subscription[]) {
    this.fleet.subscriptions = next;
  }
  policies: AuthPolicy[] = [];
  /** The MaaSModelRef reports, by model; a model without one is Saved to Git. */
  registrations: ModelRegistration[] = [
    create(ModelRegistrationSchema, {
      name: 'granite-3-8b',
      namespace: SUBSCRIPTION_NAMESPACE,
      phase: 'Ready',
      conditions: [ready('Ready on site1')],
    }),
    create(ModelRegistrationSchema, {
      name: 'llama-3-70b',
      namespace: SUBSCRIPTION_NAMESPACE,
      phase: 'Pending',
      conditions: [{ type: 'Ready', status: ConditionStatus.FALSE, reason: 'NotReady', message: 'Not ready on site2' }],
    }),
  ];

  /**
   * Runs before each method, so a test can make one fail (throw), wait (return a promise) or count
   * its calls; requests are recorded in `requests`.
   */
  before: Partial<Record<Method, (request: unknown) => unknown>> = {};
  requests: { method: Method; request: unknown }[] = [];
  /**
   * What Create adds to the requested id, as a backend that makes subscription names unique does
   * ("-" and six characters; backend PR 89); none answers the requested id, as today's backend does.
   */
  idSuffix = '';

  constructor(private readonly fleet: FakeModels) {}

  /** Adds the PoC's subscriptions and their policies (seedSubscriptions). */
  seed(): this {
    this.subscriptions = seedSubscriptions();
    this.policies = seedPolicies(this.subscriptions);
    return this;
  }

  /** The requests of one method, as the backend received them. */
  sent<M extends Method>(method: M): Parameters<Impl[M]>[0][] {
    return this.requests.filter((r) => r.method === method).map((r) => r.request as Parameters<Impl[M]>[0]);
  }

  private async enter(method: Method, request: unknown): Promise<Model[]> {
    this.requests.push({ method, request });
    await this.before[method]?.(request);
    return this.fleet.models;
  }

  /** The subscription as an answer carries it: each ref joined to its model (modelCatalog.join). */
  private joined(subscription: Subscription, models: Model[]): Subscription {
    const out = clone(SubscriptionSchema, subscription);
    for (const ref of out.spec?.modelRefs ?? []) {
      // A ref without a namespace is in the subscription namespace (modelCatalog.join).
      const namespace = ref.namespace || SUBSCRIPTION_NAMESPACE;
      const model = namespace === SUBSCRIPTION_NAMESPACE && models.find((m) => m.id === ref.name);
      ref.modelId = model ? model.id : '';
      ref.displayName = model ? (model.metadata?.annotations[DISPLAY_NAME] ?? '') : '';
      ref.description = model ? (model.metadata?.annotations[DESCRIPTION] ?? '') : '';
    }
    return out;
  }

  private find(id: string): Subscription {
    const found = this.subscriptions.find((s) => s.id === id);
    if (!found) throw new ConnectError(`Subscription "${id}" not found`, Code.NotFound);
    return found;
  }

  /** A write's checks: an owner, an organization and models that exist (validateSubscriptionSpec, gitEnsureModelsExist). */
  private check(subscription: Subscription, models: Model[]): Subscription {
    const spec = subscription.spec;
    if (!spec?.owner?.groups.length) {
      throw new ConnectError('spec.owner must include at least one group or user', Code.InvalidArgument);
    }
    if (!spec.organization?.id) {
      throw new ConnectError('spec.organization.id is required', Code.InvalidArgument);
    }
    // A ref in the subscription namespace must name a model that exists; renderSubscriptionDoc
    // writes a ref without a namespace into it.
    for (const ref of spec.modelRefs) {
      ref.namespace ||= SUBSCRIPTION_NAMESPACE;
      if (ref.namespace === SUBSCRIPTION_NAMESPACE && !models.some((m) => m.id === ref.name)) {
        throw new ConnectError(`model ${ref.name} does not exist`, Code.FailedPrecondition);
      }
    }
    return subscription;
  }

  backend(): Impl {
    return {
      list: async (request, context) => {
        const models = await this.enter('list', request);
        const { filter } = request;
        if (filter) {
          // The Models page's question (ModelReferences): FakeModels answers it, as it does for the
          // Models tests.
          if (!MODEL_FILTER.test(filter)) {
            throw new ConnectError(`the fake can't evaluate ${filter}`, Code.InvalidArgument);
          }
          return this.fleet.listSubscriptions(request, context);
        }
        const items = this.subscriptions.map((s) => this.joined(s, models)).sort((a, b) => a.id.localeCompare(b.id));
        return { items, size: items.length, total: items.length };
      },
      get: async (request) => {
        const models = await this.enter('get', request);
        const subscription = this.joined(this.find(request.id), models);
        const refs = subscription.spec?.modelRefs ?? [];
        const named = (r: { name: string; namespace: string }) =>
          refs.some((ref) => ref.name === r.name && ref.namespace === r.namespace);
        // Git mode answers the subscription's own managed policy (gitGet).
        return {
          object: subscription,
          authPolicies: this.policies.filter((p) => p.id === `${subscription.id}-policy` && p.modelRefs.some(named)),
          // One per ref: its report, or Saved to Git (gitModelRegistrations); none for a missing model.
          modelRegistrations: refs
            .filter((ref) => ref.modelId)
            .map(
              (ref) =>
                this.registrations.find((r) => r.name === ref.name && r.namespace === ref.namespace) ??
                create(ModelRegistrationSchema, {
                  name: ref.name,
                  namespace: ref.namespace,
                  conditions: [
                    {
                      type: 'Ready',
                      status: ConditionStatus.UNSPECIFIED,
                      reason: 'SavedToGit',
                      message: "Saved to Git; no cluster has reported the model's status",
                    },
                  ],
                }),
            ),
        };
      },
      create: async (request) => {
        const models = await this.enter('create', request);
        const { object } = request;
        if (!object) throw new ConnectError('object is required', Code.InvalidArgument);
        if (this.subscriptions.some((s) => s.id === object.id)) {
          throw new ConnectError(`Subscription "${object.id}" already exists`, Code.AlreadyExists);
        }
        const subscription = this.check(clone(SubscriptionSchema, object), models);
        subscription.id = `${object.id}${this.idSuffix}`;
        subscription.metadata = create(MetadataSchema, {
          name: subscription.id,
          version: 1,
          labels: { ...object.metadata?.labels },
          annotations: { ...object.metadata?.annotations },
        });
        subscription.status = undefined;
        this.subscriptions.push(subscription);
        const policy = create(AuthPolicySchema, {
          id: `${subscription.id}-policy`,
          metadata: { name: `${subscription.id}-policy` },
          subjectGroups: subscription.spec?.owner?.groups ?? [],
          modelRefs: (subscription.spec?.modelRefs ?? []).map(({ name, namespace }) => ({ name, namespace })),
        });
        this.policies.push(policy);
        return { object: this.joined(subscription, models), authPolicy: policy };
      },
      update: async (request) => {
        const models = await this.enter('update', request);
        const { object, updateMask, lock } = request;
        if (!object) throw new ConnectError('object is required', Code.InvalidArgument);
        const stored = this.find(object.id);
        const version = object.metadata?.version ?? 0;
        if (lock && version === 0) throw new ConnectError('lock requires metadata.version', Code.InvalidArgument);
        if (lock && version !== stored.metadata?.version) {
          throw new ConnectError(
            `update Subscription "${object.id}": the subscription changed since it was read; reload and retry`,
            Code.Aborted,
          );
        }
        const next = clone(SubscriptionSchema, stored);
        const paths = updateMask?.paths ?? [];
        if (paths.includes('spec') && object.spec) next.spec = clone(SubscriptionSpecSchema, object.spec);
        if (paths.includes('metadata.annotations') && next.metadata) {
          next.metadata.annotations = { ...object.metadata?.annotations };
        }
        this.check(next, models);
        if (next.metadata) next.metadata.version += 1;
        this.subscriptions = this.subscriptions.map((s) => (s.id === next.id ? next : s));
        return { object: this.joined(next, models) };
      },
      delete: async (request) => {
        await this.enter('delete', request);
        const { id, resourceVersion } = request;
        const stored = this.find(id);
        if (resourceVersion !== 0 && resourceVersion !== stored.metadata?.version) {
          throw new ConnectError(
            `delete Subscription "${id}": the subscription changed since it was read; reload and retry`,
            Code.Aborted,
          );
        }
        this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
        this.policies = this.policies.filter((p) => p.id !== `${id}-policy`);
        return {};
      },
    };
  }
}

/** The fakes of every service: one per MockConsoleService, so a test can change them. */
const fakes = new WeakMap<object, FakeSubscriptions>();

/** The subscriptions a test's service answers over Connect, joined to its FakeModels' models. */
export const subscriptionsOf = (service: SubscriptionsSource): FakeSubscriptions => {
  let fake = fakes.get(service);
  if (!fake) {
    fake = new FakeSubscriptions(fleetOf(service));
    fakes.set(service, fake);
  }
  return fake;
};

/** The service's subscriptions, seeded with the PoC's (seedSubscriptions). */
export const seedSubscriptionsOf = (service: SubscriptionsSource): FakeSubscriptions => subscriptionsOf(service).seed();

/** Subscriptions over the service. */
export const subscriptionsBackend = (service: SubscriptionsSource): Pick<FakeBackend, 'subscriptions'> => ({
  subscriptions: subscriptionsOf(service).backend(),
});
