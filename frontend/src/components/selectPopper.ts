// Ported from krisv/ai-grid-cloud-provider-poc src/shared/utilities/select.ts at 62319b8.
import { useEffect, type RefObject } from 'react';

/**
 * A select menu is exactly as wide as its toggle. PatternFly's menu width is `auto` and only
 * its minimum tracks the toggle, so a long option description widens the menu; matching the
 * toggle makes that description wrap.
 */
export const selectMenuWidth = { width: 'trigger', maxWidth: 'trigger' } as const;

/**
 * Where a select's menu attaches: the enclosing modal, so it stays inside the dialog's focus
 * trap, else the document body.
 */
export const resolveSelectPopperAppendTo = (element: HTMLElement | null): HTMLElement =>
  element?.closest<HTMLElement>('.pf-v6-c-modal-box') ?? document.body;

/**
 * Lets an open select menu paint past the dialog. The menu is portaled onto the modal box, and
 * the box scrolls (`overflow: auto`), so a menu that runs past the space left scrolls the dialog
 * instead of drawing outside it. The body's own scroll is left alone.
 */
export const useModalOverflowUnlock = (isOpen: boolean, ref: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    if (!isOpen) return;
    const box = ref.current?.closest<HTMLElement>('.pf-v6-c-modal-box');
    if (!box) return;
    const previous = box.style.overflow;
    box.style.overflow = 'visible';
    return () => {
      box.style.overflow = previous;
    };
  }, [isOpen, ref]);
};
