import { EmptyState, EmptyStateBody, PageSection } from '@patternfly/react-core';

type Props = { title: string };

/** Placeholder for a route whose page has not been ported from the PoC yet. */
export const NotYetPortedPage: React.FC<Props> = ({ title }) => (
  <PageSection>
    <EmptyState titleText={`${title} isn't ported yet`} headingLevel="h1">
      <EmptyStateBody>This page is still being ported from the proof of concept.</EmptyStateBody>
    </EmptyState>
  </PageSection>
);
