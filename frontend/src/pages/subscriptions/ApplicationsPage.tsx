// Ported from krisv/ai-grid-cloud-provider-poc src/shared/dashboard.tsx (ApplicationsPage) at 62319b8.
// Adapted from opendatahub-io/odh-dashboard frontend/src/pages/ApplicationsPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Retry calls the page's reload instead of reloading the browser, and a 501 is the console's
// not-available state. A load error replaces the content only until the content first shows:
// the governance data polls, and a failed poll must not unmount a form with the user's input.
import { useState } from 'react';
import { PageSection } from '@patternfly/react-core';
import type { NotFound } from '../../components/LoadError';
import { LoadError } from '../../components/LoadError';
import { PageHeader } from '../../components/PageHeader';
import { PageLoading } from '../../components/PageLoading';

type Props = {
  title: string;
  description?: string;
  breadcrumb?: React.ReactElement;
  headerAction?: React.ReactNode;
  loaded: boolean;
  loadError?: Error;
  errorMessage?: string;
  onRetry: () => void;
  /** For a page of one subscription: what a 404 says. */
  notFound?: NotFound;
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
  notFound,
  children,
}) => {
  const [contentShown, setContentShown] = useState(false);
  if (!contentShown && loaded && !loadError) {
    setContentShown(true);
  }
  let body: React.ReactNode = children;
  if (!contentShown && !loaded) {
    body = <PageLoading label="Loading data" />;
  } else if (!contentShown && loadError) {
    body = (
      <PageSection isFilled>
        <LoadError
          subject="Subscriptions"
          error={loadError}
          title={errorMessage ?? 'Unable to load subscriptions'}
          onRetry={onRetry}
          notFound={notFound}
        />
      </PageSection>
    );
  }
  return (
    <>
      <PageHeader title={title} description={description} breadcrumb={breadcrumb} headerAction={headerAction} />
      {body}
    </>
  );
};
