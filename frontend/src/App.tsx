import {
  Masthead,
  MastheadBrand,
  MastheadContent,
  MastheadLogo,
  MastheadMain,
  MastheadToggle,
  Nav,
  NavItem,
  NavList,
  Page,
  PageSidebar,
  PageSidebarBody,
  PageToggleButton,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ConsoleService } from './api/ConsoleService';
import { AppRoutes } from './AppRoutes';
import { FakeBackendBanner } from './components/FakeBackendBanner';
import { NoticeToast } from './components/NoticeToast';
import { useServiceData } from './hooks/useServiceData';

type Props = { service: ConsoleService };

// Section order and active-state matching follow the PoC (src/app/App.tsx at 62319b8):
// AI Grid and Monitoring match exactly, the others match by prefix.
const sections: { path: string; label: string; exact?: boolean }[] = [
  { path: '/ai-grid', label: 'AI Grid', exact: true },
  { path: '/monitoring', label: 'Monitoring', exact: true },
  { path: '/clusters', label: 'Clusters' },
  { path: '/organizations', label: 'Organizations' },
  { path: '/models', label: 'Models' },
  { path: '/subscriptions', label: 'Subscriptions' },
];

export const App: React.FC<Props> = ({ service }) => {
  const [user, userLoaded, userError] = useServiceData(() => service.getUser(), undefined, 0);
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const header = (
    <Masthead display={{ default: 'inline' }}>
      <MastheadMain>
        <MastheadToggle>
          <PageToggleButton
            isHamburgerButton
            isSidebarOpen={sidebarOpen}
            onSidebarToggle={() => setSidebarOpen((open) => !open)}
            aria-label={sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
            aria-controls="console-sidebar"
          />
        </MastheadToggle>
        <MastheadBrand>
          <MastheadLogo component="span">
            <Title headingLevel="h1" size="lg" style={{ whiteSpace: 'nowrap' }}>
              Cloud Provider Admin Console
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
    <PageSidebar id="console-sidebar" isSidebarOpen={sidebarOpen}>
      <PageSidebarBody>
        <Nav aria-label="Console sections">
          <NavList>
            {sections.map((s) => (
              <NavItem key={s.path} isActive={s.exact ? pathname === s.path : pathname.startsWith(s.path)}>
                <Link to={s.path}>{s.label}</Link>
              </NavItem>
            ))}
          </NavList>
        </Nav>
      </PageSidebarBody>
    </PageSidebar>
  );

  return (
    <Page masthead={header} sidebar={sidebar} banner={<FakeBackendBanner service={service} />}>
      <NoticeToast />
      <AppRoutes service={service} />
    </Page>
  );
};
