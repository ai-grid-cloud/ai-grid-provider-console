// The fields Add to AI grid and Edit share, so both dialogs draw, validate and word a cluster's
// location label and role the same way.
import {
  Alert,
  ClipboardCopy,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  FormGroup,
  FormGroupLabelHelp,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Icon,
  Popover,
  Stack,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { ExclamationTriangleIcon } from '@patternfly/react-icons';
import { Link } from 'react-router-dom';
import type { ClusterRole } from '../../api/clusters';
import { ReadOnlyField } from '../../components/ReadOnlyField';
import { TypeaheadSelect } from '../../components/TypeaheadSelect';
import { EMPTY_VALUE } from '../../utilities/format';
import { ClusterRolesList } from './ClusterRolesHelp';
import { mapPositionOf, type ClusterView } from './clusterView';
import { PositionDocsLink } from './PositionDocsLink';
import { clusterRoles } from './roles';
import { isFromCloudRegion } from './site';

/** What the location-label help shows of where the cluster already is. */
type LocationCluster = Pick<
  ClusterView,
  'name' | 'latitude' | 'longitude' | 'locationSource' | 'locationProblem' | 'siteName' | 'region'
>;

type TextFieldProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  /** The error to show now: the caller decides when a field has been touched. */
  error?: string;
  isDisabled?: boolean;
  cluster: LocationCluster;
};

/** A map position this cluster does not have. An empty site or cloud region stays the usual dash. */
const MISSING_COORDINATES = 'Missing coordinates';

/**
 * The cluster's coordinates, to copy. A cloud-region position says so and links to how to set one.
 * Annotations the hub can't use point at the cluster page, which has the backend's message.
 */
const MapPositionValue: React.FC<{ cluster: LocationCluster }> = ({ cluster }) => {
  const position = mapPositionOf(cluster);
  if (cluster.locationProblem) {
    return (
      <Stack>
        <span>
          <Icon status="warning" isInline>
            <ExclamationTriangleIcon />
          </Icon>{' '}
          Invalid coordinates
        </span>
        <span>
          <Link to={`/clusters/${encodeURIComponent(cluster.name)}`}>View cluster details</Link> for more information.
        </span>
      </Stack>
    );
  }
  if (!position) {
    return (
      <Stack>
        <span>{MISSING_COORDINATES}</span>
        <PositionDocsLink />
      </Stack>
    );
  }
  const coordinates = (
    <ClipboardCopy variant="inline-compact" copyAriaLabel="Copy map position">
      {position}
    </ClipboardCopy>
  );
  if (!isFromCloudRegion(cluster)) return coordinates;
  return (
    <Stack>
      <span>{coordinates} from the cloud region</span>
      <PositionDocsLink />
    </Stack>
  );
};

/** A site or cloud region, or the usual dash when this cluster has none. */
const detailValue = (value?: string) => value || EMPTY_VALUE;

/**
 * Which of the cluster's position, site and cloud region can inform the label. The example is an
 * illustration; the list below reads this cluster. A position the hub can't read is still something
 * to show. With nothing to read, the way to set a position stays in this paragraph and the list is
 * left out.
 */
const locationGuidance = (cluster: LocationCluster) => {
  if (mapPositionOf(cluster)) {
    return (
      <>
        Use the cluster&apos;s position, site, and cloud region to inform the label. For example, a cluster with the
        position 43.65, -79.38 might have the location label <strong>Toronto</strong>.
      </>
    );
  }
  if (cluster.siteName || cluster.region) {
    return cluster.locationProblem
      ? "The map position can't be read, but you can use the site or cloud region to inform the label."
      : 'The map position is not available, but you can use the site or cloud region to inform the label.';
  }
  if (cluster.locationProblem) {
    return <>The map position can&apos;t be read, so it can&apos;t inform the label.</>;
  }
  return (
    <>
      No map position, site, or cloud region is available to inform the label. <PositionDocsLink />.
    </>
  );
};

/**
 * What the location label is for, then this cluster's position, site and cloud region. The list
 * shows all three whenever any of them can inform the label. The terms are the description list's
 * own labels, so they carry no colon.
 */
const LocationLabelHelp: React.FC<{ cluster: LocationCluster }> = ({ cluster }) => {
  const hasDetails = Boolean(mapPositionOf(cluster) || cluster.siteName || cluster.region || cluster.locationProblem);
  return (
    <Stack hasGutter>
      <p>
        Provide a text label that can help identify the cluster&apos;s location on the AI grid map. This label does not
        impact the cluster&apos;s location on the map.
      </p>
      <Title headingLevel="h6" id="location-label-details">
        Cluster details
      </Title>
      <p>{locationGuidance(cluster)}</p>
      {hasDetails && (
        <DescriptionList
          isHorizontal
          isCompact
          horizontalTermWidthModifier={{ default: '6.75rem' }}
          aria-labelledby="location-label-details"
        >
          <DescriptionListGroup>
            <DescriptionListTerm>Map position</DescriptionListTerm>
            <DescriptionListDescription>
              <MapPositionValue cluster={cluster} />
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Site</DescriptionListTerm>
            <DescriptionListDescription>{detailValue(cluster.siteName)}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Cloud region</DescriptionListTerm>
            <DescriptionListDescription>{detailValue(cluster.region)}</DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>
      )}
    </Stack>
  );
};

/** The `location` label: required, a label value. */
export const LocationLabelField: React.FC<TextFieldProps> = ({
  value,
  onChange,
  onBlur,
  error,
  isDisabled,
  cluster,
}) => (
  <FormGroup
    label="Location label"
    fieldId="cluster-location"
    isRequired
    labelHelp={
      <Popover aria-label="Location label" maxWidth="24rem" bodyContent={<LocationLabelHelp cluster={cluster} />}>
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
      aria-describedby={error ? 'cluster-location-help' : undefined}
      onChange={(_e, v) => onChange(v)}
      onBlur={onBlur}
    />
    {error && (
      <FormHelperText>
        <HelperText id="cluster-location-help">
          <HelperTextItem variant="error">{error}</HelperTextItem>
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
  <Popover aria-label="Cluster roles" bodyContent={<ClusterRolesList />}>
    <FormGroupLabelHelp aria-label="More info for the role field" />
  </Popover>
);

/**
 * Why neither dialog changes a role a cluster has: the hub doesn't fully remove what the old role
 * installed (GLOSSARY.md, "Role"; editClusterText.ts). Under a read-only role as its helper text,
 * and under an editable one (Add, and Edit when the cluster has none) as the plain info alert.
 */
export const roleFixedText = "A cluster's role cannot be changed once it has been added to the AI grid.";

/**
 * A role the dialog shows but doesn't change, with why under it: Edit's for an AI grid cluster, and
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
          Select the role this cluster will perform in the AI grid. Components needed to perform the assigned role will
          be installed on the cluster.
        </HelperTextItem>
        {error && <HelperTextItem variant="error">{error}</HelperTextItem>}
      </HelperText>
    </FormHelperText>
    <FormHelperText>
      <Alert isInline isPlain variant="info" title={roleFixedText} />
    </FormHelperText>
  </FormGroup>
);
