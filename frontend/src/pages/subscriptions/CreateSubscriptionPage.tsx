// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/CreateSubscriptionPage.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/CreateSubscriptionPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's preSelectedModel and breadcrumbLabel router state are dropped: nothing sets them.
import { Link, useLocation } from 'react-router-dom';
import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import type { GovernanceService } from '../../context/useMaaSGovernanceContext';
import { useMaaSGovernanceContext } from '../../context/useMaaSGovernanceContext';
import { getBackUrl } from '../../utilities/maasGovernanceNavigation';
import { ApplicationsPage } from './ApplicationsPage';
import { CreateSubscriptionForm } from './createSubscription/CreateSubscriptionForm';

type Props = { service: GovernanceService };

export const CreateSubscriptionPage: React.FC<Props> = ({ service }) => {
  const { modelRefs, loaded, error, refresh } = useMaaSGovernanceContext();
  const { state } = useLocation();
  const backUrl = getBackUrl(state, 'subscriptions');

  return (
    <ApplicationsPage
      title="Create subscription"
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbItem
            render={() => (
              <Link to={backUrl} data-testid="breadcrumb-subscriptions-link">
                Subscriptions
              </Link>
            )}
          />
          <BreadcrumbItem isActive>Create subscription</BreadcrumbItem>
        </Breadcrumb>
      }
      loaded={loaded || !!error}
      loadError={error}
      onRetry={refresh}
    >
      <CreateSubscriptionForm service={service} modelRefs={modelRefs} returnTo={backUrl} />
    </ApplicationsPage>
  );
};
