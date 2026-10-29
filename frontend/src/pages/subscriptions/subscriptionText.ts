// How the subscription pages word the backend's Subscriptions and Tenants messages: the thin
// selector layer ADR-0002 allows, beside the Models pages' modelView.ts, whose display name and
// phase words the subscription pages reuse. What each field means is the backend's
// (proto/ai_grid/v1 at .backend-api-version). The one word made from more than one field is Saved
// to Git, below, read as modelView.ts's phaseWordOf reads a model's.
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import type { Condition } from '../../gen/ai_grid/v1/condition_type_pb';
import type { Metadata } from '../../gen/ai_grid/v1/metadata_type_pb';
import type {
  ModelRegistration,
  Subscription,
  SubscriptionModelRef,
  TokenRateLimit,
} from '../../gen/ai_grid/v1/subscription_type_pb';
import type { SubscriptionsGetResponse } from '../../gen/ai_grid/v1/subscriptions_service_pb';
import type { Tenant } from '../../gen/ai_grid/v1/tenant_type_pb';
import { MODEL_NOT_FOUND_STATUS_MESSAGE, normalizePhase, PhaseStatus } from '../../utilities/phaseLabelUtils';
import type { TokenLimit } from '../../utilities/rateLimits';
// A subscription and its policy keep their display name and description in the annotations a model
// does (modelView.ts): the only prefixed keys the backend accepts on them (docs/UI_API_REFERENCE.md,
// and validateGitMetadata in internal/servers/subscriptions_git.go).
import { DESCRIPTION, type ModelView } from '../models/modelView';

/** The backend's Ready condition reason for a status git mode doesn't read from the clusters. */
const REASON_SAVED_TO_GIT = 'SavedToGit';

/** An object's description annotation; empty without one. */
export const descriptionOf = (object: { metadata?: Metadata }): string =>
  object.metadata?.annotations[DESCRIPTION]?.trim() ?? '';

/** A timestamp as an ISO string for RelativeTime; undefined when the backend sent none. */
export const isoTime = (time: Timestamp | undefined): string | undefined =>
  time ? timestampDate(time).toISOString() : undefined;

/** Whether the backend reports the object as being deleted (metadata.deletion_timestamp). */
export const isDeleting = (object: { metadata?: Metadata }): boolean => !!object.metadata?.deletionTimestamp;

/** The organization the subscription belongs to: spec.organization.id, empty without one. */
export const organizationIdOf = (subscription: Subscription): string => subscription.spec?.organization?.id ?? '';

/** The organization's name (metadata.name), else its id. */
export const tenantNameOf = (tenant: Tenant): string => tenant.metadata?.name || tenant.id;

/** The subscription's owner groups, as the backend answers them: bare group names. */
export const groupsOf = (subscription: Subscription): string[] => subscription.spec?.owner?.groups ?? [];

/** The subscription's model refs. */
export const modelRefsOf = (subscription: Subscription): SubscriptionModelRef[] => subscription.spec?.modelRefs ?? [];

/** The ids of the models the subscriptions' refs name, by the backend's join (model_id), once each. */
export const modelIdsOf = (subscriptions: Subscription[]): string[] => [
  ...new Set(subscriptions.flatMap((s) => modelRefsOf(s).flatMap((ref) => (ref.modelId ? [ref.modelId] : [])))),
];

/** The Ready condition's reason and message, which a status label's tooltip shows. */
export type ConditionText = { reason?: string; statusMessage?: string };

/** The Ready condition of an object's conditions; empty without one. */
export const readyConditionOf = (conditions: Condition[] | undefined): ConditionText => {
  const ready = conditions?.find((c) => c.type === 'Ready');
  return ready ? { reason: ready.reason, statusMessage: ready.message } : {};
};

/** The model a ref names, by the backend's join (SubscriptionModelRef.model_id); none it couldn't join. */
export const modelForRef = (models: ModelView[], ref: SubscriptionModelRef): ModelView | undefined =>
  ref.modelId ? models.find((m) => m.id === ref.modelId) : undefined;

/** A ref's title: the display name the backend joined, else its model's, else its name. */
export const refTitleOf = (ref: SubscriptionModelRef, model?: ModelView): string =>
  ref.displayName || model?.displayName || ref.name;

/** A key for a ref in React lists: its namespace and name, as the backend writes it. */
export const refKey = (ref: { name: string; namespace: string }): string => `${ref.namespace}/${ref.name}`;

/** A registration's status: the label's word and its reason (the Ready condition's message). */
export type RegistrationStatus = { status: string; reason?: string };

/**
 * A referenced model's status on the subscription's page, from Subscriptions/Get's
 * model_registrations: the registration's phase (Ready or Pending in git mode); Saved to Git for one
 * with no phase and a Ready condition of reason SavedToGit, the reading modelView.ts's phaseWordOf
 * gives a model with the same reason; and Not found for a ref without a registration, which the
 * backend's gitModelRegistrations says a client takes as missing.
 */
export const registrationStatusOf = (
  registrations: ModelRegistration[],
  ref: SubscriptionModelRef,
): RegistrationStatus => {
  const registration = registrations.find((r) => r.name === ref.name && r.namespace === ref.namespace);
  if (!registration) {
    return { status: 'Not found', reason: MODEL_NOT_FOUND_STATUS_MESSAGE };
  }
  const ready = registration.conditions.find((c) => c.type === 'Ready');
  if (!registration.phase && ready?.reason === REASON_SAVED_TO_GIT) {
    return { status: 'Saved to Git', reason: ready.message };
  }
  return { status: normalizePhase(registration.phase), reason: ready?.message };
};

/** A ref's token limits as the form edits them. */
export const toTokenLimits = (limits: TokenRateLimit[]): TokenLimit[] =>
  limits.map(({ limit, window }) => ({ limit: Number(limit), window }));

/**
 * Whether the subscription is still changing: Active is the one phase git mode settles on
 * (phaseLabelUtils.tsx), so Pending, and no phase before a cluster reports, make the pages poll sooner.
 */
export const isUnsettledSubscription = (subscription: Subscription): boolean =>
  normalizePhase(subscription.status?.phase) !== PhaseStatus.ACTIVE;

/** A model registration's status that is still changing. Not found is left out: a deleted model stays so. */
const unsettledRegistrations: ReadonlySet<string> = new Set([PhaseStatus.PENDING, PhaseStatus.UNKNOWN, 'Saved to Git']);

/** Whether the subscription, or the registration of any model it names, is still changing. */
export const isUnsettledSubscriptionInfo = (info: SubscriptionsGetResponse): boolean =>
  !!info.object &&
  (isUnsettledSubscription(info.object) ||
    modelRefsOf(info.object).some((ref) =>
      unsettledRegistrations.has(registrationStatusOf(info.modelRegistrations, ref).status),
    ));
