// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/maas-governance/SubscriptionsTab.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/maas-governance/SubscriptionsTab.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Telemetry is dropped; a 501 shows the console's not-available state.
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  AlertActionCloseButton,
  AlertActionLink,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  EmptyStateVariant,
  PageSection,
} from '@patternfly/react-core';
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { ServiceError } from '../../api/ConsoleService';
import type { ClustersService } from '../../api/clusters';
import type { MaaSSubscription } from '../../api/types';
import { LoadError } from '../../components/LoadError';
import { PageLoading } from '../../components/PageLoading';
import type { GovernanceService } from '../../context/useMaaSGovernanceContext';
import { useMaaSGovernanceContext } from '../../context/useMaaSGovernanceContext';
import { useServiceData } from '../../hooks/useServiceData';
import { isSameModel } from '../../utilities/authpolicies';
import { siteNamesOf } from '../models/modelUtils';
import type { SubscriptionsFilterDataType } from './allSubscriptions/const';
import { initialSubscriptionsFilterData, SubscriptionsFilterOptions } from './allSubscriptions/const';
import type { ModelsState } from './allSubscriptions/ExpandedModelsPanel';
import { SubscriptionsTable } from './allSubscriptions/SubscriptionsTable';
import { SubscriptionsToolbar } from './allSubscriptions/SubscriptionsToolbar';
import { DeleteSubscriptionModal } from './DeleteSubscriptionModal';
import { EmptyStatePage } from './EmptyStatePage';

// The clusters name the models' locations' sites, as on the Models page.
type Props = { service: GovernanceService & Pick<ClustersService, 'listClusters'> };

export const SubscriptionsTab: React.FC<Props> = ({ service }) => {
  const {
    subscriptions,
    subscriptionsLoaded: loaded,
    subscriptionsError: error,
    organizations,
    modelRefs: models,
    modelRefsLoaded,
    modelRefsError,
    refresh,
    canWrite,
  } = useMaaSGovernanceContext();
  // Loaded once, as the Models page does: a site name rarely changes, and without one (or without
  // the clusters) a location shows as itself.
  const [clusters] = useServiceData(() => service.listClusters(), [], 0);
  const siteNames = useMemo(() => siteNamesOf(clusters), [clusters]);
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

  // The hub's models fill in the models' locations and let the model filter match their display
  // name and description. When their last load failed, only what the subscriptions say is known.
  let modelsState: ModelsState = 'loading';
  if (modelRefsLoaded) {
    modelsState = modelRefsError ? 'failed' : 'loaded';
  }

  const filteredSubscriptions = useMemo(() => {
    const keyword = filterData[SubscriptionsFilterOptions.keyword]?.trim().toLowerCase();
    const model = filterData[SubscriptionsFilterOptions.model]?.trim().toLowerCase();
    const group = filterData[SubscriptionsFilterOptions.group]?.trim().toLowerCase();
    const matches = (term: string, ...values: (string | undefined)[]) =>
      values.some((value) => value?.toLowerCase().includes(term));
    return subscriptions.filter(
      (sub) =>
        (!keyword || matches(keyword, sub.name, sub.displayName, sub.description)) &&
        // A model matches by its name (ID), display name or description, from the reference or the
        // hub's model.
        (!model ||
          sub.modelRefs.some((ref) => {
            const hub = models.find((m) => isSameModel(m, ref));
            return matches(model, ref.name, ref.displayName, ref.description, hub?.displayName, hub?.description);
          })) &&
        (!group || sub.owner.groups.some((g) => matches(group, g.name))),
    );
  }, [subscriptions, models, filterData]);

  if (!loaded && !error) {
    return <PageLoading label="Loading subscriptions" />;
  }

  if (error instanceof ServiceError && (error.isNotImplemented || error.isUnauthenticated)) {
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
          <EmptyStateBody data-testid="error-empty-state-body">{error.message}</EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="link" onClick={refresh}>
                Retry
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
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
        {modelsState === 'failed' && (
          <Alert
            isInline
            variant="warning"
            title="The hub's models could not be loaded"
            actionLinks={<AlertActionLink onClick={refresh}>Retry</AlertActionLink>}
            className="pf-v6-u-mb-md"
            data-testid="subscriptions-models-unavailable"
          >
            The models' locations aren't shown, and the model filter matches only the names and descriptions the
            subscriptions give their models.
          </Alert>
        )}
        <SubscriptionsTable
          subscriptions={filteredSubscriptions}
          organizationName={organizationName}
          models={models}
          modelsState={modelsState}
          siteNames={siteNames}
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
