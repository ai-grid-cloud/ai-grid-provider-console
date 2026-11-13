import { ClipboardCopy } from '@patternfly/react-core';

/** A runtime image the hardware names: the name, with the image below it to copy. */
export const RuntimeImageValue: React.FC<{ name: string; image: string }> = ({ name, image }) => (
  <>
    {name}
    <br />
    <ClipboardCopy variant="inline-compact" copyAriaLabel="Copy the runtime image">
      {image}
    </ClipboardCopy>
  </>
);
