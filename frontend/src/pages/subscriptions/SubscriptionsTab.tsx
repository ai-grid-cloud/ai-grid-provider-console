// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/maas-governance/SubscriptionsTab.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/maas-governance/SubscriptionsTab.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Telemetry is dropped; a 501 shows the console's not-available state.
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  AlertActionCloseButton,
  Bullseye,
  Button,
  EmptyState,
  EmptyStateBody,
  EmptyStateVariant,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { ServiceError } from '../../api/ConsoleService';
import type { MaaSSubscription } from '../../api/types';
import { LoadError } from '../../components/LoadError';
import type { GovernanceService } from '../../context/useMaaSGovernanceContext';
import { useMaaSGovernanceContext } from '../../context/useMaaSGovernanceContext';
import type { SubscriptionsFilterDataType } from './allSubscriptions/const';
import { initialSubscriptionsFilterData, SubscriptionsFilterOptions } from './allSubscriptions/const';
import { SubscriptionsTable } from './allSubscriptions/SubscriptionsTable';
import { SubscriptionsToolbar } from './allSubscriptions/SubscriptionsToolbar';
import { DeleteSubscriptionModal } from './DeleteSubscriptionModal';
import { EmptyStatePage } from './EmptyStatePage';

type Props = { service: GovernanceService };

export const SubscriptionsTab: React.FC<Props> = ({ service }) => {
  const {
    subscriptions,
    subscriptionsLoaded: loaded,
    subscriptionsError: error,
    organizations,
    refresh,
    canWrite,
  } = useMaaSGovernanceContext();
  const [filterData, setFilterData] = useState<SubscriptionsFilterDataType>(initialSubscriptionsFilterData);
  const [notice, setNotice] = useState(false);
  const [deleteSubscription, setDeleteSubscription] = useState<MaaSSubscription>();

  const onFilterUpdate = useCallback(
    (key: SubscriptionsFilterOptions, value?: string) => setFilterData((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const onClearFilters = useCallback(() => setFilterData(initialSubscriptionsFilterData), []);

  const organizationName = useCallback(
    (s: MaaSSubscription) => {
      const id = s.tokenMetadata?.organizationId ?? '';
      return organizations.find((o) => o.id === id)?.name ?? id;
    },
    [organizations],
  );

  const filteredSubscriptions = useMemo(() => {
    const keyword = filterData[SubscriptionsFilterOptions.keyword]?.toLowerCase();
    return keyword
      ? subscriptions.filter(
          (sub) =>
            sub.name.toLowerCase().includes(keyword) ||
            sub.displayName?.toLowerCase().includes(keyword) ||
            sub.description?.toLowerCase().includes(keyword),
        )
      : subscriptions;
  }, [subscriptions, filterData]);

  if (!loaded && !error) {
    return (
      <PageSection isFilled>
        <Bullseye>
          <Spinner aria-label="Loading subscriptions" />
        </Bullseye>
      </PageSection>
    );
  }

  if (error instanceof ServiceError && error.isNotImplemented) {
    return (
      <PageSection isFilled>
        <LoadError subject="Subscriptions" error={error} />
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection isFilled>
        <EmptyState
          headingLevel="h2"
          icon={ExclamationCircleIcon}
          titleText="Error loading subscriptions"
          variant={EmptyStateVariant.lg}
          data-testid="error-empty-state"
        >
          <EmptyStateBody data-testid="error-empty-state-body">
            {error.message}
            <div>
              <Button variant="link" onClick={refresh}>
                Retry
              </Button>
            </div>
          </EmptyStateBody>
        </EmptyState>
      </PageSection>
    );
  }

  if (subscriptions.length === 0) {
    return (
      <EmptyStatePage
        testId="empty-subscriptions-page"
        title="No subscriptions"
        bodyText="Subscriptions define token limits for model access. Create a subscription to control usage for each user group."
        showSubsButton={canWrite}
      />
    );
  }

  return (
    <>
      {notice && (
        <Alert
          variant="success"
          isInline
          title="Subscription deleted"
          actionClose={<AlertActionCloseButton onClose={() => setNotice(false)} />}
        />
      )}
      <PageSection isFilled>
        <SubscriptionsTable
          subscriptions={filteredSubscriptions}
          organizationName={organizationName}
          onClearFilters={onClearFilters}
          toolbarContent={
            <SubscriptionsToolbar filterData={filterData} onFilterUpdate={onFilterUpdate} canWrite={canWrite} />
          }
          canWrite={canWrite}
          setDeleteSubscription={setDeleteSubscription}
        />
      </PageSection>
      {deleteSubscription && (
        <DeleteSubscriptionModal
          service={service}
          subscription={deleteSubscription}
          onClose={(deleted) => {
            setDeleteSubscription(undefined);
            if (deleted) {
              setNotice(true);
              refresh();
            }
          }}
        />
      )}
    </>
  );
};
