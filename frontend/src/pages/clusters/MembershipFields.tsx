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
import { PositionDocsLink } from './PositionDocsLink';
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
        headerContent="Location label"
        bodyContent="A label that describes where the cluster is located. Use the map position set by the hub administrator to inform the location label."
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
              Map position is not set. <PositionDocsLink trailing="." />
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

/** A role the dialog shows but doesn't change, with why under it. */
export const ReadOnlyRoleField: React.FC<{ role: ClusterRole; reason: string }> = ({ role, reason }) => (
  <ReadOnlyField
    label="Role"
    fieldId="cluster-role"
    value={clusterRoles.find((r) => r.value === role)?.label ?? role}
    reason={reason}
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
    <FormHelperText>
      <HelperText id="cluster-role-help">
        <HelperTextItem variant={error ? 'error' : 'default'}>
          {error ?? 'Determines which AI Grid components the hub installs on the cluster.'}
        </HelperTextItem>
      </HelperText>
    </FormHelperText>
  </FormGroup>
);
