// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/maas-governance/EmptyStatePage.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/maas-governance/EmptyStatePage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Only the subscriptions use is ported; the authorization policy button has no route.
import { Link } from 'react-router-dom';
import { Button, EmptyState, EmptyStateActions, EmptyStateBody, EmptyStateFooter } from '@patternfly/react-core';
import { PlusCircleIcon } from '@patternfly/react-icons';
import { getSubscriptionCreateUrl } from '../../utilities/maasGovernanceNavigation';

type Props = {
  title: string;
  bodyText: string;
  /** Shows the Create subscription button. */
  showSubsButton?: boolean;
  testId?: string;
};

export const EmptyStatePage: React.FC<Props> = ({ title, bodyText, showSubsButton = false, testId }) => (
  <EmptyState titleText={title} headingLevel="h3" variant="lg" data-testid={testId} icon={PlusCircleIcon}>
    <EmptyStateBody>{bodyText}</EmptyStateBody>
    {showSubsButton && (
      <EmptyStateFooter>
        <EmptyStateActions>
          <Button
            variant="primary"
            component={(props) => <Link {...props} to={getSubscriptionCreateUrl()} />}
            data-testid="create-subscription-button"
          >
            Create subscription
          </Button>
        </EmptyStateActions>
      </EmptyStateFooter>
    )}
  </EmptyState>
);
