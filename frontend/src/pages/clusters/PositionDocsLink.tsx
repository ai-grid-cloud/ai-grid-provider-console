// How a hub admin sets a cluster's map position. The details page and the location-label help
// share it, with the external-link icon at the end of the label.
import { Button } from '@patternfly/react-core';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import { LOCATION_DOCS_URL } from './site';

/** The docs link. A period that follows it is written at the call site, after this component. */
export const PositionDocsLink: React.FC = () => (
  <Button
    variant="link"
    isInline
    component="a"
    href={LOCATION_DOCS_URL}
    target="_blank"
    rel="noopener noreferrer"
    icon={<ExternalLinkAltIcon />}
    iconPosition="end"
  >
    How to set a cluster&apos;s position
  </Button>
);
