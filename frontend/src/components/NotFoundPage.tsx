import { PageSection } from '@patternfly/react-core';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { NotFoundState } from './states/NotFoundState';

/** An unknown route: the not-found state, as the page's only heading, with a way back. */
export const NotFoundPage: React.FC = () => {
  useDocumentTitle('Page not found');
  return (
    <PageSection isFilled>
      <NotFoundState
        what="Page"
        headingLevel="h1"
        body="Check the address, or go to the AI Grid page."
        listPath="/ai-grid"
        listLabel="AI Grid"
      />
    </PageSection>
  );
};
