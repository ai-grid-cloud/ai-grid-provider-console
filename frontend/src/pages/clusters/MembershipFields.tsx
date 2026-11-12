// The fields Add to AI Grid and Edit share, so both dialogs draw, validate and word a cluster's
// location label and role the same way.
import {
  ClipboardCopy,
  FormGroup,
  FormGroupLabelHelp,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Popover,
  TextInput,
} from '@patternfly/react-core';
import type { ClusterRole } from '../../api/clusters';
import { ReadOnlyField } from '../../components/ReadOnlyField';
import { TypeaheadSelect } from '../../components/TypeaheadSelect';
import { ClusterRolesList } from './ClusterRolesHelp';
import { PositionHelp } from './PositionHelp';
import { clusterRoles } from './roles';

type TextFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  /** The error to show now: the caller decides when a field has been touched. */
  error?: string;
  isDisabled?: boolean;
  /** The cluster's map position, "latitude, longitude", when the hub has one. */
  mapPosition?: string;
  /** The hub has not set a map position (details: "Not on the map: position not set"). */
  positionNotSet?: boolean;
};

/** The `location` label: required, a label value. */
export const LocationLabelField: React.FC<TextFieldProps> = ({
  value,
  onChange,
  onBlur,
  error,
  isDisabled,
  mapPosition,
  positionNotSet,
}) => (
  <FormGroup
    label="Location label"
    fieldId="cluster-location"
    isRequired
    labelHelp={
      <Popover
        aria-label="Location label"
        bodyContent="Add a label to describe where the cluster is located. This does not impact the cluster's position on the AI Grid map, which is set by your hub administrator or inherited from the cloud region."
      >
        <FormGroupLabelHelp aria-label="More info for the location label field" />
      </Popover>
    }
  >
    <TextInput
      id="cluster-location"
      value={value}
      isRequired
      isDisabled={isDisabled}
      validated={error ? 'error' : 'default'}
      aria-describedby={error || mapPosition || positionNotSet ? 'cluster-location-help' : undefined}
      onChange={(_e, v) => onChange(v)}
      onBlur={onBlur}
    />
    {(error || mapPosition || positionNotSet) && (
      <FormHelperText>
        <HelperText id="cluster-location-help">
          {error && <HelperTextItem variant="error">{error}</HelperTextItem>}
          {mapPosition && (
            <HelperTextItem>
              Map position is{' '}
              <ClipboardCopy variant="inline-compact" copyAriaLabel="Copy map position">
                {mapPosition}
              </ClipboardCopy>
            </HelperTextItem>
          )}
          {positionNotSet && (
            <HelperTextItem>
              Map position is not set. <PositionHelp />
            </HelperTextItem>
          )}
        </HelperText>
      </FormHelperText>
    )}
  </FormGroup>
);

type RoleFieldProps = {
  value: ClusterRole | '';
  onChange: (value: ClusterRole) => void;
  onBlur: () => void;
  error?: string;
  isDisabled?: boolean;
};

/** The roles' help beside a Role label, editable or not. */
const roleHelp = (
  <Popover headerContent="Cluster roles" bodyContent={<ClusterRolesList />}>
    <FormGroupLabelHelp aria-label="More info for the role field" />
  </Popover>
);

/**
 * Why neither dialog changes a role a cluster has: the hub doesn't fully remove what the old role
 * installed (GLOSSARY.md, "Role"; editClusterText.ts). Under a read-only role, and in Add above an
 * editable one.
 */
export const roleFixedText = "A cluster's role cannot be changed once it has been added to the AI Grid.";

/**
 * A role the dialog shows but doesn't change, with why under it: Edit's for an AI Grid cluster, and
 * Add's for a cluster that kept its role when it was removed.
 */
export const ReadOnlyRoleField: React.FC<{ role: ClusterRole }> = ({ role }) => (
  <ReadOnlyField
    label="Role"
    fieldId="cluster-role"
    value={clusterRoles.find((r) => r.value === role)?.label ?? role}
    reason={roleFixedText}
    labelHelp={roleHelp}
  />
);

/** The `ai-grid/role` label: one of the three roles, with their help beside the label. */
export const RoleField: React.FC<RoleFieldProps> = ({ value, onChange, onBlur, error, isDisabled }) => (
  <FormGroup label="Role" fieldId="cluster-role" isRequired labelHelp={roleHelp}>
    <TypeaheadSelect
      id="cluster-role"
      aria-label="Role"
      value={value}
      options={clusterRoles}
      placeholder="Select a role"
      status={error ? 'danger' : undefined}
      isDisabled={isDisabled}
      aria-describedby="cluster-role-help"
      onChange={(v) => onChange(v as ClusterRole)}
      onBlur={onBlur}
    />
    {/* The helper stays when the field shows an error, and the error follows it. */}
    <FormHelperText>
      <HelperText id="cluster-role-help">
        <HelperTextItem>
          Select the role this cluster will perform in the AI Grid. Components needed to perform the assigned role will
          be installed on the cluster.
        </HelperTextItem>
        {error && <HelperTextItem variant="error">{error}</HelperTextItem>}
      </HelperText>
    </FormHelperText>
  </FormGroup>
);
