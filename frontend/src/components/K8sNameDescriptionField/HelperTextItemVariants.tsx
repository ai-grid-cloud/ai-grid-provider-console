// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/K8sNameDescriptionField/HelperTextItemVariants.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/ui-core/src/components/K8sNameDescriptionField/HelperTextItemVariants.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import * as React from 'react';
import { HelperTextItem } from '@patternfly/react-core';
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { ROUTE_NAME_TOO_LONG_MESSAGE, type K8sNameDescriptionFieldData } from './nameField';

type Variants = React.ComponentProps<typeof HelperTextItem>['variant'];

type HelperTextItemType = React.FC<{
  k8sName: K8sNameDescriptionFieldData['k8sName'];
}>;

export const HelperTextItemMaxLength: HelperTextItemType = ({ k8sName }) => {
  let variant: Variants = 'indeterminate';
  if (k8sName.state.invalidLength) {
    variant = 'error';
  } else if (k8sName.value.trim().length > 0) {
    variant = 'success';
  }

  return <HelperTextItem variant={variant}>Cannot exceed {k8sName.state.maxLength} characters</HelperTextItem>;
};

export const HelperTextItemRouteNameTooLong: HelperTextItemType = ({ k8sName }) => {
  if (!k8sName.state.namespace) {
    return null;
  }

  let variant: Variants = 'indeterminate';
  if (k8sName.state.routeNameTooLong) {
    variant = 'error';
  } else if (k8sName.value.trim().length > 0) {
    variant = 'success';
  }

  return <HelperTextItem variant={variant}>{ROUTE_NAME_TOO_LONG_MESSAGE}</HelperTextItem>;
};

export const HelperTextItemValidCharacters: HelperTextItemType = ({ k8sName }) => {
  let variant: Variants = 'indeterminate';
  if (k8sName.state.invalidCharacters) {
    variant = 'error';
  } else if (k8sName.value.trim().length > 0) {
    variant = 'success';
  }

  return (
    <HelperTextItem variant={variant}>
      {k8sName.state.invalidCharsMessage ||
        'Must start and end with a letter or number. Valid characters include lowercase letters, numbers, and hyphens (-).'}
    </HelperTextItem>
  );
};

export const HelperTextItemResourceNameTaken: React.FC<{
  resourceNameTakenMessage: React.ReactNode;
}> = ({ resourceNameTakenMessage }) => {
  return (
    <HelperTextItem icon={<ExclamationCircleIcon />} variant="error" data-testid="resource-name-taken-error">
      {resourceNameTakenMessage}
    </HelperTextItem>
  );
};
