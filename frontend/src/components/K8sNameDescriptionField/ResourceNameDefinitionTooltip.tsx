// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/K8sNameDescriptionField/ResourceNameDefinitionTooltip.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/ui-core/src/components/K8sNameDescriptionField/ResourceNameDefinitionTooltip.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import * as React from 'react';
import { Stack, StackItem } from '@patternfly/react-core';
import { FieldGroupHelpLabelIcon } from '../FieldGroupHelpLabelIcon';

export const ResourceNameDefinitionTooltip: React.FC = () => (
  <FieldGroupHelpLabelIcon
    content={
      <Stack hasGutter>
        <StackItem>
          The resource name is used to identify your resource in Kubernetes, and is generated based on the name you
          enter.
        </StackItem>
        <StackItem>The resource name cannot be edited after creation.</StackItem>
      </Stack>
    }
  />
);
