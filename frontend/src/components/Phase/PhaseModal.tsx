// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/Phase/PhaseModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/Phase/PhaseModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's "View details" footer needs a returnTo that its pages never pass, so it isn't ported.
import {
  Alert,
  Bullseye,
  Content,
  Flex,
  FlexItem,
  Label,
  Modal,
  ModalBody,
  ModalHeader,
  Spinner,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import type { AffectedModel } from '../../utilities/phaseLabelUtils';
import { getModalAlertProps, getPhaseProps, normalizePhase, PhaseStatus } from '../../utilities/phaseLabelUtils';
import { AffectedModelsTable } from './AffectedModelsTable';

type Props = {
  phase: string;
  statusMessage?: string;
  reason?: string;
  isOpen: boolean;
  onClose: () => void;
  subtitle: string;
  resourceName: string;
  status?: string;
  conditionType?: string;
  lastTransitionTime?: string;
  affectedModels?: AffectedModel[];
  overviewLoaded?: boolean;
};

const ModalTitle: React.FC<{ resourceName: string; phase: string; subtitle: string }> = ({
  resourceName,
  phase,
  subtitle,
}) => {
  const phaseProps = getPhaseProps(phase);
  return (
    <Stack>
      <StackItem>
        <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>{resourceName}</FlexItem>
          <FlexItem>
            <Label status={phaseProps.status} color={phaseProps.color} icon={phaseProps.icon}>
              {phase}
            </Label>
          </FlexItem>
        </Flex>
      </StackItem>
      <StackItem>
        <Content component="small" data-testid="phase-modal-subtitle">
          {subtitle}
        </Content>
      </StackItem>
    </Stack>
  );
};

/** A subscription's status: what its phase means, its condition, and the models affecting it. */
export const PhaseModal: React.FC<Props> = ({
  phase,
  statusMessage,
  reason,
  isOpen,
  onClose,
  subtitle = 'Status',
  resourceName,
  status,
  conditionType,
  lastTransitionTime,
  affectedModels,
  overviewLoaded,
}) => {
  const showAffectedSection = phase === PhaseStatus.DEGRADED;
  const hasAffectedModels = (affectedModels?.length ?? 0) > 0;
  const isAffectedModelsLoading = showAffectedSection && affectedModels === undefined && overviewLoaded === false;
  const showAffectedModels = showAffectedSection && (hasAffectedModels || isAffectedModelsLoading);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${phase} Subscription`} variant="medium" data-testid="phase-modal">
      <ModalHeader
        title={<ModalTitle resourceName={resourceName} phase={normalizePhase(phase)} subtitle={subtitle} />}
      />
      <ModalBody>
        <Stack hasGutter>
          <StackItem>
            <Alert
              {...getModalAlertProps(phase, statusMessage, reason, status, conditionType, lastTransitionTime)}
              data-testid="phase-modal-alert"
            />
          </StackItem>
          {showAffectedModels ? (
            <StackItem>
              {isAffectedModelsLoading ? (
                <Bullseye>
                  <Spinner size="lg" aria-label="Loading affected models" />
                </Bullseye>
              ) : (
                <AffectedModelsTable models={affectedModels ?? []} />
              )}
            </StackItem>
          ) : null}
        </Stack>
      </ModalBody>
    </Modal>
  );
};
