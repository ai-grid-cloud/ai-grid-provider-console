// The background writes' context and hook, in their own module so BackgroundWritesProvider.tsx
// exports only the provider.
import { createContext, useContext } from 'react';
import type { WriteSubject, WriteTarget } from './writeText';

/**
 * How a write ended for the form: `done` when the backend answered within the form's short wait
 * (the notification center says so), `pending` when the notification center took it over (the
 * form leaves as on success; the center follows the write).
 */
export type WriteOutcome = 'done' | 'pending';

/**
 * What a create that the backend refused after the form had left submitted, kept for the form to
 * reopen with: the form's own values (JSON), and the refusal's message as the form's error.
 */
export type WriteDraft = {
  key: string;
  subject: WriteSubject;
  values: unknown;
  error: string;
};

export type BackgroundWritesValue = {
  /**
   * Sends a write from the app root, so it keeps running after the form unmounts. Resolves within
   * the form's short wait; rejects with any answer that came back within it, which the form shows
   * as before (a definite refusal, or the backend unreachable). `draft` is what a create's form
   * holds, kept should the backend refuse the create after the form has left. `idOf` reads the id
   * the backend gave the object from its answer, which a create may not keep as requested (the
   * backend adds a suffix to a subscription's name): the landed write is followed, and linked, by
   * that id. Without one, or when the answer names none, the requested id stands.
   */
  submitWrite: <A>(
    target: WriteTarget & { draft?: unknown },
    send: () => Promise<A>,
    idOf?: (answer: A) => string | undefined,
  ) => Promise<WriteOutcome>;
  /**
   * A write the page sent itself and the backend confirmed, a cluster's labels, which the backend
   * writes at once while the dialog waits, keeping its refusals: the notification center says it
   * was saved (as read, the answer to the user's click) and follows what the hub does next
   * (watchCluster).
   */
  followWrite: (target: WriteTarget) => void;
  /** A refused create's draft, by the id in the toast's link (`?draft=`). */
  draftOf: (id: string) => WriteDraft | undefined;
};

export const BackgroundWritesContext = createContext<BackgroundWritesValue>({
  // Without the provider (a component test of its own), a write is what it always was.
  submitWrite: async (_target, send) => {
    await send();
    return 'done';
  },
  followWrite: () => undefined,
  draftOf: () => undefined,
});

export const useBackgroundWrites = () => useContext(BackgroundWritesContext);
