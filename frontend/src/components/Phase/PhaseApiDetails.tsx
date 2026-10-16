// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/Phase/PhaseApiDetails.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/Phase/PhaseApiDetails.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useState } from 'react';
import {
  ClipboardCopyButton,
  CodeBlock,
  CodeBlockAction,
  CodeBlockCode,
  ExpandableSection,
} from '@patternfly/react-core';

type Props = {
  reason?: string;
  statusMessage?: string;
  status?: string;
  conditionType?: string;
  lastTransitionTime?: string;
};

/** The status condition as JSON, with a copy button. */
export const PhaseApiDetails: React.FC<Props> = ({
  reason,
  statusMessage,
  status,
  conditionType,
  lastTransitionTime,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify({ conditionType, status, reason, message: statusMessage, lastTransitionTime }, null, 2);

  const onClick = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
  };

  const detailsActions = (
    <CodeBlockAction>
      <ClipboardCopyButton
        id="status-details-copy-button"
        aria-label="Copy to clipboard status details"
        onClick={() => onClick(json)}
        exitDelay={copied ? 1500 : 600}
        maxWidth="110px"
        variant="plain"
        onTooltipHidden={() => setCopied(false)}
      >
        {copied ? 'Successfully copied to clipboard!' : 'Copy to clipboard'}
      </ClipboardCopyButton>
    </CodeBlockAction>
  );

  return (
    <ExpandableSection
      toggleText={isExpanded ? 'Hide API details' : 'API details'}
      isExpanded={isExpanded}
      onToggle={(_event, expanded) => setIsExpanded(expanded)}
      data-testid="phase-api-details"
    >
      <CodeBlock actions={detailsActions}>
        <CodeBlockCode data-testid="phase-api-details-code-block">{json}</CodeBlockCode>
      </CodeBlock>
    </ExpandableSection>
  );
};
