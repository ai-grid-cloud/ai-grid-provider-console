import { PageSection, Title } from '@patternfly/react-core';
import { Link } from 'react-router-dom';

// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx at 62319b8.
export const NotFoundPage: React.FC = () => (
  <PageSection>
    <Title headingLevel="h1">Page not found</Title>
    <Link to="/clusters">Go to clusters</Link>
  </PageSection>
);
