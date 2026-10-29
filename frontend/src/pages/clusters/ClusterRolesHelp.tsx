import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
} from '@patternfly/react-core';
import { HelpPopover } from '../../components/HelpPopover';
import { clusterRoles } from './roles';

/** Every AI Grid role with its description, for the help beside a Role heading or field. */
export const ClusterRolesList: React.FC = () => (
  <DescriptionList isCompact>
    {clusterRoles.map((r) => (
      <DescriptionListGroup key={r.value}>
        <DescriptionListTerm>{r.label}</DescriptionListTerm>
        <DescriptionListDescription>{r.description}</DescriptionListDescription>
      </DescriptionListGroup>
    ))}
  </DescriptionList>
);

/** One role's name with a help icon that explains it, where a cluster's role is shown. */
export const ClusterRoleName: React.FC<{ role: (typeof clusterRoles)[number] }> = ({ role }) => (
  <>
    {role.label} <HelpPopover topic={`the ${role.label} role`}>{role.description}</HelpPopover>
  </>
);
