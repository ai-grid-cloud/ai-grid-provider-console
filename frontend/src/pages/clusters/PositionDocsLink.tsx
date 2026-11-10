// How a hub admin sets a cluster's map position. The details page and the location-label helper
// share it, with the external-link icon at the end of the label.
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import { LOCATION_DOCS_URL } from './site';

/** `trailing` is punctuation that follows the icon, with no space before it. */
export const PositionDocsLink: React.FC<{ trailing?: string }> = ({ trailing }) => {
  const link = (
    <a key="position-docs" className="pf-v6-u-text-nowrap" href={LOCATION_DOCS_URL} target="_blank" rel="noreferrer">
      How to set a cluster&apos;s position <ExternalLinkAltIcon />
    </a>
  );
  return trailing ? [link, trailing] : link;
};
