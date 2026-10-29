import { useState } from 'react';
import { Stack } from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import { DeleteModal } from '../../components/DeleteModal';
import { ReferencingSubscriptions } from './ModelReferences';
import { titleOf, type ModelView } from './modelView';
import { useModelWrites } from './useModels';

const deleteErrorOf = (err: unknown) =>
  err instanceof ServiceError && err.isNotImplemented
    ? new Error('Deleting models is not available on this AI Grid backend.')
    : err instanceof Error
      ? err
      : new Error('Unable to delete the model.');

/**
 * Deleting a model deployment, the same from its list row and its page: returns `confirmDelete`
 * and the modal to render. `refresh` reloads the page after a failed delete.
 */
export const useDeleteModel = ({
  refresh,
  onDeleted,
}: {
  refresh: () => void;
  onDeleted: () => void;
}): [(model: ModelView) => void, React.ReactNode] => {
  const writes = useModelWrites();
  const [selected, setSelected] = useState<ModelView>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<Error>();
  const [reloadError, setReloadError] = useState<Error>();
  const [inUse, setInUse] = useState(false);

  const confirmDelete = (model: ModelView) => {
    setSelected(model);
    setError(undefined);
    setReloadError(undefined);
    setInUse(false);
  };

  const remove = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setError(undefined);
    setReloadError(undefined);
    // The first attempt sends the version the user confirmed. After a failed delete the dialog
    // loads the model again and stays busy until it has, so a retry sends the version the backend
    // has now.
    try {
      await writes.deleteModel(selected);
      setSelected(undefined);
      onDeleted();
    } catch (err) {
      setError(deleteErrorOf(err));
      refresh();
      try {
        const reloaded = await writes.loadModel(selected.id);
        if (reloaded) setSelected(reloaded);
      } catch (reloadErr) {
        setReloadError(reloadErr instanceof Error ? reloadErr : new Error(String(reloadErr)));
      }
    } finally {
      setDeleting(false);
    }
  };

  const modal = selected && (
    <DeleteModal
      title="Delete model?"
      deleteName={titleOf(selected)}
      onClose={() => {
        if (!deleting) {
          setSelected(undefined);
          setError(undefined);
        }
      }}
      onDelete={() => void remove()}
      deleting={deleting}
      error={error}
      reloadError={reloadError}
      testId="delete-deployment-modal"
      // Only a guide: while the subscriptions load, or if they fail to, Delete stays enabled. The
      // backend refuses to delete a model a subscription uses, and stays the authority.
      disabledReason={inUse ? 'Remove this model from its subscriptions first.' : undefined}
    >
      <Stack hasGutter>
        <p>
          The model is removed from every location it is deployed to. Remove it from any subscriptions and authorization
          policies first.
        </p>
        <ReferencingSubscriptions modelId={selected.id} onInUse={setInUse} />
      </Stack>
    </DeleteModal>
  );

  return [confirmDelete, modal];
};
