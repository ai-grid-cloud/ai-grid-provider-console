import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ServiceError } from '../api/ConsoleService';
import { useConsoleSession } from '../context/useConsoleSession';

/**
 * Loads data from the service and optionally re-polls it, until the session has ended.
 * Returns [data, loaded, error, refresh].
 */
export const useServiceData = <T>(
  request: () => Promise<T>,
  initial: T,
  pollIntervalMs = 30000,
): [T, boolean, Error | undefined, () => Promise<void>] => {
  const [data, setData] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  // Once a call has answered 401, every poll would send the same rejected token.
  const { sessionEnded } = useConsoleSession();
  const requestRef = useRef(request);
  // Numbers each request, so a response that arrives after a newer request was started is dropped.
  const latestRef = useRef(0);
  // True while the newest request is unanswered. A poll waits for it rather than replacing it, so a
  // backend slower than the poll interval still gets its answers shown.
  const pendingRef = useRef(false);
  // When the newest request was answered, so a tab shown again knows whether its data is stale.
  const answeredAtRef = useRef(0);
  // True once a request has succeeded.
  const succeededRef = useRef(false);
  // Keep the latest request without re-running the effect; refs are written after render, not during it.
  useLayoutEffect(() => {
    requestRef.current = request;
  });

  const refresh = useCallback(async () => {
    const id = ++latestRef.current;
    pendingRef.current = true;
    try {
      const result = await requestRef.current();
      if (id !== latestRef.current) return;
      setData(result);
      setError(undefined);
      succeededRef.current = true;
    } catch (e) {
      if (id !== latestRef.current) return;
      // An ended session (401) is shown once for the whole console, so a page that has loaded keeps
      // what it shows rather than turning into an error.
      if (!(succeededRef.current && e instanceof ServiceError && e.isUnauthenticated)) {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    }
    pendingRef.current = false;
    answeredAtRef.current = Date.now();
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (pollIntervalMs <= 0 || sessionEnded) {
      return;
    }
    // A hidden tab skips its polls; shown again, it asks at once if the last answer is older than a poll.
    const timer = window.setInterval(() => {
      if (!pendingRef.current && !document.hidden) void refresh();
    }, pollIntervalMs);
    const onVisibilityChange = () => {
      if (!document.hidden && !pendingRef.current && Date.now() - answeredAtRef.current >= pollIntervalMs) {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh, pollIntervalMs, sessionEnded]);

  return [data, loaded, error, refresh];
};
