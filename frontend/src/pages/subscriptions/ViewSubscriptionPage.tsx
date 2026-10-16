// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/ViewSubscriptionPage.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/ViewSubscriptionPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Telemetry is dropped; a viewer gets no actions; the console adds the Organization.
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Breadcrumb, BreadcrumbItem, PageSection, Tab, Tabs, TabTitleText } from '@patternfly/react-core';
import type { SubscriptionsService } from '../../api/subscriptions';
import type { MaaSModelRefSummary, MaaSSubscription, SubscriptionInfoResponse } from '../../api/types';
import { MaasModelsSection } from '../../components/MaasModelsSection';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import type { GovernanceService } from '../../context/useMaaSGovernanceContext';
import { useMaaSGovernanceContext } from '../../context/useMaaSGovernanceContext';
import { useGetSubscriptionInfo } from '../../hooks/useGetSubscriptionInfo';
import { modelRefsToSummaries } from '../../utilities/authpolicies';
import { getBackUrl, getSubscriptionEditUrl } from '../../utilities/maasGovernanceNavigation';
import { ApplicationsPage } from './ApplicationsPage';
import { DeleteSubscriptionModal } from './DeleteSubscriptionModal';
import { SubscriptionDetailsSection } from './viewSubscription/SubscriptionDetailsSection';
import { SubscriptionGroupsSection } from './viewSubscription/SubscriptionGroupsSection';

type ActionsProps = { service: SubscriptionsService; subscription: MaaSSubscription; returnTo: string };

const SubscriptionActions: React.FC<ActionsProps> = ({ service, subscription, returnTo }) => {
  const navigate = useNavigate();
  const { refresh } = useMaaSGovernanceContext();
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  return (
    <>
      <SimpleMenuActions
        testId="subscription-actions-toggle"
        ariaLabel={`Actions for ${subscription.displayName ?? subscription.name}`}
        dropdownItems={[
          {
            key: 'edit',
            label: 'Edit',
            onClick: () => navigate(getSubscriptionEditUrl(subscription.name), { state: { returnTo } }),
            isDisabled: !!subscription.deletionTimestamp,
          },
          { isSpacer: true },
          {
            key: 'delete',
            label: 'Delete',
            onClick: () => setIsDeleteOpen(true),
            isDisabled: !!subscription.deletionTimestamp,
          },
        ]}
      />
      {isDeleteOpen && (
        <DeleteSubscriptionModal
          service={service}
          subscription={subscription}
          onClose={(deleted) => {
            setIsDeleteOpen(false);
            if (deleted) {
              refresh();
              navigate(returnTo, { state: { notice: 'Subscription deleted' } });
            }
          }}
        />
      )}
    </>
  );
};

const viewModelRefSummaries = (info: SubscriptionInfoResponse): MaaSModelRefSummary[] =>
  modelRefsToSummaries(
    Array.isArray(info.subscription.modelRefs) ? info.subscription.modelRefs : [],
    Array.isArray(info.modelRefs) ? info.modelRefs : [],
  );

type Props = { service: GovernanceService };

export const ViewSubscriptionPage: React.FC<Props> = ({ service }) => {
  const { subscriptionName = '' } = useParams<{ subscriptionName: string }>();
  const location = useLocation();
  const [subscriptionInfo, loaded, loadError, reload] = useGetSubscriptionInfo(service, subscriptionName);
  const { canWrite, organizations } = useMaaSGovernanceContext();
  const displaySubscriptionName = subscriptionInfo?.subscription.displayName?.trim() || subscriptionName;
  const backUrl = getBackUrl(location.state, 'subscriptions');
  const organizationId = subscriptionInfo?.subscription.tokenMetadata?.organizationId ?? '';
  const organization = organizations.find((o) => o.id === organizationId)?.name ?? organizationId;

  return (
    <ApplicationsPage
      title={displaySubscriptionName}
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to={backUrl} data-testid="breadcrumb-subscriptions-link">
              Subscriptions
            </Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{displaySubscriptionName}</BreadcrumbItem>
        </Breadcrumb>
      }
      headerAction={
        subscriptionInfo &&
        canWrite && (
          <SubscriptionActions service={service} subscription={subscriptionInfo.subscription} returnTo={backUrl} />
        )
      }
      loaded={loaded || !!loadError}
      loadError={loadError}
      errorMessage="Unable to load subscription details."
      onRetry={() => void reload()}
    >
      {loaded && subscriptionInfo && (
        <Tabs activeKey="details" aria-label="Subscription detail tabs" inset={{ default: 'insetNone' }}>
          <Tab
            eventKey="details"
            title={<TabTitleText>Details</TabTitleText>}
            aria-label="Subscription details tab"
            data-testid="subscription-details-tab"
          >
            <PageSection hasBodyWrapper={false} className="pf-v6-u-pb-xl">
              <SubscriptionDetailsSection
                subscription={subscriptionInfo.subscription}
                modelRegistrations={subscriptionInfo.modelRegistrations ?? []}
                organization={organization}
              />
            </PageSection>
            <PageSection hasBodyWrapper={false} className="pf-v6-u-pb-xl">
              <SubscriptionGroupsSection groups={subscriptionInfo.subscription.owner.groups} />
            </PageSection>
            <PageSection hasBodyWrapper={false} className="pf-v6-u-pb-xl">
              <MaasModelsSection
                modelRefSummaries={viewModelRefSummaries(subscriptionInfo)}
                modelRefsWithRateLimits={subscriptionInfo.subscription.modelRefs}
              />
            </PageSection>
          </Tab>
        </Tabs>
      )}
    </ApplicationsPage>
  );
};
