// Ported from krisv/ai-grid-cloud-provider-poc src/app/hooks/useGovernanceAffectedModels.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/hooks/useGovernanceAffectedModels.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The affected models come from the backend's MaaS status (P12) instead of the PoC's model list:
// a reference to no model (modelRefStatuses NotFound), and a model whose MaaSModelRef is
// Pending, Unhealthy or Failed (modelRegistrations, which GET /subscriptions/{name} returns).
import { useMemo } from 'react';
import type { MaaSSubscription, ModelRegistration } from '../api/types';
import { isSameModel } from '../utilities/authpolicies';
import type { AffectedModel } from '../utilities/phaseLabelUtils';
import { MODEL_NOT_FOUND_STATUS_MESSAGE, normalizePhase, PhaseStatus } from '../utilities/phaseLabelUtils';

const AFFECTED_REGISTRATION_PHASES: string[] = [PhaseStatus.PENDING, PhaseStatus.UNHEALTHY, PhaseStatus.FAILED];

/** The models that keep a subscription from being Ready. */
export const getSubscriptionAffectedModels = (
  subscription: Pick<MaaSSubscription, 'modelRefs' | 'modelRefStatuses'>,
  registrations: ModelRegistration[] = [],
): AffectedModel[] => {
  const displayName = (model: { name: string; namespace?: string }) =>
    subscription.modelRefs.find((ref) => isSameModel(ref, model))?.displayName;
  const missing = (subscription.modelRefStatuses ?? [])
    .filter((status) => status.reason === 'NotFound')
    .map((status) => ({
      name: status.name,
      displayName: displayName(status),
      phase: PhaseStatus.UNAVAILABLE,
      statusMessage: MODEL_NOT_FOUND_STATUS_MESSAGE,
    }));
  const troubled = registrations
    .filter((registration) => AFFECTED_REGISTRATION_PHASES.includes(registration.phase))
    .map((registration) => ({
      name: registration.name,
      displayName: displayName(registration),
      phase: normalizePhase(registration.phase),
      statusMessage: registration.conditions.find((c) => c.type === 'Ready')?.message,
    }));
  return [...missing, ...troubled];
};

/** For a degraded subscription in a list, its references to no model; undefined otherwise. */
export const useSubscriptionAffectedModels = (
  subscription: Pick<MaaSSubscription, 'modelRefs' | 'modelRefStatuses' | 'phase'>,
): { affectedModels: AffectedModel[] | undefined; overviewLoaded: boolean } => {
  const affectedModels = useMemo(
    () =>
      normalizePhase(subscription.phase) === PhaseStatus.DEGRADED
        ? getSubscriptionAffectedModels(subscription)
        : undefined,
    [subscription],
  );
  return { affectedModels, overviewLoaded: true };
};
