// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/CreateSubscriptionPage.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/CreateSubscriptionPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's preSelectedModel and breadcrumbLabel router state are dropped: nothing sets them.
import { useState } from 'react';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import { PageStateSection } from '../../components/states/PageStateSection';
import { getBackUrl } from '../../utilities/maasGovernanceNavigation';
import { CreateSubscriptionForm } from './createSubscription/CreateSubscriptionForm';
import { useModelList } from '../models/useModels';
import { SubscriptionSchema } from '../../gen/ai_grid/v1/subscription_type_pb';
import { useBackgroundWrites } from '../../notifications/useBackgroundWrites';

export const CreateSubscriptionPage: React.FC = () => {
  const { data: models, loaded, error, refresh } = useModelList();
  const { state } = useLocation();
  // A create the backend refused after the form had left reopens it (the toast's ?draft= link) with
  // exactly what was sent, and the refusal as the form's error.
  const { draftOf } = useBackgroundWrites();
  const [searchParams] = useSearchParams();
  const [draft] = useState(() => {
    const id = searchParams.get('draft');
    const kept = id ? draftOf(id) : undefined;
    if (kept?.subject !== 'subscription') return undefined;
    try {
      return { subscription: fromJson(SubscriptionSchema, kept.values as JsonValue), error: kept.error };
    } catch {
      return undefined;
    }
  });
  const backUrl = getBackUrl(state, 'subscriptions');

  return (
    <PageStateSection
      title="Create subscription"
      description="Configure models available with this subscription, token limits for each one, and assign user groups as members to grant them access."
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
      loaded={loaded}
      error={error}
      onRetry={() => void refresh()}
      subject="Subscriptions"
      loadingLabel="Loading subscription form"
      hasBodyWrapper={false}
    >
      <CreateSubscriptionForm models={models} returnTo={backUrl} draft={draft} />
    </PageStateSection>
  );
};
