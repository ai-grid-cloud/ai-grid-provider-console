import type { ModalProps } from '@patternfly/react-core';

/**
 * Every status dialog uses this size and place: medium, centered on the page, attached to the
 * document. A cluster's dialog opened from the model's dialog then covers the same rectangle.
 */
export const statusModalLayout = {
  variant: 'medium',
  position: 'default',
  appendTo: () => document.body,
} satisfies Pick<ModalProps, 'variant' | 'position' | 'appendTo'>;
