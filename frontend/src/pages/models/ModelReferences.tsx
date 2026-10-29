import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Alert, List, ListItem } from '@patternfly/react-core';
import { displayNameOf } from './modelView';
import { useSubscriptionsUsingModel } from './useModels';

/**
 * The subscriptions that still give access to the model, which the user should change first: those
 * with a model ref the backend joined to this model (SubscriptionModelRef.model_id). `onInUse` hears
 * whether any were found; while they load, or if they fail to, none are.
 */
export const ReferencingSubscriptions: React.FC<{ modelId: string; onInUse?: (inUse: boolean) => void }> = ({
  modelId,
  onInUse,
}) => {
  const { data: using, loaded, error } = useSubscriptionsUsingModel(modelId);
  const inUse = loaded && !error && using.length > 0;
  useEffect(() => onInUse?.(inUse), [onInUse, inUse]);
  if (!inUse) {
    return null;
  }
  return (
    <Alert isInline isPlain variant="warning" title="Subscriptions still use this model" data-testid="model-references">
      <p>Remove the model from these subscriptions first, or their users lose access to it:</p>
      <List>
        {using.map((subscription) => (
          <ListItem key={subscription.id}>
            <Link to={`/subscriptions/view/${encodeURIComponent(subscription.id)}`}>{displayNameOf(subscription)}</Link>
          </ListItem>
        ))}
      </List>
    </Alert>
  );
};
