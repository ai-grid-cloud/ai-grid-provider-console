// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/viewSubscription/SubscriptionDetailsSection.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/viewSubscription/SubscriptionDetailsSection.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization; the affected models come from the MaaS status (P12).
import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Stack,
  StackItem,
  Timestamp,
  Title,
} from '@patternfly/react-core';
import type { MaaSSubscription, ModelRegistration } from '../../../api/types';
import { PhaseLabel } from '../../../components/Phase/PhaseLabel';
import { getSubscriptionAffectedModels } from '../../../hooks/useGovernanceAffectedModels';

type Props = {
  subscription: MaaSSubscription;
  /** The referenced models' MaaSModelRef statuses. */
  modelRegistrations: ModelRegistration[];
  /** The organization's name, or its id when the organization is unknown. */
  organization: string;
};

export const SubscriptionDetailsSection: React.FC<Props> = ({ subscription, modelRegistrations, organization }) => (
  <Stack hasGutter data-testid="subscription-details-section">
    <StackItem>
      <Title headingLevel="h2" size="xl">
        Details
      </Title>
    </StackItem>
    <StackItem>
      <DescriptionList columnModifier={{ default: '2Col' }}>
        <DescriptionListGroup>
          <DescriptionListTerm>Name</DescriptionListTerm>
          <DescriptionListDescription>
            {subscription.displayName?.trim() || subscription.name}
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Status</DescriptionListTerm>
          <DescriptionListDescription data-testid="subscription-phase">
            <PhaseLabel
              phase={subscription.phase}
              statusMessage={subscription.statusMessage}
              reason={subscription.reason}
              status={subscription.status}
              conditionType={subscription.conditionType}
              lastTransitionTime={subscription.lastTransitionTime}
              resourceName={subscription.displayName ?? subscription.name}
              affectedModels={getSubscriptionAffectedModels(subscription, modelRegistrations)}
            />
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Description</DescriptionListTerm>
          <DescriptionListDescription>{subscription.description ?? '—'}</DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Resource name</DescriptionListTerm>
          <DescriptionListDescription>{subscription.name}</DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Organization</DescriptionListTerm>
          <DescriptionListDescription data-testid="subscription-organization">
            {organization || '—'}
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Created</DescriptionListTerm>
          <DescriptionListDescription>
            {subscription.creationTimestamp ? (
              <Timestamp
                date={new Date(subscription.creationTimestamp)}
                dateFormat="long"
                timeFormat="short"
                is12Hour
              />
            ) : (
              '—'
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>
    </StackItem>
  </Stack>
);
