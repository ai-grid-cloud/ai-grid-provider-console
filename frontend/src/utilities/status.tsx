import type { LabelProps } from '@patternfly/react-core';
import {
  BanIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InProgressIcon,
  OutlinedQuestionCircleIcon,
  PendingIcon,
  RhUiClockIcon,
  RhUiOffIcon,
} from '@patternfly/react-icons';

/**
 * How a status reads, the same on every page (PatternFly's status pattern: a color and an icon
 * together). Success, warning and danger use the Label's status colors; "info" is for work in
 * progress and "neutral" for states that are neither good nor bad.
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Every status word the console shows, by tone. A word missing here reads as neutral. */
const tones: Record<string, StatusTone> = {
  // Clusters (GridCluster.status) and AI Grid provisioning.
  Ready: 'success',
  Offline: 'danger',
  Unknown: 'neutral',
  // A cluster's GPU node (its Ready condition, through ACM Search).
  'Not ready': 'danger',
  Provisioned: 'success',
  Provisioning: 'info',
  'Not provisioned': 'neutral',
  // A cluster outside AI Grid (no ai-grid/enabled label).
  'Not added': 'neutral',
  // Models (the Models pages' phase words) and subscriptions (their phase as reported).
  Active: 'success',
  Pending: 'info',
  Failed: 'danger',
  // A placed model serving on some of its clusters but not all (proposal P13).
  'Partially ready': 'warning',
  // Draft word for the MaaS model ref, beside deployment Status. Not the ref's final status.
  'Pending subscription': 'info',
  // Git / Argo, before a cluster reports a deployment. Saved to Git is grey; Syncing is blue nonstatus.
  'Saved to Git': 'neutral',
  Syncing: 'info',
  Synced: 'success',
  // Model deployment labels (the design handed to development). Starting is blue nonstatus, not
  // PatternFly info, which is purple. Stopping, Stopped, and Unknown are grey.
  Starting: 'neutral',
  Stopped: 'neutral',
  Stopping: 'neutral',
  // A subscription's model that the hub doesn't have.
  'Not found': 'danger',
  // MaaS model ref, on the Models list Availability column. Pending stays the info tone; the
  // availability label draws that word in nonstatus purple itself.
  Unavailable: 'warning',
  Invalid: 'danger',
  // ACM add-ons (feature.open-cluster-management.io/addon-* labels).
  Available: 'success',
  Unreachable: 'danger',
  // Organizations.
  Enabled: 'success',
  Disabled: 'neutral',
};

export const statusTone = (status: string | undefined): StatusTone =>
  status ? (tones[status] ?? 'neutral') : 'neutral';

const toneProps: Record<StatusTone, Pick<LabelProps, 'status' | 'color' | 'icon'>> = {
  success: { status: 'success', icon: <CheckCircleIcon /> },
  warning: { status: 'warning', icon: <ExclamationTriangleIcon /> },
  danger: { status: 'danger', icon: <ExclamationCircleIcon /> },
  info: { status: 'info', icon: <InProgressIcon /> },
  neutral: { color: 'grey', icon: <OutlinedQuestionCircleIcon /> },
};

/** The Label props for a status: PatternFly's status color with its icon. */
export const statusLabelProps = (status: string | undefined): Pick<LabelProps, 'status' | 'color' | 'icon'> => {
  const props = toneProps[statusTone(status)];
  // A few states have a more specific icon than their tone's.
  if (status === 'Pending' || status === 'Pending subscription') {
    return { ...props, icon: <PendingIcon /> };
  }
  if (status === 'Starting') {
    return { color: 'blue', icon: <InProgressIcon /> };
  }
  if (status === 'Stopping') {
    return { color: 'grey', icon: <InProgressIcon /> };
  }
  if (status === 'Stopped') {
    return { color: 'grey', icon: <RhUiOffIcon /> };
  }
  if (status === 'Unknown') {
    return { color: 'grey', icon: <OutlinedQuestionCircleIcon /> };
  }
  if (status === 'Pending sync') {
    return { color: 'purple', icon: <PendingIcon /> };
  }
  if (status === 'Saved to Git') {
    return { color: 'grey', icon: <RhUiClockIcon /> };
  }
  if (status === 'Syncing') {
    return { color: 'blue', icon: <InProgressIcon /> };
  }
  if (status === 'Synced') {
    return { status: 'success', icon: <CheckCircleIcon /> };
  }
  if (status === 'Unavailable') {
    return { status: 'warning', icon: <ExclamationTriangleIcon /> };
  }
  if (status === 'Invalid') {
    return { color: 'orange', icon: <ExclamationCircleIcon /> };
  }
  if (status === 'Disabled' || status === 'Not provisioned' || status === 'Not added') {
    return { ...props, icon: <BanIcon /> };
  }
  return props;
};
