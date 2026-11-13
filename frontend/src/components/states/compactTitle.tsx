/**
 * A compact alert's one line: the bold title, then the server's message in normal weight, so the
 * alert is that line and Retry. Both are in the alert's heading, which screen readers announce.
 */
export const compactTitle = (title: string, error: Error) => (
  <>
    {title}.{' '}
    <span className="pf-v6-u-font-weight-normal" data-testid="alert-message">
      {error.message}
    </span>
  </>
);
