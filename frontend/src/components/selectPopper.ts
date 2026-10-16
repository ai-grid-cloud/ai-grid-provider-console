// Ported from krisv/ai-grid-cloud-provider-poc src/shared/utilities/select.ts at 62319b8.
import { useEffect, type RefObject } from 'react';

/** Where a select's menu attaches: the enclosing modal, so it isn't clipped, else the body. */
export const resolveSelectPopperAppendTo = (element: HTMLElement | null): HTMLElement =>
  element?.closest<HTMLElement>('.pf-v6-c-modal-box') ?? document.body;

/** Lets an open select menu overflow the modal body it sits in. */
export const useModalOverflowUnlock = (isOpen: boolean, ref: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const body = ref.current?.closest<HTMLElement>('.pf-v6-c-modal-box__body');
    if (!isOpen || !body) return;
    const previous = body.style.overflow;
    body.style.overflow = 'visible';
    return () => {
      body.style.overflow = previous;
    };
  }, [isOpen, ref]);
};
