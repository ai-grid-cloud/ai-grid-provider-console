import { useState } from 'react';
import { describeError } from '../../api/connect/errors';
import { DeleteModal } from '../../components/DeleteModal';
import { useNotifications } from '../../notifications/useNotifications';
import { organizationSavedText } from '../../notifications/writeText';
import type { OrganizationView } from './organizationView';
import { useOrganizationWrites } from './useOrganizations';

/** What a refused delete says; a stale version (Aborted) is the conflict the dialog reloads for. */
const deleteError = (err: unknown) => {
  const { kind, message } = describeError(err);
  return new Error(
    kind === 'notAvailable'
      ? 'Deleting organizations is not available on this AI grid backend.'
      : kind === 'conflict'
        ? 'This organization was changed after this dialog opened. The latest version is now shown. Review it and try again.'
        : message,
  );
};

/**
 * Deleting an organization, the same from its list row and its page: returns `confirmDelete`,
 * which opens the typed-name confirmation for an organization, and the modal to render.
 * `refresh` reloads the page after a failed delete; a delete that succeeds goes to the
 * notification center, then `onDeleted`.
 */
export const useDeleteOrganization = ({
  refresh,
  onDeleted,
}: {
  refresh: () => void;
  onDeleted: () => void;
}): [(organization: OrganizationView) => void, React.ReactNode] => {
  const writes = useOrganizationWrites();
  const { notify } = useNotifications();
  const [selected, setSelected] = useState<OrganizationView>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<Error>();
  const [reloadError, setReloadError] = useState<Error>();

  const confirmDelete = (organization: OrganizationView) => {
    setSelected(organization);
    setError(undefined);
    setReloadError(undefined);
  };

  const remove = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setError(undefined);
    setReloadError(undefined);
    // The first attempt sends the version the user confirmed. After a failed delete the dialog
    // loads the organization again and stays busy until it has, so a retry sends the version the
    // backend has now; the typed name stays.
    try {
      await writes.deleteOrganization(selected);
      setSelected(undefined);
      // Complete when the backend answers: said once, by the name the dialog showed, as read.
      notify({ variant: 'success', ...organizationSavedText('delete', selected), read: true });
      onDeleted();
    } catch (err) {
      setError(deleteError(err));
      refresh();
      try {
        setSelected(await writes.loadOrganization(selected.id));
      } catch (reloadErr) {
        setReloadError(new Error(describeError(reloadErr).message));
      }
    } finally {
      setDeleting(false);
    }
  };

  const modal = selected && (
    <DeleteModal
      title="Delete organization?"
      deleteName={selected.name}
      deleting={deleting}
      error={error}
      reloadError={reloadError}
      onClose={() => {
        if (!deleting) {
          setSelected(undefined);
          setError(undefined);
        }
      }}
      onDelete={() => void remove()}
      testId="delete-organization-modal"
    >
      <p>The organization and its identity provider configuration will be deleted.</p>
    </DeleteModal>
  );

  return [confirmDelete, modal];
};
