import { Content } from '@patternfly/react-core';
import { HelpPopover } from '../../components/HelpPopover';
import { clusterRoles } from './roles';

/**
 * What roles are and every AI grid role, for the help beside a Role heading or field: an intro, the
 * roles as a list with their names in bold, and that a role is set once.
 */
export const ClusterRolesList: React.FC = () => (
  <Content>
    <Content component="p">Roles define what each cluster does in the AI grid.</Content>
    <Content component="ul">
      {clusterRoles.map((r) => (
        <Content component="li" key={r.value}>
          <strong>{r.label}</strong> {r.clusters}
        </Content>
      ))}
    </Content>
    <Content component="p">
      Roles are assigned when adding a cluster to the AI grid, and cannot be changed once set.
    </Content>
  </Content>
);

/** One role's name with a help icon that explains it, where a cluster's role is shown. */
export const ClusterRoleName: React.FC<{ role: (typeof clusterRoles)[number] }> = ({ role }) => (
  <>
    {role.label} <HelpPopover topic={`the ${role.label} role`}>{role.description}</HelpPopover>
  </>
);
