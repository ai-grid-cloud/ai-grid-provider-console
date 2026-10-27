import { useEffect, useState } from 'react';
import { Alert, AlertActionCloseButton, AlertGroup } from '@patternfly/react-core';
import { useLocation, useNavigate } from 'react-router-dom';

type NoticeState = { notice?: string } | null;

// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx at 62319b8.
/**
 * Shows `navigate(path, { state: { notice } })` as a success toast, until it is closed, it times
 * out (PatternFly's 8 seconds, paused while the pointer or focus is on it), or the user moves on
 * to another page.
 */
export const NoticeToast: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string>();
  // Pick up a notice once per navigation, during render rather than in an effect; a navigation to
  // another page without one clears the last, so it doesn't follow the user around.
  const [last, setLast] = useState<{ key: string; pathname: string }>();
  if (location.key !== last?.key) {
    setLast({ key: location.key, pathname: location.pathname });
    const state = location.state as NoticeState;
    if (state?.notice || location.pathname !== last?.pathname) {
      setNotice(state?.notice);
    }
  }
  // Once taken, the notice leaves its history entry (the same page, replaced without it), so Back
  // to that entry doesn't show it again. The replace stays on the page, so the toast stays too.
  useEffect(() => {
    const state = location.state as NoticeState;
    if (!state?.notice) return;
    const rest = { ...state };
    delete rest.notice;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: Object.keys(rest).length > 0 ? rest : null },
    );
  }, [location, navigate]);

  if (!notice) {
    return null;
  }
  return (
    <AlertGroup isToast>
      <Alert
        variant="success"
        title={notice}
        timeout
        onTimeout={() => setNotice(undefined)}
        actionClose={<AlertActionCloseButton onClose={() => setNotice(undefined)} />}
      />
    </AlertGroup>
  );
};
