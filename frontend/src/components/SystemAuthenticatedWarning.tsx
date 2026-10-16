// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/SystemAuthenticatedWarning.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/SystemAuthenticatedWarning.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { FormHelperText, HelperText, HelperTextItem } from '@patternfly/react-core';

/** Warns that the system:authenticated group admits every user on the cluster. */
export const SystemAuthenticatedWarning: React.FC = () => (
  <FormHelperText data-testid="system-authenticated-warning">
    <HelperText>
      <HelperTextItem variant="warning">
        The <code>system:authenticated</code> group provides access to all users on this cluster.
      </HelperTextItem>
    </HelperText>
  </FormHelperText>
);
