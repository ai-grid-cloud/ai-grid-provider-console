import { Button, Tooltip } from '@patternfly/react-core';
import { PlusCircleIcon } from '@patternfly/react-icons';
import { addText, cannotAddReason } from './clusterInfo';
import type { ClusterView } from './clusterView';

type Props = {
  cluster: ClusterView;
  onAdd: () => void;
};

/**
 * The row action for a cluster outside AI grid. The add icon replaces the actions menu, and its
 * tooltip is that menu's Add label. While the cluster can't be added yet, the button stays
 * focusable and the tooltip says why, as the menu item did.
 */
export const AddClusterButton: React.FC<Props> = ({ cluster, onAdd }) => {
  const reason = cannotAddReason(cluster);
  return (
    <Tooltip content={reason ?? addText.action}>
      <Button
        variant="plain"
        icon={<PlusCircleIcon />}
        aria-label={`Add ${cluster.name} to AI grid`}
        isAriaDisabled={!!reason}
        data-testid={`cluster-add-${cluster.name}`}
        onClick={() => {
          if (!reason) onAdd();
        }}
      />
    </Tooltip>
  );
};
