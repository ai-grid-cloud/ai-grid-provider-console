// Adapted from odh-dashboard packages/model-serving DeploymentStatusModal and
// llmd-serving getLLMdDeploymentConditions (Progress tab only).
// The backend reports one phase, reason and message per cluster (status.clusters). The stepper is
// the same shape the dashboard shows for a deployment, filled from that phase: the fake and git
// mode do not send the full LLMInferenceService condition tree.
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Flex,
  FlexItem,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalHeader,
  ProgressStep,
  ProgressStepper,
  Stack,
  StackItem,
  Tab,
  Tabs,
  TabTitleText,
  Timestamp,
  TimestampTooltipVariant,
  Title,
} from '@patternfly/react-core';
import { InfoCircleIcon } from '@patternfly/react-icons';
import { EMPTY_VALUE } from '../../utilities/format';
import { statusLabelProps } from '../../utilities/status';
import { siteDeploymentConditions, type DeploymentCondition } from './siteDeploymentConditions';
import { statusModalLayout } from './statusModalLayout';

type ConditionStatus = 'True' | 'False' | 'Unknown';

type Props = {
  /** The model's display name. */
  title: string;
  /** The phase the backend reports for this cluster. */
  phase: string;
  /** The location as the table shows it, for example "Paris DC1 (paris)". */
  locationLabel: string;
  /** The cluster name, shown when it is not already the location text. */
  cluster: string;
  reason?: string;
  message?: string;
  createdAt?: string;
  onClose: () => void;
};

const stepVariant = (status: ConditionStatus) => {
  if (status === 'True') {
    return 'success' as const;
  }
  if (status === 'False') {
    return 'danger' as const;
  }
  return 'pending' as const;
};

const ConditionTimestamp: React.FC<{ isoString?: string }> = ({ isoString }) => {
  if (!isoString) {
    return null;
  }
  return (
    <Timestamp
      date={new Date(isoString)}
      tooltip={{ variant: TimestampTooltipVariant.default }}
      dateFormat="long"
      timeFormat="long"
    />
  );
};

const ConditionChildren: React.FC<{ children: DeploymentCondition[] }> = ({ children }) => (
  <ProgressStepper isVertical style={{ paddingTop: 'var(--pf-t--global--spacer--sm)' }}>
    {children.map((child) => (
      <ProgressStep
        key={child.type}
        variant={stepVariant(child.status)}
        aria-label={`${child.label}: ${child.status}`}
        id={`condition-child-${child.type}`}
        titleId={`condition-child-${child.type}-title`}
        description={<ConditionTimestamp isoString={child.lastTransitionTime} />}
        data-testid={`deployment-condition-${child.type}`}
      >
        {child.label}
      </ProgressStep>
    ))}
  </ProgressStepper>
);

/** Per-location deployment status: what the cluster reported, and a progress stepper for that phase. */
export const DeploymentStatusModal: React.FC<Props> = ({
  title,
  phase,
  locationLabel: locationText,
  cluster,
  reason,
  message,
  createdAt,
  onClose,
}) => {
  const conditions = siteDeploymentConditions(phase, createdAt);

  return (
    <Modal
      {...statusModalLayout}
      isOpen
      onClose={onClose}
      data-testid="deployment-status-modal"
      aria-label={`${title} at ${locationText}`}
    >
      <ModalHeader
        data-testid="deployment-status-modal-header"
        style={{ '--pf-v6-c-modal-box__header--Gap': 'var(--pf-t--global--spacer--sm)' } as CSSProperties}
      >
        <Title headingLevel="h1" size="2xl" data-testid="deployment-status-title">
          <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>{title} status</FlexItem>
            <FlexItem>
              <Label isCompact {...statusLabelProps(phase)} variant="filled" data-testid="model-status-text">
                {phase}
              </Label>
            </FlexItem>
          </Flex>
        </Title>
        <p data-testid="deployment-status-subtitle">
          <strong>Deployment status</strong> for{' '}
          <Label isCompact color="grey" data-testid="deployment-status-location">
            {locationText}
          </Label>
          {locationText !== cluster && (
            <>
              {' '}
              on cluster <Link to={`/clusters/${encodeURIComponent(cluster)}`}>{cluster}</Link>
            </>
          )}
        </p>
      </ModalHeader>
      <ModalBody>
        <Stack hasGutter>
          <StackItem>
            <DescriptionList isCompact aria-label={`What ${cluster} reported`}>
              <DescriptionListGroup>
                <DescriptionListTerm>
                  <strong>Reason</strong>
                </DescriptionListTerm>
                <DescriptionListDescription>{reason || EMPTY_VALUE}</DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>
                  <strong>Message</strong>
                </DescriptionListTerm>
                <DescriptionListDescription>{message ?? EMPTY_VALUE}</DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          </StackItem>
          <StackItem>
            <Tabs activeKey="progress" aria-label="Deployment status tabs" data-testid="deployment-status-tabs">
              <Tab
                eventKey="progress"
                aria-label="progress"
                title={<TabTitleText>Progress</TabTitleText>}
                data-testid="deployment-status-progress-tab"
              />
            </Tabs>
          </StackItem>
          <StackItem>
            <Stack hasGutter>
              <StackItem>
                <HelperText data-testid="deployment-status-progress-disclaimer">
                  <HelperTextItem
                    variant="indeterminate"
                    icon={<InfoCircleIcon style={{ color: 'var(--pf-t--global--color--nonstatus--purple--400)' }} />}
                    style={{ fontWeight: 'var(--pf-t--global--font--weight--body--bold)' }}
                  >
                    Steps may occur in any order, depending on the deployment type.
                  </HelperTextItem>
                </HelperText>
              </StackItem>
              <StackItem>
                <ProgressStepper isVertical data-testid="deployment-status-steps">
                  {conditions.map((condition) => (
                    <ProgressStep
                      key={condition.type}
                      variant={stepVariant(condition.status)}
                      aria-label={`${condition.label}: ${condition.status}`}
                      id={`condition-${condition.type}`}
                      titleId={`condition-${condition.type}-title`}
                      description={
                        <>
                          <ConditionTimestamp isoString={condition.lastTransitionTime} />
                          {condition.children && condition.children.length > 0 && (
                            <ConditionChildren>{condition.children}</ConditionChildren>
                          )}
                        </>
                      }
                      data-testid={`deployment-condition-${condition.type}`}
                    >
                      {condition.label}
                    </ProgressStep>
                  ))}
                </ProgressStepper>
              </StackItem>
            </Stack>
          </StackItem>
        </Stack>
      </ModalBody>
    </Modal>
  );
};
