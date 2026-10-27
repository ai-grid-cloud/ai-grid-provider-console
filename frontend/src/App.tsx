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
  SkipToContent,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { ConsoleService } from './api/ConsoleService';
import { AppRoutes } from './AppRoutes';
import { FakeBackendBanner } from './components/FakeBackendBanner';
import { NoticeToast } from './components/NoticeToast';
import { AboutConsoleModal } from './components/AboutConsoleModal';
import { ProviderAdminsOnly } from './components/ProviderAdminsOnly';
import { SessionEnded, type SessionEnd } from './components/SessionEnded';
import { ThemeToggle } from './components/ThemeToggle';
import { UserMenu } from './components/UserMenu';
import { watchSession } from './api/watchSession';
import { ConsoleSessionContext } from './context/useConsoleSession';
import { ThemeProvider } from './context/ThemeContext';
import { useServiceData } from './hooks/useServiceData';
import {
  browserNavigation,
  browserStorage,
  claimSignInAgain,
  once,
  recordSignInAgain,
  signInAgainUrl,
  type GetStorage,
  type Navigation,
} from './utilities/signInAgain';

type Props = {
  service: ConsoleService;
  /** The browser's location and session storage; a test gives its own. */
  navigation?: Navigation;
  storage?: GetStorage;
};

/** The page's main region, where Skip to content goes. */
const MAIN_ID = 'console-main';

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

export const App: React.FC<Props> = ({ service: given, navigation = browserNavigation, storage = browserStorage }) => {
  // Any call answered 401 means the session has ended. As the OpenShift console does (handle401 in
  // openshift/console frontend/public/module/auth.ts), the console then goes through the login
  // again, once per page load, unless it has just come back from the login and been refused again.
  // Decided at the first 401 only; every later one is the same answer.
  const [ended, setEnded] = useState<'redirecting' | 'refused'>();
  const service = useMemo(
    () =>
      watchSession(
        given,
        // Recorded even on the fake backend, which never redirects. A user that loads doesn't clear
        // it: that only says the hub accepts the token, and the backend may still refuse it, so
        // clearing it would loop through the login. Only the window running out forgets it.
        once(() => setEnded(claimSignInAgain(storage) ? 'redirecting' : 'refused')),
      ),
    [given, storage],
  );
  const sessionEnded = ended !== undefined;
  // Loaded once here and given to every page through the session context.
  const [user, userLoaded, userError] = useServiceData(() => service.getUser(), undefined, 0);
  const [config, , configError] = useServiceData(() => service.getConfig(), undefined, 0);
  // Only the config says whether a login proxy runs: the fake backend has none. Without it (it
  // failed to load, for whatever reason) the console can't tell, so it doesn't redirect on its own
  // and offers both Try again and Reload.
  const sessionEnd: SessionEnd | undefined = !ended
    ? undefined
    : config
      ? config.fakeBackend
        ? 'fake'
        : ended
      : configError
        ? 'unknown'
        : 'checking';
  // One check at a time, so a dashboard whose panels all answer 401 asks once. The user's 401
  // goes through watchSession like any other; any other answer leaves the session as it is.
  const checking = useRef(false);
  const checkSession = useCallback(() => {
    if (checking.current || sessionEnded) {
      return;
    }
    checking.current = true;
    void service
      .getUser()
      .catch(() => undefined)
      .finally(() => {
        checking.current = false;
      });
  }, [service, sessionEnded]);
  const session = useMemo(
    () => ({ user, userLoaded, userError, config, configError, sessionEnded, checkSession }),
    [user, userLoaded, userError, config, configError, sessionEnded, checkSession],
  );
  const { pathname, search, hash } = useLocation();
  const signInAgain = signInAgainUrl(pathname + search + hash);
  const navigatedRef = useRef(false);
  useEffect(() => {
    if (sessionEnd === 'redirecting' && !navigatedRef.current) {
      navigatedRef.current = true;
      navigation.assign(signInAgain);
    }
  }, [sessionEnd, navigation, signInAgain]);
  // Once the session has ended no page is left to show, nor a nav that leads to one; nor for a
  // user the hub says is no provider admin (only an answer that says so, never a user still
  // loading or failing to load), to whom every page would answer 403.
  const notAdmin = user?.isProviderAdmin === false;
  const fullPage = sessionEnd !== undefined || notAdmin;
  const canSignOut = config?.fakeBackend !== true;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(false);

  const header = (
    <Masthead display={{ default: 'inline' }}>
      {/* Centred on the user menu's line. PatternFly's masthead puts this at the top of its row,
          which the nav toggle fills; the full pages have no toggle, and the name alone is shorter
          than the menu. There the name starts at the masthead's edge, as in PatternFly's masthead
          without a toggle. */}
      <MastheadMain className="pf-v6-u-align-self-center">
        {!fullPage && (
          <MastheadToggle>
            <PageToggleButton
              isHamburgerButton
              isSidebarOpen={sidebarOpen}
              onSidebarToggle={() => setSidebarOpen((open) => !open)}
              aria-label={sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
              aria-controls="console-sidebar"
            />
          </MastheadToggle>
        )}
        <MastheadBrand>
          <MastheadLogo component="span" className="pf-v6-u-display-flex pf-v6-u-align-items-center">
            {/* The product name, not a heading: each page's h1 is the first heading. */}
            <span className="pf-v6-c-title pf-m-lg">Cloud Provider Admin Console</span>
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
                canSignOut={canSignOut}
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

  const content = sessionEnd ? (
    <SessionEnded
      state={sessionEnd}
      onTryAgain={() => {
        recordSignInAgain(storage);
        navigation.assign(signInAgain);
      }}
      onReload={navigation.reload}
    />
  ) : notAdmin ? (
    <ProviderAdminsOnly username={user.username} canSignOut={canSignOut} />
  ) : (
    <AppRoutes service={service} />
  );

  return (
    <ThemeProvider>
      <ConsoleSessionContext.Provider value={session}>
        <Page
          isContentFilled
          masthead={header}
          sidebar={fullPage ? undefined : sidebar}
          banner={<FakeBackendBanner />}
          mainContainerId={MAIN_ID}
          skipToContent={<SkipToContent href={`#${MAIN_ID}`}>Skip to content</SkipToContent>}
        >
          <NoticeToast />
          {content}
          <AboutConsoleModal
            isOpen={aboutOpen}
            onClose={() => setAboutOpen(false)}
            config={config}
            configError={configError}
            user={user}
            userError={userError}
          />
        </Page>
      </ConsoleSessionContext.Provider>
    </ThemeProvider>
  );
};
