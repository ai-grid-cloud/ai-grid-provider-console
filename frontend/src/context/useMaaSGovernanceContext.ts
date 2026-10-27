// Ported from krisv/ai-grid-cloud-provider-poc src/app/context/MaaSGovernanceContext.tsx at 62319b8:
// the context and its hook, in their own module so MaaSGovernanceContext.tsx exports only the
// provider (ruling A4). The context also carries the organizations and the signed-in user,
// which the subscription pages need for the Organization field and to hide write actions.
import { createContext, useContext } from 'react';
import type { ModelsService } from '../api/models';
import type { OrganizationsService } from '../api/organizations';
import type { SubscriptionsService } from '../api/subscriptions';
import type { MaaSSubscription, ManagedModel, Organization } from '../api/types';
import { useServiceData } from '../hooks/useServiceData';
import { useConsoleSession } from './useConsoleSession';

/** What the subscription pages call. */
export type GovernanceService = SubscriptionsService & ModelsService & OrganizationsService;

/** Polls the subscriptions and the models, as the PoC's provider does. */
export const useMaaSGovernanceData = (service: GovernanceService) => {
  const [subscriptions, subscriptionsLoaded, subscriptionsError, refreshSubscriptions] = useServiceData<
    MaaSSubscription[]
  >(() => service.listSubscriptions(), []);
  const [modelRefs, modelRefsLoaded, modelRefsError, refreshModels] = useServiceData<ManagedModel[]>(
    () => service.listModels(),
    [],
  );
  const [organizations, organizationsLoaded, organizationsError] = useServiceData<Organization[]>(
    () => service.listOrganizations(),
    [],
  );
  const { user } = useConsoleSession();
  const refresh = () => {
    void refreshSubscriptions();
    void refreshModels();
  };
  const overviewLoaded = subscriptionsLoaded && modelRefsLoaded;
  return {
    subscriptions,
    modelRefs,
    organizations,
    organizationsLoaded,
    organizationsError,
    subscriptionsLoaded,
    subscriptionsError,
    modelRefsLoaded,
    modelRefsError,
    overviewLoaded,
    loaded: overviewLoaded,
    error: subscriptionsError ?? modelRefsError,
    refresh,
    /** UI hint only; the backend enforces authorization. */
    canWrite: !!user?.isProviderAdmin,
  };
};

export type MaaSGovernanceData = ReturnType<typeof useMaaSGovernanceData>;

export const MaaSGovernanceContext = createContext<MaaSGovernanceData | null>(null);

export const useMaaSGovernanceContext = (): MaaSGovernanceData => {
  const context = useContext(MaaSGovernanceContext);
  if (!context) throw new Error('Governance provider missing.');
  return context;
};
