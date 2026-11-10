import { useState } from 'react';
import {
  Alert,
  Button,
  Content,
  Form,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
} from '@patternfly/react-core';
import type { ClusterRole, GridMembership } from '../../api/clusters';
import { ServiceError } from '../../api/ConsoleService';
import { DeleteModal } from '../../components/DeleteModal';
import { changedMessage, ClusterChangedError } from './ClusterChangedError';
import { removeText } from './clusterInfo';
import { isPositionNotSet, mapPositionOf, type ClusterView } from './clusterView';
import { locationError } from './gridSettings';
import { LocationLabelField, RoleField } from './MembershipFields';
import { roleOf } from './roles';

export type MembershipChange = { cluster: ClusterView; join: boolean };

type Props = MembershipChange & {
  /** Makes the change; the modal closes once it resolves and shows the error if it throws. */
  onConfirm: (membership?: GridMembership) => Promise<void>;
  onClose: () => void;
};

/** The cluster's role label when it's one of ours; otherwise combined for the hub itself. */
const defaultRole = (cluster: ClusterView): ClusterRole | '' => {
  return roleOf(cluster.labels)?.value ?? (cluster.name === 'local-cluster' ? 'combined' : '');
};

/** An Ingress or Combined cluster, which holds the subscriptions' copies (removeText). */
const receivesRequests = (cluster: ClusterView) => {
  const role = roleOf(cluster.labels)?.value;
  return role === 'ingress' || role === 'combined';
};

const errorMessage = (err: unknown, join: boolean) => {
  if (err instanceof ServiceError && err.isNotImplemented) {
    return `${join ? 'Adding clusters to' : 'Removing clusters from'} AI Grid is not available on this AI Grid backend.`;
  }
  if (err instanceof ClusterChangedError) return changedMessage(err);
  return err instanceof Error ? err.message : 'Unable to update the cluster.';
};

/** Confirms adding a cluster to AI Grid, with its location label and role, or removing it, and keeps a failure in view. */
export const MembershipModal: React.FC<Props> = ({ cluster, join, onConfirm, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [location, setLocation] = useState(cluster.location ?? '');
  const [role, setRole] = useState<ClusterRole | ''>(defaultRole(cluster));
  const [touched, setTouched] = useState({ location: false, role: false });
  const title = join ? `Add ${cluster.name} to AI Grid?` : `Remove ${cluster.name} from AI Grid?`;
  const locationInvalid = locationError(location.trim());
  const shownLocationError = touched.location ? locationInvalid : undefined;
  const shownRoleError = touched.role && !role ? 'Required.' : undefined;

  const confirm = async () => {
    if (join && (locationInvalid || !role)) {
      setTouched({ location: true, role: true });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(join && role ? { location: location.trim(), role } : undefined);
    } catch (err) {
      const current = err instanceof ClusterChangedError ? err.current : undefined;
      if (
        join &&
        current &&
        ((current.location ?? '') !== (cluster.location ?? '') || defaultRole(current) !== defaultRole(cluster))
      ) {
        // Someone else set the location or role meanwhile: show theirs rather than send this
        // dialog's choices over them without the user seeing what changed.
        setLocation(current.location ?? '');
        setRole(defaultRole(current));
        setTouched({ location: false, role: false });
        setError(
          "Another user changed this cluster's location label or role after this dialog opened. Their values are now shown. Review them and try again.",
        );
      } else {
        setError(errorMessage(err, join));
      }
      setBusy(false);
    }
  };

  if (!join) {
    // Removing is destructive: the typed-name confirmation every delete asks for.
    return (
      <DeleteModal
        title={title}
        deleteName={cluster.name}
        submitButtonLabel="Remove"
        deleting={busy}
        onDelete={() => void confirm()}
        onClose={() => {
          if (!busy) onClose();
        }}
        error={error === undefined ? undefined : new Error(error)}
        errorTitle="Unable to remove cluster from AI Grid"
        testId="cluster-membership-modal"
      >
        <Stack hasGutter>
          {receivesRequests(cluster) && (
            <Alert isInline variant="warning" title={removeText.warningTitle}>
              <Content>
                <Content component="p">{removeText.warningBody}</Content>
                <Content component="p">{removeText.warningDetail}</Content>
              </Content>
            </Alert>
          )}
          {/* Every cluster but the hub's own also leaves the cross-cluster network (Submariner):
              ai-grid-env-setup's network Placement selects local-cluster plus the members.
              Models stay running: the hub deletes the cluster's model application with
              preserveResourcesOnDeletion, as it does the OpenShift AI one, so AI Grid only stops
              managing them (ai-grid-cluster-gitops' catalog ApplicationSets). */}
          <p>
            {cluster.name === 'local-cluster'
              ? 'AI Grid stops managing this cluster, and models are no longer deployed to it.'
              : 'AI Grid stops managing this cluster, and models are no longer deployed to it. The cluster is also disconnected from the other AI Grid clusters.'}
          </p>
          <p>
            OpenShift AI and the models running on it are not uninstalled, but AI Grid no longer manages them. Move its
            models to other clusters first.
          </p>
        </Stack>
      </DeleteModal>
    );
  }

  return (
    <Modal isOpen variant="small" onClose={busy ? undefined : onClose} data-testid="cluster-membership-modal">
      <ModalHeader title={title} />
      <ModalBody>
        <Stack hasGutter>
          <p>
            The hub installs the AI Grid components for the selected role. After a cluster that serves models is
            provisioned, you can select it when you deploy a model.
          </p>
          <Form id="cluster-membership-form" onSubmit={(e) => e.preventDefault()}>
            <LocationLabelField
              value={location}
              error={shownLocationError}
              isDisabled={busy}
              mapPosition={mapPositionOf(cluster)}
              positionNotSet={isPositionNotSet(cluster)}
              onChange={setLocation}
              onBlur={() => setTouched((t) => ({ ...t, location: true }))}
            />
            <RoleField
              value={role}
              error={shownRoleError}
              isDisabled={busy}
              onChange={(value) => {
                setTouched((t) => ({ ...t, role: true }));
                setRole(value);
              }}
              onBlur={() => setTouched((t) => ({ ...t, role: true }))}
            />
          </Form>
          {error && (
            <Alert isInline variant="danger" title="Unable to add cluster to AI Grid">
              {error}
            </Alert>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" isLoading={busy} isDisabled={busy} onClick={() => void confirm()}>
          Add to AI Grid
        </Button>
        <Button variant="link" isDisabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};
