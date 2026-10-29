import { useState } from 'react';
import { Divider, Dropdown, DropdownGroup, DropdownItem, DropdownList, MenuToggle } from '@patternfly/react-core';
import { UserIcon } from '@patternfly/react-icons';
import { ServiceError } from '../api/ConsoleService';
import type { User } from '../api/types';
import { useTheme } from '../context/useTheme';
import type { ThemeChoice } from '../utilities/theme';

const themes: { choice: ThemeChoice; label: string }[] = [
  { choice: 'light', label: 'Light' },
  { choice: 'dark', label: 'Dark' },
  { choice: 'system', label: 'System' },
];

/** Where kube-auth-proxy (oauth2-proxy) ends the session and starts a new login. */
export const SIGN_OUT_URL = '/oauth2/sign_out';

type Props = {
  user?: User;
  loaded: boolean;
  error?: Error;
  /** Offer Log out; off on the fake backend, where no login proxy runs. On while the config
   * loads or if it fails, so a user can always leave. */
  canSignOut: boolean;
  /** Opens the About dialog. */
  onAbout: () => void;
};

/**
 * The masthead's user menu (PatternFly masthead pattern): who is signed in, About, and Log out. On a
 * phone it also offers the theme, which the masthead's toggle offers on wider screens.
 */
export const UserMenu: React.FC<Props> = ({ user, loaded, error, canSignOut, onAbout }) => {
  const [isOpen, setIsOpen] = useState(false);
  const { choice, setChoice } = useTheme();
  // Only a 401 means nobody is signed in; any other failure is the console failing to say who is.
  const who = error
    ? error instanceof ServiceError && error.isUnauthenticated
      ? 'Not logged in'
      : 'Unable to load user'
    : !loaded
      ? 'Logging in'
      : user?.username;
  const name = `${who}${user?.isProviderAdmin ? ' (provider admin)' : ''}`;
  // A menu even while signing in or when /user fails: About, with the versions a bug report
  // needs, matters most then. Log out too: the login proxy holds a session whether or not /user
  // answered, and logging out is how to end it or sign in as someone else.
  return (
    <Dropdown
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      popperProps={{ position: 'right' }}
      toggle={(toggleRef) => (
        <MenuToggle
          ref={toggleRef}
          variant="plainText"
          icon={<UserIcon />}
          aria-label={`User menu: ${name}`}
          isExpanded={isOpen}
          onClick={() => setIsOpen((open) => !open)}
        >
          {/* A phone shows the icon only, so the console's name keeps the room it needs. */}
          <span data-testid="masthead-user" className="pf-v6-u-display-none pf-v6-u-display-inline-on-md">
            {name}
          </span>
        </MenuToggle>
      )}
    >
      <DropdownGroup label="Theme" className="pf-v6-u-display-none-on-md">
        <DropdownList>
          {themes.map((t) => (
            <DropdownItem
              key={t.choice}
              isSelected={choice === t.choice}
              onClick={() => {
                setIsOpen(false);
                setChoice(t.choice);
              }}
            >
              {t.label}
            </DropdownItem>
          ))}
        </DropdownList>
      </DropdownGroup>
      <Divider className="pf-v6-u-display-none-on-md" />
      <DropdownList>
        <DropdownItem
          key="about"
          onClick={() => {
            setIsOpen(false);
            onAbout();
          }}
        >
          About
        </DropdownItem>
        {canSignOut && (
          <DropdownItem key="sign-out" to={SIGN_OUT_URL}>
            Log out
          </DropdownItem>
        )}
      </DropdownList>
    </Dropdown>
  );
};
