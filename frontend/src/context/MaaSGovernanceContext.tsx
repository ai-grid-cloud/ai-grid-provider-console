// Ported from krisv/ai-grid-cloud-provider-poc src/app/context/MaaSGovernanceContext.tsx at 62319b8.
// The PoC provides it around the whole app; here only the /subscriptions routes are inside it,
// because no other page uses it (ruling A25).
import type { GovernanceService } from './useMaaSGovernanceContext';
import { MaaSGovernanceContext, useMaaSGovernanceData } from './useMaaSGovernanceContext';

type Props = { service: GovernanceService; children: React.ReactNode };

export const MaaSGovernanceProvider: React.FC<Props> = ({ service, children }) => (
  <MaaSGovernanceContext.Provider value={useMaaSGovernanceData(service)}>{children}</MaaSGovernanceContext.Provider>
);
