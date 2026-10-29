import { useState } from 'react';
import {
  Alert,
  Button,
  Form,
  FormGroup,
  FormGroupLabelHelp,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Popover,
  Stack,
  TextInput,
} from '@patternfly/react-core';
import type { ClusterRole, GridMembership } from '../../api/clusters';
import { ServiceError } from '../../api/ConsoleService';
import { DeleteModal } from '../../components/DeleteModal';
import { TypeaheadSelect } from '../../components/TypeaheadSelect';
import { ClusterChangedError } from './ClusterChangedError';
import { ClusterRolesList } from './ClusterRolesHelp';
import type { ClusterView } from './clusterView';
import { clusterRoles, roleOf } from './roles';

export type MembershipChange = { cluster: ClusterView; join: boolean };

type Props = MembershipChange & {
  /** Makes the change; the modal closes once it resolves and shows the error if it throws. */
  onConfirm: (membership?: GridMembership) => Promise<void>;
  onClose: () => void;
};

// A Kubernetes label value: what the hub accepts for `location`.
const labelValue = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

const locationError = (location: string) => {
  if (!location) return 'Required.';
  if (!labelValue.test(location)) {
    return 'Must start and end with a letter or number. Valid characters include letters, numbers, hyphens (-), underscores (_), and periods (.). Up to 63 characters.';
  }
  return undefined;
};

/** The cluster's role label when it's one of ours; otherwise combined for the hub itself. */
const defaultRole = (cluster: ClusterView): ClusterRole | '' => {
  return roleOf(cluster.labels)?.value ?? (cluster.name === 'local-cluster' ? 'combined' : '');
};

const errorMessage = (err: unknown, join: boolean) => {
  if (err instanceof ServiceError && err.isNotImplemented) {
    return `${join ? 'Adding clusters to' : 'Removing clusters from'} AI Grid is not available on this AI Grid backend.`;
  }
  if (err instanceof ClusterChangedError) {
    // With `current`, the page has given the dialog that version, so a second try sends it.
    return err.current
      ? 'This cluster was changed after this dialog opened. The latest version is now shown. Review it and try again.'
      : 'This cluster was changed after this dialog opened, and the latest version could not be loaded. Cancel, refresh the page, and try again.';
  }
  return err instanceof Error ? err.message : 'Unable to update the cluster.';
};

/** Confirms adding a cluster to AI Grid, with its location and role, or removing it, and keeps a failure in view. */
export const MembershipModal: React.FC<Props> = ({ cluster, join, onConfirm, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [location, setLocation] = useState(cluster.location ?? '');
  const [role, setRole] = useState(defaultRole(cluster));
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
          "Another user changed this cluster's location or role after this dialog opened. Their values are now shown. Review them and try again.",
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
          {/* Every cluster but the hub's own also leaves the cross-cluster network (Submariner):
              ai-grid-env-setup's network Placement selects local-cluster plus the members.
              A model deployed from the Models page (a ManifestWorkReplicaSet) is removed with the
              cluster's ManifestWork; models delivered by env-setup's GitOps apps stay. */}
          <p>
            {cluster.name === 'local-cluster'
              ? 'AI Grid stops managing this cluster, and models are no longer deployed to it.'
              : 'AI Grid stops managing this cluster, and models are no longer deployed to it. The cluster is also disconnected from the other AI Grid clusters.'}
          </p>
          <p>Models deployed to it from the Models page are removed from it. OpenShift AI is not uninstalled.</p>
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
            The hub installs the AI Grid components for the selected role. Models can then be deployed to this cluster's
            location.
          </p>
          <Form id="cluster-membership-form" onSubmit={(e) => e.preventDefault()}>
            <FormGroup label="Location" fieldId="cluster-location" isRequired>
              <TextInput
                id="cluster-location"
                value={location}
                isRequired
                isDisabled={busy}
                validated={shownLocationError ? 'error' : 'default'}
                aria-describedby="cluster-location-help"
                onChange={(_e, value) => setLocation(value)}
                onBlur={() => setTouched((t) => ({ ...t, location: true }))}
              />
              <FormHelperText>
                <HelperText id="cluster-location-help">
                  <HelperTextItem variant={shownLocationError ? 'error' : 'default'}>
                    {shownLocationError ?? 'Models are deployed to clusters by location. For example, us-east.'}
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
            <FormGroup
              label="Role"
              fieldId="cluster-role"
              isRequired
              labelHelp={
                <Popover headerContent="Cluster roles" bodyContent={<ClusterRolesList />}>
                  <FormGroupLabelHelp aria-label="More info for the role field" />
                </Popover>
              }
            >
              <TypeaheadSelect
                id="cluster-role"
                aria-label="Role"
                value={role}
                options={clusterRoles}
                placeholder="Select a role"
                status={shownRoleError ? 'danger' : undefined}
                aria-describedby="cluster-role-help"
                onChange={(value) => {
                  setTouched((t) => ({ ...t, role: true }));
                  setRole(value as ClusterRole);
                }}
                onBlur={() => setTouched((t) => ({ ...t, role: true }))}
              />
              <FormHelperText>
                <HelperText id="cluster-role-help">
                  <HelperTextItem variant={shownRoleError ? 'error' : 'default'}>
                    {shownRoleError ?? 'Determines which AI Grid components the hub installs on the cluster.'}
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
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
