import { useState } from 'react';
import {
  Masthead,
  MastheadBrand,
  MastheadContent,
  MastheadLogo,
  MastheadMain,
  Nav,
  NavItem,
  NavList,
  Page,
  PageSection,
  PageSidebar,
  PageSidebarBody,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import type { ConsoleService } from './api/ConsoleService';
import { useServiceData } from './hooks/useServiceData';
import { ClustersPage } from './pages/ClustersPage';
import { TenantsPage } from './pages/TenantsPage';

type Props = { service: ConsoleService };

type Section = 'clusters' | 'tenants';

const sections: { id: Section; label: string }[] = [
  { id: 'clusters', label: 'Clusters' },
  { id: 'tenants', label: 'Tenants' },
];

export const App: React.FC<Props> = ({ service }) => {
  const [user, userLoaded, userError] = useServiceData(() => service.getUser(), undefined, 0);
  const [section, setSection] = useState<Section>('clusters');

  const header = (
    <Masthead>
      <MastheadMain>
        <MastheadBrand>
          <MastheadLogo component="span">
            <Title headingLevel="h1" size="lg">
              AI Grid provider console
            </Title>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarItem align={{ default: 'alignEnd' }}>
              <span data-testid="masthead-user">
                {userError ? 'Not signed in' : !userLoaded ? 'Signing in...' : user?.username}
                {user?.isProviderAdmin ? ' (provider admin)' : ''}
              </span>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );

  const sidebar = (
    <PageSidebar>
      <PageSidebarBody>
        <Nav aria-label="Console sections" onSelect={(_e, item) => setSection(item.itemId as Section)}>
          <NavList>
            {sections.map((s) => (
              <NavItem key={s.id} itemId={s.id} to={`#${s.id}`} preventDefault isActive={section === s.id}>
                {s.label}
              </NavItem>
            ))}
          </NavList>
        </Nav>
      </PageSidebarBody>
    </PageSidebar>
  );

  return (
    <Page masthead={header} sidebar={sidebar}>
      <PageSection>
        {section === 'clusters' ? (
          <ClustersPage service={service} canEdit={user?.isProviderAdmin ?? false} />
        ) : (
          <TenantsPage service={service} />
        )}
      </PageSection>
    </Page>
  );
};
