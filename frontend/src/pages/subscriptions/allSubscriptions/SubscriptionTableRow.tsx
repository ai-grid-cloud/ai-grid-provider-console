// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/SubscriptionTableRow.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/SubscriptionTableRow.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization cell, and a viewer gets only View details.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Content, ContentVariants, Tooltip } from '@patternfly/react-core';
import { ActionsColumn, ExpandableRowContent, Tbody, Td, Tr } from '@patternfly/react-table';
import type { IAction } from '@patternfly/react-table';
import type { MaaSSubscription } from '../../../api/types';
import { CompoundExpandCountCell } from '../../../components/CompoundExpandCountCell';
import { ExpandedGroupsPanel } from '../../../components/ExpandedGroupsPanel';
import { ExpandedModelsPanel } from '../../../components/ExpandedModelsPanel';
import { PhaseLabel } from '../../../components/Phase/PhaseLabel';
import { TableRowTitleDescription } from '../../../components/TableRowTitleDescription';
import { useSubscriptionAffectedModels } from '../../../hooks/useGovernanceAffectedModels';
import { getSubscriptionEditUrl, getSubscriptionViewUrl } from '../../../utilities/maasGovernanceNavigation';
import type { SubscriptionColumn } from './columns';
import { GROUPS_COLUMN, MODELS_COLUMN } from './columns';

type Props = {
  subscription: MaaSSubscription;
  columns: SubscriptionColumn[];
  organization: string;
  rowIndex: number;
  canWrite: boolean;
  setDeleteSubscription: (subscription: MaaSSubscription) => void;
};

type ExpandedPanel = 'groups' | 'models' | null;

export const SubscriptionTableRow: React.FC<Props> = ({
  subscription,
  columns,
  organization,
  rowIndex,
  canWrite,
  setDeleteSubscription,
}) => {
  const navigate = useNavigate();
  const [expandedPanel, setExpandedPanel] = useState<ExpandedPanel>(null);
  const { affectedModels, overviewLoaded } = useSubscriptionAffectedModels(subscription);
  const togglePanel = (panel: 'groups' | 'models') => setExpandedPanel((prev) => (prev === panel ? null : panel));
  const groups = Array.isArray(subscription.owner.groups) ? subscription.owner.groups : [];
  const deleting = !!subscription.deletionTimestamp;
  const title = subscription.displayName ?? subscription.name;

  const actions: IAction[] = [
    { title: 'View details', onClick: () => navigate(getSubscriptionViewUrl(subscription.name)) },
    ...(canWrite
      ? [
          { title: 'Edit', onClick: () => navigate(getSubscriptionEditUrl(subscription.name)) },
          { isSeparator: true },
          { title: 'Delete', onClick: () => setDeleteSubscription(subscription) },
        ]
      : []),
  ];

  return (
    <Tbody isExpanded={expandedPanel !== null}>
      <Tr
        isControlRow
        isContentExpanded={expandedPanel !== null}
        aria-disabled={deleting || undefined}
        data-testid="subscription-row"
      >
        <Td dataLabel={columns[0].label}>
          <TableRowTitleDescription
            title={
              deleting ? (
                <span data-testid="subscription-name">{title}</span>
              ) : (
                <Tooltip content={`Resource name: ${subscription.name}`}>
                  <Link to={getSubscriptionViewUrl(subscription.name)}>{title}</Link>
                </Tooltip>
              )
            }
            description={subscription.description ?? ''}
            truncateDescriptionLines={2}
          />
        </Td>
        <Td dataLabel={columns[1].label} data-testid="subscription-organization">
          {organization || '-'}
        </Td>
        <Td dataLabel={columns[2].label}>
          <PhaseLabel
            phase={subscription.phase}
            statusMessage={subscription.statusMessage}
            reason={subscription.reason}
            status={subscription.status}
            conditionType={subscription.conditionType}
            lastTransitionTime={subscription.lastTransitionTime}
            resourceName={title}
            affectedModels={affectedModels}
            overviewLoaded={overviewLoaded}
          />
        </Td>
        <Td
          dataLabel={columns[GROUPS_COLUMN].label}
          compoundExpand={{
            isExpanded: expandedPanel === 'groups',
            onToggle: () => togglePanel('groups'),
            expandId: `expand-${subscription.name}-groups`,
            rowIndex,
            columnIndex: GROUPS_COLUMN,
          }}
          data-testid="subscription-groups-expand-btn"
        >
          <CompoundExpandCountCell count={groups.length} />
        </Td>
        <Td
          dataLabel={columns[MODELS_COLUMN].label}
          compoundExpand={{
            isExpanded: expandedPanel === 'models',
            onToggle: () => togglePanel('models'),
            expandId: `expand-${subscription.name}-models`,
            rowIndex,
            columnIndex: MODELS_COLUMN,
          }}
          data-testid="subscription-models-expand-btn"
        >
          <CompoundExpandCountCell count={subscription.modelRefs.length} />
        </Td>
        <Td dataLabel={columns[5].label}>
          <Content component={ContentVariants.p} className="pf-v6-u-font-weight-bold pf-v6-u-text-align-center">
            {subscription.priority ?? '-'}
          </Content>
        </Td>
        <Td isActionCell>
          <ActionsColumn data-testid="subscription-actions" isDisabled={deleting} items={actions} />
        </Td>
      </Tr>
      <Tr isExpanded={expandedPanel === 'groups'}>
        <Td colSpan={columns.length + 1}>
          <ExpandableRowContent>
            <ExpandedGroupsPanel groups={groups} />
          </ExpandableRowContent>
        </Td>
      </Tr>
      <Tr isExpanded={expandedPanel === 'models'}>
        <Td colSpan={columns.length + 1}>
          <ExpandableRowContent>
            <ExpandedModelsPanel models={subscription.modelRefs} testIdResource="subscription" showTokenLimits />
          </ExpandableRowContent>
        </Td>
      </Tr>
    </Tbody>
  );
};
