// Ported from krisv/ai-grid-cloud-provider-poc src/shared/dashboard.tsx (ApplicationsPage) at 62319b8.
// Adapted from opendatahub-io/odh-dashboard frontend/src/pages/ApplicationsPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Retry calls the page's reload instead of reloading the browser, and a 501 is the console's
// not-available state. A load error replaces the content only until the content first shows:
// the governance data polls, and a failed poll must not unmount a form with the user's input.
import { useState } from 'react';
import { Alert, Button, Flex, FlexItem, PageSection, Spinner, Title } from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import { LoadError } from '../../components/LoadError';

type Props = {
  title: string;
  description?: React.ReactNode;
  breadcrumb?: React.ReactElement;
  headerAction?: React.ReactNode;
  loaded: boolean;
  loadError?: Error;
  errorMessage?: string;
  onRetry: () => void;
  children?: React.ReactNode;
};

/** A subscription page: breadcrumb, title and actions, then a spinner, the error, or the content. */
export const ApplicationsPage: React.FC<Props> = ({
  title,
  description,
  breadcrumb,
  headerAction,
  loaded,
  loadError,
  errorMessage,
  onRetry,
  children,
}) => {
  const [contentShown, setContentShown] = useState(false);
  if (!contentShown && loaded && !loadError) {
    setContentShown(true);
  }
  let body: React.ReactNode = children;
  if (!contentShown && !loaded) {
    body = (
      <PageSection>
        <Spinner aria-label="Loading data" />
      </PageSection>
    );
  } else if (!contentShown && loadError instanceof ServiceError && loadError.isNotImplemented) {
    body = (
      <PageSection>
        <LoadError subject="Subscriptions" error={loadError} />
      </PageSection>
    );
  } else if (!contentShown && loadError) {
    body = (
      <PageSection>
        <Alert variant="danger" isInline title={errorMessage ?? 'Unable to load subscriptions'}>
          {loadError.message}
          <div>
            <Button variant="link" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </Alert>
      </PageSection>
    );
  }
  return (
    <>
      <PageSection>
        {breadcrumb}
        <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <Title headingLevel="h2">{title}</Title>
          </FlexItem>
          {headerAction && <FlexItem>{headerAction}</FlexItem>}
        </Flex>
        {description}
      </PageSection>
      {body}
    </>
  );
};
