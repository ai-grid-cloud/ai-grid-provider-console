// Ported from krisv/ai-grid-cloud-provider-poc src/app/utilities/phaseLabelUtils.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/utilities/phaseLabelUtils.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Only the subscription branches are ported: the PoC's model, external model, external
// provider and policy labels have no pages here, and its telemetry helpers are dropped.
// The PoC's Saved phase is gone: the phases are MaaSSubscription's (mock/research/models-maas.md
// 3.5), and a Degraded subtext shows the Ready condition's message when there is one.
import type { AlertProps, ContentProps, LabelProps } from '@patternfly/react-core';
import { Stack, StackItem } from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  OutlinedQuestionCircleIcon,
  PendingIcon,
} from '@patternfly/react-icons';
import { PhaseApiDetails } from '../components/Phase/PhaseApiDetails';

/** A model that keeps a subscription from being Ready. */
export type AffectedModel = { name: string; displayName?: string; phase?: string; statusMessage?: string };

export enum PhaseResourceType {
  SUBSCRIPTION = 'Subscription',
}

export enum PhaseStatus {
  ACTIVE = 'Active',
  READY = 'Ready',
  PENDING = 'Pending',
  FAILED = 'Failed',
  INVALID = 'Invalid',
  DEGRADED = 'Degraded',
  UNAVAILABLE = 'Unavailable',
  UNHEALTHY = 'Unhealthy',
  UNKNOWN = 'Unknown',
}

export const getPhaseProps = (
  phase: string | undefined,
): { icon: React.ReactNode; status?: LabelProps['status']; color?: LabelProps['color'] } => {
  switch (phase) {
    case PhaseStatus.ACTIVE:
    case PhaseStatus.READY:
      return { icon: <CheckCircleIcon />, status: 'success' };
    case PhaseStatus.FAILED:
    case PhaseStatus.INVALID:
      return { icon: <ExclamationCircleIcon />, status: 'danger' };
    case PhaseStatus.UNAVAILABLE:
      return { icon: <ExclamationCircleIcon />, status: 'warning' };
    case PhaseStatus.PENDING:
      return { icon: <PendingIcon />, color: 'purple' };
    case PhaseStatus.DEGRADED:
      return { icon: <ExclamationTriangleIcon />, status: 'warning' };
    default:
      return { icon: <OutlinedQuestionCircleIcon />, color: 'grey' };
  }
};

/** The phase as the label shows it: an Active subscription reads Ready, as in odh-dashboard. */
export const normalizePhase = (phase: string | undefined): string => {
  const normalized = phase?.trim();
  if (normalized === PhaseStatus.UNHEALTHY) {
    return PhaseStatus.UNAVAILABLE;
  }
  if (normalized === PhaseStatus.ACTIVE) {
    return PhaseStatus.READY;
  }
  return normalized || PhaseStatus.UNKNOWN;
};

export const MODEL_NOT_FOUND_STATUS_MESSAGE = 'Model not found. The MaaSModelRef does not exist.';

/** The subtext under a label; for Degraded, the Ready condition's message when there is one. */
export const getStatusSubtext = (phase: string, statusMessage?: string): React.ReactNode | undefined => {
  switch (phase) {
    case PhaseStatus.FAILED:
      return 'All models unavailable or setup failed';
    case PhaseStatus.DEGRADED:
      return statusMessage || 'Models unavailable';
    case PhaseStatus.PENDING:
      return 'Setting up subscription';
    case PhaseStatus.INVALID:
      return 'Configuration error';
    default:
      return undefined;
  }
};

export const getModalSubtitle = (): string => 'Subscription status';

const getAlertContent = (phase: string): { title: string; children: string } | undefined => {
  switch (phase) {
    case PhaseStatus.FAILED:
      return {
        title: 'Subscription failed',
        children: 'Either the rate limit configuration failed, or this subscription includes no available models. ',
      };
    case PhaseStatus.DEGRADED:
      return {
        title: 'Subscription degraded',
        children: 'At least one of the models or rate limits included in this subscription is unavailable.',
      };
    case PhaseStatus.PENDING:
      return { title: 'Pending', children: 'Subscription setup is in progress.' };
    case PhaseStatus.INVALID:
      return {
        title: 'Invalid subscription configuration',
        children:
          'The subscription configuration is invalid or missing required fields. Edit the subscription and ensure its configuration is correct.',
      };
    default:
      return undefined;
  }
};

const getAlertVariant = (phase: string): AlertProps['variant'] => {
  switch (phase) {
    case PhaseStatus.ACTIVE:
    case PhaseStatus.READY:
      return 'success';
    case PhaseStatus.FAILED:
    case PhaseStatus.INVALID:
      return 'danger';
    case PhaseStatus.DEGRADED:
    case PhaseStatus.UNAVAILABLE:
      return 'warning';
    default:
      return 'info';
  }
};

export const getModalAlertProps = (
  phase: string,
  statusMessage?: string,
  reason?: string,
  status?: string,
  conditionType?: string,
  lastTransitionTime?: string,
): AlertProps => {
  const phaseProps = getPhaseProps(phase);
  const alertContent = getAlertContent(phase);
  const hasAlertBody = !!alertContent?.children;
  const showApiDetails =
    (phase === PhaseStatus.FAILED ||
      phase === PhaseStatus.INVALID ||
      phase === PhaseStatus.UNAVAILABLE ||
      phase === PhaseStatus.DEGRADED) &&
    (!!reason || !!statusMessage);

  return {
    variant: getAlertVariant(phase),
    title: alertContent?.title,
    children:
      hasAlertBody || showApiDetails ? (
        <Stack hasGutter>
          {hasAlertBody ? <StackItem data-testid="phase-modal-alert-body">{alertContent.children}</StackItem> : null}
          {showApiDetails ? (
            <StackItem>
              <PhaseApiDetails
                reason={reason}
                statusMessage={statusMessage}
                status={status}
                conditionType={conditionType}
                lastTransitionTime={lastTransitionTime}
              />
            </StackItem>
          ) : null}
        </Stack>
      ) : undefined,
    ...phaseProps,
  };
};

export const getSubtextProps = (phase: string): ContentProps | undefined => {
  const sharedStyle: React.CSSProperties = { textDecoration: 'underline dotted' };
  switch (phase) {
    case PhaseStatus.DEGRADED:
    case PhaseStatus.UNAVAILABLE:
      return { className: 'pf-v6-u-text-color-status-warning', style: sharedStyle };
    case PhaseStatus.FAILED:
    case PhaseStatus.INVALID:
      return { className: 'pf-v6-u-text-color-status-danger', style: sharedStyle };
    case PhaseStatus.PENDING:
      return { className: 'pf-v6-u-text-color-status-info', style: sharedStyle };
    default:
      return undefined;
  }
};
