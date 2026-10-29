import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { FullPageState } from './states/FullPageState';

type Props = {
  username: string;
  /** The user menu offers Log out; not on the fake backend, which has no login. */
  canSignOut: boolean;
};

/**
 * What a signed-in user who is not a provider admin sees instead of the pages and their nav: the
 * BFF answers them 403 on everything but /user and /config (docs/plan/bff-api.md, Identity), so
 * every page would only show an error.
 */
export const ProviderAdminsOnly: React.FC<Props> = ({ username, canSignOut }) => {
  useDocumentTitle('Provider admins only');
  return (
    <FullPageState title="Access permissions needed">
      You are logged in as {username}, who is not a provider admin on this hub.{' '}
      {canSignOut
        ? 'To use this console, ask your hub administrator for provider admin access, then reload the page. To use another account, log out from the user menu.'
        : "The fake backend has no login: to use the console as a provider admin, restart the dev server with a provider admin's AUTH_TOKEN."}
    </FullPageState>
  );
};
