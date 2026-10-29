import { Button, EmptyState, EmptyStateActions, EmptyStateBody, EmptyStateFooter } from '@patternfly/react-core';
import type { ModelView } from './modelView';

type Props = {
  model: Pick<ModelView, 'id'>;
  /** Opens the model's edit page; absent for a viewer. */
  onEdit?: () => void;
};

/** A model row expanded when the backend reports no cluster its placement chose. */
export const NotPlaced: React.FC<Props> = ({ model, onEdit }) => (
  <EmptyState variant="xs" titleText="No locations" headingLevel="h3" data-testid={`model-not-placed-${model.id}`}>
    <EmptyStateBody>To serve this model, select one or more locations.</EmptyStateBody>
    {onEdit && (
      <EmptyStateFooter>
        <EmptyStateActions>
          <Button variant="link" onClick={onEdit}>
            Edit locations
          </Button>
        </EmptyStateActions>
      </EmptyStateFooter>
    )}
  </EmptyState>
);
