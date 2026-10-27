import { Component, type ErrorInfo } from 'react';
import {
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  ExpandableSection,
  PageSection,
} from '@patternfly/react-core';
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { isDynamicImportError } from '../utilities/errors';

type Props = {
  /** The page's path: moving to another page tries again. */
  resetKey: string;
  children: React.ReactNode;
};

type State = { error?: Error; resetKey: string; detailsOpen: boolean };

/**
 * Catches a page that fails to render. Most often that is a page's code that can no longer be
 * fetched: pages load on demand, and a tab left open across a redeploy asks for files the new
 * version no longer has, so a reload fetches the current version. Any other error is a bug in
 * the page, shown with its message for a bug report.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { resetKey: this.props.resetKey, detailsOpen: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey
      ? null
      : { error: undefined, resetKey: props.resetKey, detailsOpen: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('A console page failed to render:', error, info.componentStack);
  }

  render() {
    const { error, detailsOpen } = this.state;
    if (!error) {
      return this.props.children;
    }
    const outdated = isDynamicImportError(error);
    return (
      <PageSection isFilled>
        <EmptyState
          titleText={outdated ? 'This page could not be loaded' : 'Something went wrong on this page'}
          headingLevel="h1"
          icon={ExclamationCircleIcon}
        >
          <EmptyStateBody>
            {outdated
              ? 'The console may have been updated since this tab opened. Reload to get the current version.'
              : 'The console ran into a problem showing this page. Reload to try again, or go to another page.'}
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload
              </Button>
            </EmptyStateActions>
            {!outdated && (
              <ExpandableSection
                toggleText="Error details"
                isExpanded={detailsOpen}
                onToggle={(_event, expanded) => this.setState({ detailsOpen: expanded })}
              >
                <p className="pf-v6-u-text-align-start pf-v6-u-font-family-monospace pf-v6-u-text-break-word">
                  {error.message}
                </p>
              </ExpandableSection>
            )}
          </EmptyStateFooter>
        </EmptyState>
      </PageSection>
    );
  }
}
