import { Icon, Tooltip } from '@patternfly/react-core';
import { ExclamationTriangleIcon } from '@patternfly/react-icons';

type Props = { testId: string; reason: string; children: React.ReactNode };

/**
 * A value that is missing or wrong where the object needs one, in a table cell or a details value:
 * a warning icon and a short text (a cluster's "No role" or invalid position, an organization
 * without an identity provider, a subscription's deleted organization), with what it means in a
 * tooltip. Focusable, so the tooltip opens from the keyboard too.
 */
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
