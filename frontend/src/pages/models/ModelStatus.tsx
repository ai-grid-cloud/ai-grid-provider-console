import { ExpandableSection, List, ListItem, Stack } from '@patternfly/react-core';
import { titleOf, type ModelView } from './modelView';
import { StatusLabel } from '../../components/StatusLabel';
import { rolloutExplanation, stateTooltipOf, statusOpens } from './modelStatusInfo';

/** The rollout explained (rolloutExplanation): its sentence, each cluster that isn't Ready, and the raw reason folded away. */
export const ModelStatusDetails: React.FC<{ model: ModelView }> = ({ model }) => {
  const explained = rolloutExplanation(model);
  if (!explained) return null;
  const { summary, next, raw, clusters } = explained;
  return (
    <Stack hasGutter>
      {summary && <p>{summary}</p>}
      {next && <p>{next}</p>}
      {clusters.length > 0 && (
        <List aria-label={`Clusters where ${titleOf(model)} isn’t ready`}>
          {clusters.map((line) => (
            <ListItem key={line}>{line}</ListItem>
          ))}
        </List>
      )}
      {raw && (
        <ExpandableSection toggleText="Details">
          <code className="pf-v6-u-font-size-sm pf-v6-u-text-break-word">{raw}</code>
        </ExpandableSection>
      )}
    </Stack>
  );
};

/**
 * The model's Status column (ModelStatus.state): the backend's rollout word (status.state). Saved to Git, Syncing
 * and Partially ready open the model's status dialog through `onOpen`; the other words are outline,
 * with what explains the word in a tooltip (stateTooltipOf), never the phase's message. Without
 * `onOpen` (the model page, the AI grid page), nothing opens.
 */
export const ModelStatusLabel: React.FC<{ model: ModelView; onOpen?: () => void }> = ({ model, onOpen }) => {
  const opens = statusOpens(model.state) && !!onOpen;
  return (
    <span data-testid="model-phase">
      <StatusLabel
        isCompact
        status={model.state}
        reason={opens ? undefined : stateTooltipOf(model)}
        onClick={opens ? onOpen : undefined}
        screenReaderSuffix={onOpen ? ` for ${titleOf(model)}` : undefined}
      />
    </span>
  );
};
