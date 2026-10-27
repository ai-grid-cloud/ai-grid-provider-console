import { Icon, Tooltip } from '@patternfly/react-core';
import { ExclamationTriangleIcon } from '@patternfly/react-icons';

type Props = { testId: string; reason: string; children: React.ReactNode };

/** A member's missing label, such as No location: a warning, with what it means in a tooltip. */
export const MissingLabel: React.FC<Props> = ({ testId, reason, children }) => (
  <Tooltip content={reason}>
    <span tabIndex={0} data-testid={testId}>
      <Icon status="warning" isInline>
        <ExclamationTriangleIcon />
      </Icon>{' '}
      {children}
    </span>
  </Tooltip>
);
