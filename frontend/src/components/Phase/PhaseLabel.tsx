// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/Phase/PhaseLabel.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/Phase/PhaseLabel.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useState } from 'react';
import { Content, Flex, FlexItem, Label } from '@patternfly/react-core';
import type { AffectedModel } from '../../utilities/phaseLabelUtils';
import {
  getModalSubtitle,
  getPhaseProps,
  getStatusSubtext,
  getSubtextProps,
  normalizePhase,
  PhaseStatus,
} from '../../utilities/phaseLabelUtils';
import { PhaseModal } from './PhaseModal';

type Props = {
  phase: string | undefined;
  statusMessage?: string;
  reason?: string;
  resourceName: string;
  status?: string;
  conditionType?: string;
  lastTransitionTime?: string;
  affectedModels?: AffectedModel[];
  overviewLoaded?: boolean;
};

/** A subscription's phase; anything but Ready opens the status modal. */
export const PhaseLabel: React.FC<Props> = ({
  phase,
  statusMessage,
  reason,
  resourceName,
  status,
  conditionType,
  lastTransitionTime,
  affectedModels,
  overviewLoaded = false,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [hasOpenedModal, setHasOpenedModal] = useState(false);

  const normalized = normalizePhase(phase);
  const phaseProps = getPhaseProps(normalized);
  const isClickable = normalized !== PhaseStatus.READY;
  const statusSubtext = getStatusSubtext(normalized, statusMessage);
  const subtextProps = getSubtextProps(normalized);

  const handleClick = () => {
    setHasOpenedModal(true);
    setIsModalOpen(true);
  };

  return (
    <>
      <Flex>
        <FlexItem>
          <Label
            variant={isClickable ? 'filled' : 'outline'}
            isCompact
            isClickable={isClickable}
            data-testid="phase-label"
            {...phaseProps}
            onClick={isClickable ? handleClick : undefined}
          >
            {normalized}
          </Label>
        </FlexItem>
      </Flex>
      {statusSubtext && subtextProps ? (
        <Content component="small" {...subtextProps} data-testid="phase-label-subtext">
          {statusSubtext}
        </Content>
      ) : null}
      {isClickable && hasOpenedModal ? (
        <PhaseModal
          phase={normalized}
          statusMessage={statusMessage}
          reason={reason}
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          subtitle={getModalSubtitle()}
          resourceName={resourceName}
          status={status}
          conditionType={conditionType}
          lastTransitionTime={lastTransitionTime}
          affectedModels={affectedModels}
          overviewLoaded={overviewLoaded}
        />
      ) : null}
    </>
  );
};
