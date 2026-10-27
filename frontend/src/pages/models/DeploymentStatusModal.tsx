// Adapted from opendatahub-io/odh-dashboard
// packages/model-serving/src/components/deployments/DeploymentStatusModal.tsx
// upstream commit: 6f47c0f775d19c89ef02f74d192b32dc7d3c669d
// One location's status in jgiardino's Models design ("models per cluster"): the model on one
// cluster. odh's Progress tab steps through the deployment's conditions; here the steps are the
// ManifestWork's own, as the cluster's agent reported them (docs/plan/bff-api.md, `works[]`), and
// nothing is filled in: a step the agent hasn't reported is pending, with no time. Kueue, the
// Resources tab and tracking are odh's and are dropped, and so is Stop deployment: stopping the
// model removes it from every location, which a dialog about one location shouldn't offer.
import {
  Button,
  Content,
  ContentVariants,
  Flex,
  FlexItem,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ProgressStep,
  ProgressStepper,
  Stack,
  StackItem,
  Tab,
  TabTitleText,
  Tabs,
  Timestamp,
  TimestampTooltipVariant,
} from '@patternfly/react-core';
import type { ProgressStepProps } from '@patternfly/react-core';
import { InProgressIcon, InfoCircleIcon } from '@patternfly/react-icons';
import type { Condition, ManagedModel, ModelWork } from '../../api/types';
import { getPhaseProps } from '../../utilities/phaseLabelUtils';

type Props = {
  model: ManagedModel;
  work: ModelWork;
  /** The location as the page names it, such as "Paris DC1 (paris)", or the cluster's name. */
  location: string;
  onClose: () => void;
  /** Opens the model's edit page; absent for a viewer. */
  onEdit?: () => void;
};

/** One step: a condition's status, or "in progress" for a rule the spoke is still working through. */
type Step = {
  id: string;
  label: string;
  status?: Condition['status'] | 'InProgress';
  time?: string;
  message?: string;
};

const variantOf = (status: Step['status']): ProgressStepProps['variant'] => {
  switch (status) {
    case 'True':
      return 'success';
    case 'False':
      return 'danger';
    default:
      return 'pending';
  }
};

/**
 * The work's steps, in the order the agent reports them (mock/areas/models.md): applied, then its
 * resources available, then the template's rules on the spoke object (Progressing until its Ready
 * is True, Degraded when it fails for good), then the spoke's `ready` feedback.
 */
const stepsOf = (work: ModelWork): Step[] => {
  const condition = (type: string) => work.conditions.find((c) => c.type === type);
  const applied = condition('Applied');
  const available = condition('Available');
  const progressing = condition('Progressing');
  const degraded = condition('Degraded');
  const fromCondition = (id: string, label: string, c?: Condition): Step => ({
    id,
    label,
    status: c?.status,
    time: c?.lastTransitionTime,
    message: c?.message,
  });
  let workload: Step = { id: 'workload', label: 'Model started on the cluster' };
  if (degraded?.status === 'True') {
    workload = fromCondition('workload', workload.label, { ...degraded, status: 'False' });
  } else if (progressing?.status === 'True') {
    workload = { ...fromCondition('workload', workload.label, progressing), status: 'InProgress' };
  } else if (progressing?.status === 'False') {
    workload = { ...fromCondition('workload', workload.label, progressing), status: 'True' };
  }
  return [
    fromCondition('applied', 'Applied on the cluster', applied),
    fromCondition('available', 'Resources available', available),
    workload,
    {
      id: 'ready',
      label: 'Model ready',
      status: work.ready === 'True' ? 'True' : degraded?.status === 'True' ? 'False' : undefined,
    },
  ];
};

const StepDescription: React.FC<{ step: Step }> = ({ step }) => (
  <>
    {step.time && (
      <Timestamp
        date={new Date(step.time)}
        tooltip={{ variant: TimestampTooltipVariant.default }}
        dateFormat="long"
        timeFormat="long"
      />
    )}
    {step.message && (step.status === 'False' || step.status === 'Unknown') && (
      <Content
        component={ContentVariants.small}
        style={
          step.status === 'False' ? { color: 'var(--pf-t--global--text--color--status--danger--default)' } : undefined
        }
      >
        {step.message}
      </Content>
    )}
  </>
);

/** The model's status on one location: a stepper of what that cluster's agent reported. */
export const DeploymentStatusModal: React.FC<Props> = ({ model, work, location, onClose, onEdit }) => {
  const title = model.displayName ?? model.name;
  const { icon, status, color } = getPhaseProps(work.phase);
  const steps = stepsOf(work);
  return (
    <Modal
      isOpen
      variant="medium"
      onClose={onClose}
      aria-labelledby="deployment-status-modal-title"
      data-testid="deployment-status-modal"
    >
      <ModalHeader
        labelId="deployment-status-modal-title"
        title={
          <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>{title} status</FlexItem>
            <FlexItem>
              <Label isCompact variant="outline" icon={icon} status={status} color={color}>
                {work.phase}
              </Label>
            </FlexItem>
          </Flex>
        }
        description={
          <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>
              <Label color="grey">{location}</Label>
            </FlexItem>
            {location !== work.cluster && <FlexItem>on cluster {work.cluster}</FlexItem>}
          </Flex>
        }
      />
      <ModalBody>
        <Stack hasGutter>
          <StackItem>
            {/* A single tab, as odh keeps its tab strip for the tabs it adds later. */}
            <Tabs activeKey="progress" aria-label="Deployment status tabs">
              <Tab eventKey="progress" title={<TabTitleText>Progress</TabTitleText>} />
            </Tabs>
          </StackItem>
          <StackItem>
            <HelperText>
              <HelperTextItem icon={<InfoCircleIcon />}>
                Each step is what this cluster last reported; a step it hasn’t reported yet is pending.
              </HelperTextItem>
            </HelperText>
          </StackItem>
          <StackItem>
            <ProgressStepper isVertical aria-label={`Progress of ${title} on ${location}`}>
              {steps.map((step) => (
                <ProgressStep
                  key={step.id}
                  id={`deployment-step-${step.id}`}
                  titleId={`deployment-step-${step.id}-title`}
                  variant={variantOf(step.status)}
                  icon={step.status === 'InProgress' ? <InProgressIcon /> : undefined}
                  aria-label={`${step.label}: ${step.status === 'InProgress' ? 'in progress' : (step.status ?? 'pending')}`}
                  description={<StepDescription step={step} />}
                  data-testid={`deployment-step-${step.id}`}
                >
                  {step.label}
                </ProgressStep>
              ))}
            </ProgressStepper>
          </StackItem>
        </Stack>
      </ModalBody>
      {onEdit && (
        <ModalFooter>
          <Button variant="link" onClick={onEdit}>
            Edit deployment
          </Button>
        </ModalFooter>
      )}
    </Modal>
  );
};
