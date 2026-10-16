// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/FieldGroupHelpLabelIcon.tsx at 62319b8.
import { Button, Popover } from '@patternfly/react-core';
import { OutlinedQuestionCircleIcon } from '@patternfly/react-icons';
import type { ComponentProps } from 'react';

type Props = {
  title?: ComponentProps<typeof Popover>['headerContent'];
  content: ComponentProps<typeof Popover>['bodyContent'];
};

/** A help icon that opens a popover, for a form field label. */
export const FieldGroupHelpLabelIcon: React.FC<Props> = ({ title, content }) => (
  <Popover headerContent={title} bodyContent={content}>
    <Button variant="plain" aria-label="More info" icon={<OutlinedQuestionCircleIcon />} />
  </Popover>
);
