import { SIGN_OUT_URL } from '../components/UserMenu';

/** What the console does to the browser's location; a test gives its own. */
export type Navigation = {
  assign: (url: string) => void;
  reload: () => void;
};

export const browserNavigation: Navigation = {
  assign: (url) => window.location.assign(url),
  reload: () => window.location.reload(),
};

/** Where the browser keeps the storage; reading `window.sessionStorage` itself can throw. */
export type GetStorage = () => Storage;

export const browserStorage: GetStorage = () => window.sessionStorage;

/**
 * The login proxy's sign-out, coming back to `path` (path, search and hash). kube-auth-proxy
 * (oauth2-proxy) clears its session cookie, which holds the token the hub rejected, and redirects
 * to `rd`, a same-origin path it checks (its SignOut and GetRedirect); the request for `rd` then
 * starts a new OpenShift login and lands back on this page. A reload would not: the proxy would
 * pass the same rejected token on.
 */
export const signInAgainUrl = (path: string) => `${SIGN_OUT_URL}?rd=${encodeURIComponent(path)}`;

/** Calls `fn` the first time only, as lodash's `_.once` does for the OpenShift console's handle401. */
export const once = (fn: () => void): (() => void) => {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
};

/** When the console last sent this tab to the login, in milliseconds since the epoch. */
export const SIGN_IN_AGAIN_KEY = 'ai-grid-console.sign-in-again-at';

/**
 * A 401 this soon after a recorded redirect means the login sent us back and the token was
 * refused again, so a further redirect would only loop. A login a person types into takes longer.
 */
export const SIGN_IN_AGAIN_WINDOW_MS = 60_000;

/**
 * Records a redirect to the login now, unless one was recorded within the window. False when one
 * was, or when the storage can't be used at all: without a record the console can't tell a loop
 * from a first redirect, so it stops rather than risk one. The OpenShift console likewise stops,
 * at an error page, after several 401 redirects in a row (handle401 in openshift/console
 * frontend/public/module/auth.ts).
 */
export const claimSignInAgain = (storage: GetStorage, now = Date.now()): boolean => {
  try {
    const store = storage();
    const last = Number(store.getItem(SIGN_IN_AGAIN_KEY));
    if (last && now - last >= 0 && now - last < SIGN_IN_AGAIN_WINDOW_MS) {
      return false;
    }
    store.setItem(SIGN_IN_AGAIN_KEY, String(now));
    return true;
  } catch {
    return false;
  }
};

/** Records a redirect the user asked for (Try again), so coming back refused stops at once. */
export const recordSignInAgain = (storage: GetStorage, now = Date.now()) => {
  try {
    storage().setItem(SIGN_IN_AGAIN_KEY, String(now));
  } catch {
    // Nothing to record into; the next 401 shows the ended session instead of redirecting.
  }
};
