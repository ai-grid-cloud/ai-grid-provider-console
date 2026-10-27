import { Component, type ErrorInfo } from 'react';

type Props = { children: React.ReactNode };

type State = { error?: Error };

/**
 * Catches whatever fails to render outside a page (the masthead, the user menu, the nav, the
 * toasts, the About dialog, the non-admin page), which would otherwise unmount the whole console
 * and leave a blank screen; PageErrorBoundary catches a page's own errors. Its fallback is plain
 * HTML with PatternFly's class names, so it still shows if a PatternFly component, the router or
 * the session is what broke.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The console failed to render:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <main className="pf-v6-l-bullseye pf-v6-u-h-100vh">
        <div className="pf-v6-c-empty-state">
          <div className="pf-v6-c-empty-state__content">
            <h1 className="pf-v6-c-empty-state__title-text">The console ran into a problem</h1>
            <div className="pf-v6-c-empty-state__body">
              Something in the console failed, so it can&apos;t show anything. Reload to start it again.
            </div>
            <div className="pf-v6-c-empty-state__footer">
              <div className="pf-v6-c-empty-state__actions">
                <button type="button" className="pf-v6-c-button pf-m-primary" onClick={() => window.location.reload()}>
                  <span className="pf-v6-c-button__text">Reload</span>
                </button>
              </div>
              <details>
                <summary>Error details</summary>
                <p className="pf-v6-u-text-align-start pf-v6-u-font-family-monospace pf-v6-u-text-break-word">
                  {error.message}
                </p>
              </details>
            </div>
          </div>
        </div>
      </main>
    );
  }
}
