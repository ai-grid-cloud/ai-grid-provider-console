import { useState } from 'react';
import { Alert, AlertActionCloseButton, AlertGroup } from '@patternfly/react-core';
import { useLocation } from 'react-router-dom';

// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx at 62319b8.
/** Shows `navigate(path, { state: { notice } })` as a success toast. */
export const NoticeToast: React.FC = () => {
  const location = useLocation();
  const [notice, setNotice] = useState<string>();
  // Pick up a notice once per navigation, during render rather than in an effect.
  const [lastKey, setLastKey] = useState<string>();
  if (location.key !== lastKey) {
    setLastKey(location.key);
    const state = location.state as { notice?: string } | null;
    if (state?.notice) {
      setNotice(state.notice);
    }
  }

  if (!notice) {
    return null;
  }
  return (
    <AlertGroup isToast>
      <Alert
        variant="success"
        title={notice}
        actionClose={<AlertActionCloseButton onClose={() => setNotice(undefined)} />}
      />
    </AlertGroup>
  );
};
