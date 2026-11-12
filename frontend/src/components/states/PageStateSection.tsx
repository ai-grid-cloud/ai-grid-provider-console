import { useState } from 'react';
import { PageSection, Stack, StackItem } from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import { LoadError, type NotFound } from '../LoadError';
import { PageHeader } from '../PageHeader';
import { PageLoading } from '../PageLoading';
import { StaleDataAlert } from './StaleDataAlert';

type Props = {
  title: string;
  description?: React.ReactNode;
  breadcrumb?: React.ReactElement;
  /** The object's compact status label, beside the title. */
  status?: React.ReactNode;
  headerAction?: React.ReactNode;
  /** The first answer has arrived, or failed. */
  loaded: boolean;
  error?: Error;
  /** Loads again: the error's Retry and the stale-data warning's. */
  onRetry: () => void;
  /** The feature, plural ("Models"), for the not-available title. */
  subject: string;
  /** What the page shows, for "Unable to load <object>" and "Showing the last loaded <object>". */
  object?: string;
  /** The spinner's accessible name, e.g. "Loading clusters". */
  loadingLabel: string;
  /**
   * For a page of one object: what a 404 says. It also makes the page an object's: until the object
   * has answered once, the page is the spinner alone, with no title or breadcrumb from the URL's id.
   */
  notFound?: NotFound;
  notAvailableTitle?: string;
  /** Off for content that brings its own padding. */
  hasBodyWrapper?: boolean;
  /**
   * The content is a Wizard: PatternFly's wizard page section, which fills the page so the wizard's
   * footer stays in view and only the step scrolls.
   */
  isWizard?: boolean;
  children?: React.ReactNode;
};

/**
 * A console page: the header (breadcrumb, h1, status, actions, description) and one filled section
 * holding the page's state. The section shows, in order:
 *
 * - a 404 on a page for one object, or a 501, whatever was shown before (the object is gone, or the
 *   backend no longer serves it): NotFoundState, with the list's name as the title, or NotAvailableState;
 * - before the content has shown once: the spinner, or the failed load's state (LoadError). On a
 *   page for one object (with `notFound`), the spinner is the whole page and a failed load's header
 *   names the list: nothing is built from the URL's id before the object answers;
 * - after: the content, with a StaleDataAlert above it while the latest reload has failed. A failed
 *   poll never unmounts the content, so a form keeps the user's input.
 */
export const PageStateSection: React.FC<Props> = ({
  title,
  description,
  breadcrumb,
  status,
  headerAction,
  loaded,
  error,
  onRetry,
  subject,
  object,
  loadingLabel,
  notFound,
  notAvailableTitle,
  hasBodyWrapper,
  isWizard,
  children,
}) => {
  const [shown, setShown] = useState(false);
  if (!shown && loaded && !error) {
    setShown(true);
  }
  const what = object ?? subject.toLowerCase();
  const serviceError = error instanceof ServiceError ? error : undefined;
  const gone = !!notFound && serviceError?.status === 404;
  const replaced = !!error && (gone || !!serviceError?.isNotImplemented || !shown);
  const loadError = error && (
    <LoadError
      subject={subject}
      object={what}
      error={error}
      onRetry={onRetry}
      notFound={notFound}
      notAvailableTitle={notAvailableTitle}
    />
  );

  let body: React.ReactNode;
  if (replaced) {
    body = <PageSection isFilled>{loadError}</PageSection>;
  } else if (!shown) {
    body = <PageLoading label={loadingLabel} />;
    if (notFound) {
      // An object's page: nothing but the spinner until the object answers, so the header never
      // shows the id first and the name a moment later.
      return body;
    }
  } else {
    // The alert's slot is always there, so the content keeps its place (and its state) when it comes and
    // goes; the Stack spaces the two.
    // 401 shows nothing: the console says once that the session has ended.
    const stale = error && !(serviceError?.isUnauthenticated ?? false);
    body = (
      <PageSection isFilled type={isWizard ? 'wizard' : undefined} hasBodyWrapper={isWizard ? false : hasBodyWrapper}>
        <Stack hasGutter>
          {stale ? (
            <StackItem>
              <StaleDataAlert object={what} error={error} onRetry={onRetry} />
            </StackItem>
          ) : null}
          <StackItem isFilled>{children}</StackItem>
        </Stack>
      </PageSection>
    );
  }

  return (
    <>
      {notFound && (gone || (replaced && !shown)) ? (
        // The object isn't there, or never answered: the header names its list, not the id in the URL.
        <PageHeader title={notFound.listLabel} />
      ) : (
        <PageHeader
          title={title}
          description={description}
          breadcrumb={breadcrumb}
          status={replaced ? undefined : status}
          headerAction={replaced ? undefined : headerAction}
        />
      )}
      {body}
    </>
  );
};
