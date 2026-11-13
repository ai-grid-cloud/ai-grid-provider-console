import { Alert, Flex, FlexItem, Label, Popover, Stack } from '@patternfly/react-core';
import { StatusLabel } from '../../components/StatusLabel';
import { statusLabelProps } from '../../utilities/status';
import { hubMessage, unavailableAlert } from './clusterInfo';
import type { ClusterView } from './clusterView';

/**
 * A cluster's status on the Clusters list. When there is something to say, the label is filled and
 * opens a popover laid out as the model status dialog is (ModelStatusModal): the cluster's name and
 * status, "Cluster status" under them, then what the status means. Unavailable says so in a warning
 * alert, without the hub's message, which the cluster's page shows in its status tooltip; any other
 * status shows the hub's message (the ACM state behind Unknown, then the backend's message). Without
 * a message the label stays outline and opens nothing. The popover reads the row's cluster, so a
 * refresh updates it, and it goes away with the message.
 */
export const ClusterStatusLabel: React.FC<{ cluster: ClusterView }> = ({ cluster: c }) => {
  const unavailable = c.status === 'Unavailable';
  const message = hubMessage(c);
  if (!unavailable && !message) {
    return <StatusLabel isCompact status={c.status} />;
  }
  return (
    <Popover
      headerContent={
        <Flex component="span" gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem component="span">{c.name}</FlexItem>{' '}
          <FlexItem component="span">
            <Label isCompact {...statusLabelProps(c.status)} variant="filled">
              {c.status}
            </Label>
          </FlexItem>
        </Flex>
      }
      bodyContent={
        <Stack hasGutter>
          <p>
            <strong>Cluster status</strong>
          </p>
          {unavailable ? (
            <Alert isInline isPlain variant="warning" title={unavailableAlert.title}>
              {unavailableAlert.body}
            </Alert>
          ) : (
            <p>{message}</p>
          )}
        </Stack>
      }
    >
      {/* Filled and a button: the popover opens on its click, as OverflowList's label does. */}
      <StatusLabel isCompact status={c.status} onClick={() => undefined} screenReaderSuffix={` for ${c.name}`} />
    </Popover>
  );
};
