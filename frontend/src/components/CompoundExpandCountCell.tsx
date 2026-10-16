// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/CompoundExpandCountCell.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/CompoundExpandCountCell.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { Flex, FlexItem } from '@patternfly/react-core';

type Props = { count: number };

/** The count shown in a compound-expand table cell. */
export const CompoundExpandCountCell: React.FC<Props> = ({ count }) => (
  <Flex className="pf-v6-u-w-100 pf-v6-u-py-md">
    <FlexItem>{count}</FlexItem>
  </Flex>
);
