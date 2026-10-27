import { Bullseye, EmptyState, EmptyStateBody, PageSection } from '@patternfly/react-core';
import { LockIcon } from '@patternfly/react-icons';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

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
    // Centred, as the ended session is: the page has no nav either.
    <PageSection isFilled hasBodyWrapper={false}>
      <Bullseye className="pf-v6-u-flex-grow-1">
        <EmptyState titleText="This console is for provider admins" headingLevel="h1" icon={LockIcon}>
          <EmptyStateBody>
            You are signed in as {username}, who is not a provider admin on this hub. A provider admin can change
            managed clusters on the hub.{' '}
            {canSignOut
              ? 'Ask a hub administrator for that access, then reload this page, or log out from the user menu and sign in as someone else.'
              : "The fake backend has no login: to use the console as a provider admin, restart the dev server with a provider admin's AUTH_TOKEN."}
          </EmptyStateBody>
        </EmptyState>
      </Bullseye>
    </PageSection>
  );
};
