// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/K8sNameDescriptionField/ResourceNameField.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/ui-core/src/components/K8sNameDescriptionField/ResourceNameField.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import * as React from 'react';
import {
  FormGroup,
  HelperText,
  InputGroup,
  InputGroupItem,
  InputGroupText,
  TextInput,
  ValidatedOptions,
} from '@patternfly/react-core';
import type { K8sNameDescriptionFieldData, K8sNameDescriptionFieldUpdateFunction } from './nameField';
import { ResourceNameDefinitionTooltip } from './ResourceNameDefinitionTooltip';
import {
  HelperTextItemMaxLength,
  HelperTextItemResourceNameTaken,
  HelperTextItemRouteNameTooLong,
  HelperTextItemValidCharacters,
} from './HelperTextItemVariants';

type ResourceNameFieldProps = {
  allowEdit: boolean;
  dataTestId: string;
  k8sName: K8sNameDescriptionFieldData['k8sName'];
  onDataChange?: K8sNameDescriptionFieldUpdateFunction;
  resourceNameTakenHelperText?: React.ReactNode;
};

/** Sub-resource; not for public consumption */
export const ResourceNameField: React.FC<ResourceNameFieldProps> = ({
  allowEdit,
  dataTestId,
  k8sName,
  onDataChange,
  resourceNameTakenHelperText,
}) => {
  const formGroupProps: React.ComponentProps<typeof FormGroup> = {
    label: 'Resource name',
    labelHelp: <ResourceNameDefinitionTooltip />,
    fieldId: `${dataTestId}-resourceName`,
  };

  if (k8sName.state.immutable) {
    return <FormGroup {...formGroupProps}>{k8sName.value}</FormGroup>;
  }

  if (!allowEdit) {
    return null;
  }

  let validated: ValidatedOptions = ValidatedOptions.default;
  if (
    k8sName.state.invalidLength ||
    k8sName.state.invalidCharacters ||
    k8sName.state.routeNameTooLong ||
    !!resourceNameTakenHelperText
  ) {
    validated = ValidatedOptions.error;
  } else if (k8sName.value.length > 0 && !resourceNameTakenHelperText) {
    validated = ValidatedOptions.success;
  }

  const usePrefix = k8sName.state.staticPrefix && !!k8sName.state.safePrefix;
  const textInput = (
    <TextInput
      id={`${dataTestId}-resourceName`}
      data-testid={`${dataTestId}-resourceName`}
      name={`${dataTestId}-resourceName`}
      isRequired
      value={
        usePrefix && k8sName.state.safePrefix
          ? k8sName.value.replace(new RegExp(`^${k8sName.state.safePrefix}`), '')
          : k8sName.value
      }
      onChange={(_event, value) =>
        onDataChange?.('k8sName', usePrefix && k8sName.state.safePrefix ? `${k8sName.state.safePrefix}${value}` : value)
      }
      validated={validated}
    />
  );
  return (
    <FormGroup {...formGroupProps} isRequired>
      {usePrefix ? (
        <InputGroup>
          <InputGroupText>{k8sName.state.safePrefix}</InputGroupText>
          <InputGroupItem isFill>{textInput}</InputGroupItem>
        </InputGroup>
      ) : (
        textInput
      )}
      <HelperText>
        <HelperTextItemMaxLength k8sName={k8sName} />
        <HelperTextItemValidCharacters k8sName={k8sName} />
        <HelperTextItemRouteNameTooLong k8sName={k8sName} />
        {resourceNameTakenHelperText && (
          <HelperTextItemResourceNameTaken resourceNameTakenMessage={resourceNameTakenHelperText} />
        )}
      </HelperText>
    </FormGroup>
  );
};
