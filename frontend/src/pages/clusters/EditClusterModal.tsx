import { useState } from 'react';
import {
  Alert,
  Button,
  Form,
  List,
  ListItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
} from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import { changedMessage, ClusterChangedError } from './ClusterChangedError';
import type { ClusterView } from './clusterView';
import { editText, roleSet } from './editClusterText';
import {
  canSetRole,
  labelsUpdate,
  settingsErrors,
  settingsOf,
  type GridSettings,
  type GridSettingsField,
} from './gridSettings';
import { LocationLabelField, ReadOnlyRoleField, RoleField } from './MembershipFields';

type Props = {
  /** An AI Grid cluster, as loaded; after a conflict the page passes it as loaded again. */
  cluster: ClusterView;
  /** Saves the labels; the modal closes once it resolves and shows the error if it throws. */
  onConfirm: (labels: Record<string, string>) => Promise<void>;
  onClose: () => void;
};

type Touched = Partial<Record<GridSettingsField, boolean>>;

const sameSettings = (a: GridSettings, b: GridSettings) => a.role === b.role && a.location === b.location;

/**
 * Edits an AI Grid cluster's location label, and sets its role when it has none (a role it has is
 * shown read-only): one Clusters/Update of its labels. Setting a role says first what the hub
 * installs; it only adds, so it asks for no typed name.
 */
export const EditClusterModal: React.FC<Props> = ({ cluster, onConfirm, onClose }) => {
  const [values, setValues] = useState<GridSettings>(() => settingsOf(cluster));
  const [touched, setTouched] = useState<Touched>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // The role a cluster already has, which Edit shows but doesn't change (canSetRole).
  const fixedRole = canSetRole(cluster) ? undefined : settingsOf(cluster).role || undefined;
  const errors = settingsErrors(values);
  const shown = (f: GridSettingsField) => (touched[f] ? errors[f] : undefined);
  const touch = (f: GridSettingsField) => () => setTouched((t) => ({ ...t, [f]: true }));

  const labels = labelsUpdate(cluster, values);
  const role = !fixedRole && values.role ? roleSet(values.role) : undefined;
  const canSave = !!labels && !busy;

  const save = async () => {
    if (!canSave) return;
    if (Object.keys(errors).length) {
      setTouched({ role: true, location: true });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(labels);
    } catch (err) {
      const current = err instanceof ClusterChangedError ? err.current : undefined;
      if (current && !sameSettings(settingsOf(current), settingsOf(cluster))) {
        // Someone else set these meanwhile: show theirs rather than send this dialog's over them
        // without the user seeing what changed.
        setValues(settingsOf(current));
        setTouched({});
        setError(editText.changedByOther);
      } else if (err instanceof ClusterChangedError) {
        setError(changedMessage(err));
      } else if (err instanceof ServiceError && err.isNotImplemented) {
        setError(editText.notAvailable);
      } else {
        // The backend's own refusal, in its words.
        setError(err instanceof Error ? err.message : 'Unable to update the cluster.');
      }
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      variant="small"
      onClose={busy ? undefined : onClose}
      aria-labelledby="cluster-edit-modal-title"
      data-testid="cluster-edit-modal"
    >
      <ModalHeader
        labelId="cluster-edit-modal-title"
        title={editText.title}
        description={
          <>
            Edit the AI Grid configuration of the <strong>{cluster.name}</strong> cluster.
          </>
        }
      />
      <ModalBody>
        <Stack hasGutter>
          <Form id="cluster-edit-form" onSubmit={(e) => e.preventDefault()}>
            {fixedRole ? (
              <ReadOnlyRoleField role={fixedRole} />
            ) : (
              <RoleField
                value={values.role}
                error={shown('role')}
                isDisabled={busy}
                onChange={(value) => {
                  touch('role')();
                  setValues((v) => ({ ...v, role: value }));
                }}
                onBlur={touch('role')}
              />
            )}
            {role && (
              // A live region, so a screen reader announces what Save will install when a role is selected.
              <Alert isInline isLiveRegion variant="info" title={role.title} data-testid="cluster-role-change">
                <List>
                  <ListItem>{role.installs}</ListItem>
                  <ListItem>{role.settling}</ListItem>
                </List>
              </Alert>
            )}
            <LocationLabelField
              value={values.location}
              error={shown('location')}
              isDisabled={busy}
              position={cluster}
              onChange={(value) => setValues((v) => ({ ...v, location: value }))}
              onBlur={touch('location')}
            />
          </Form>
          {error && (
            <Alert isInline variant="danger" title={editText.errorTitle}>
              {error}
            </Alert>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" isLoading={busy} isDisabled={!canSave} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="link" isDisabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};
