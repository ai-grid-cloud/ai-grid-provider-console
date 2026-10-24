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
import { AboutConsoleModal } from './components/AboutConsoleModal';
import { ThemeToggle } from './components/ThemeToggle';
import { UserMenu } from './components/UserMenu';
import { ThemeProvider } from './context/ThemeContext';
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
  const [config] = useServiceData(() => service.getConfig(), undefined, 0);
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(false);

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
          <MastheadLogo component="span" className="pf-v6-u-display-flex pf-v6-u-align-items-center">
            <Title headingLevel="h2" size="lg">
              Cloud Provider Admin Console
            </Title>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            {/* A phone has no room for it beside the user menu, which offers the theme there instead. */}
            <ToolbarItem align={{ default: 'alignEnd' }} visibility={{ default: 'hidden', md: 'visible' }}>
              <ThemeToggle />
            </ToolbarItem>
            <ToolbarItem align={{ default: 'alignEnd', md: 'alignStart' }}>
              <UserMenu
                user={user}
                loaded={userLoaded}
                error={userError}
                canSignOut={config?.fakeBackend !== true}
                onAbout={() => setAboutOpen(true)}
              />
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
    <ThemeProvider>
      <Page isContentFilled masthead={header} sidebar={sidebar} banner={<FakeBackendBanner service={service} />}>
        <NoticeToast />
        <AppRoutes service={service} />
        <AboutConsoleModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} config={config} user={user} />
      </Page>
    </ThemeProvider>
  );
};
