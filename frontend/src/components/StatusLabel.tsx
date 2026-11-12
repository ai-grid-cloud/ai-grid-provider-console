import type { LabelProps } from '@patternfly/react-core';
import { Label, Tooltip } from '@patternfly/react-core';
import { statusLabelProps } from '../utilities/status';

type Props = {
  /** The status word, shown as is: Ready, Unavailable, Failed, Degraded, ... */
  status: string;
  /** A short reason, shown in a tooltip on the label. */
  reason?: string;
  /** Compact size, for tables and page headers (PatternFly: compact labels when space is tight). */
  isCompact?: boolean;
  /** Opens the status's details; the label is then filled, a button. */
  onClick?: LabelProps['onClick'];
  /** Read after the word by a screen reader only, e.g. " on site1" in a table of clusters. */
  screenReaderSuffix?: string;
  'data-testid'?: string;
};

/**
 * A status as PatternFly's status pattern shows it, the same on every page: a label in the status
 * colour with its icon, the word and colour from utilities/status. A status label is an outline label
 * with its reason in a tooltip, and opens nothing. It is clickable (filled, with onClick) where the
 * status interaction rules in frontend/AGENTS.md open a dialog, including cluster hub messages
 * and model rollout explanations.
 */
export const StatusLabel: React.FC<Props> = ({
  status,
  reason,
  isCompact,
  onClick,
  screenReaderSuffix,
  'data-testid': testId,
}) => {
  const label = (
    <Label
      {...statusLabelProps(status)}
      variant={onClick ? 'filled' : 'outline'}
      isCompact={isCompact}
      isClickable={!!onClick}
      onClick={onClick}
      // A reason is only in the tooltip, so the label takes focus to show it from the keyboard
      // (a clickable label's button already does), as RelativeTime does.
      tabIndex={reason && !onClick ? 0 : undefined}
      data-testid={testId}
    >
      {status}
      {screenReaderSuffix && <span className="pf-v6-screen-reader">{screenReaderSuffix}</span>}
    </Label>
  );
  return reason ? <Tooltip content={reason}>{label}</Tooltip> : label;
};
