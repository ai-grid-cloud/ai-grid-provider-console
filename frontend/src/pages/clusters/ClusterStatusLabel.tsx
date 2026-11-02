import { useState } from 'react';
import { Flex, FlexItem, Label, Modal, ModalBody, ModalHeader, Title } from '@patternfly/react-core';
import type { CSSProperties } from 'react';
import { StatusLabel } from '../../components/StatusLabel';
import { statusLabelProps } from '../../utilities/status';
import { statusModalLayout } from '../models/statusModalLayout';

type Props = {
  /** The cluster name, shown as the dialog title. */
  name: string;
  status: string;
  /**
   * The ACM state and the hub's message, when the status word is not the whole story.
   * The label opens a dialog with this text. A tooltip would hide it from the keyboard.
   */
  detail?: string;
};

/** A cluster's connection status. Extra text opens a dialog; the word alone stays an outline label. */
export const ClusterStatusLabel: React.FC<Props> = ({ name, status, detail }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <StatusLabel isCompact status={status} onClick={detail ? () => setOpen(true) : undefined} />
      {open && detail && (
        <Modal
          {...statusModalLayout}
          isOpen
          onClose={() => setOpen(false)}
          aria-label={`${name} cluster status`}
          data-testid="cluster-status-modal"
        >
          <ModalHeader
            style={{ '--pf-v6-c-modal-box__header--Gap': 'var(--pf-t--global--spacer--sm)' } as CSSProperties}
          >
            <Title headingLevel="h1" size="2xl">
              <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                <FlexItem>{name}</FlexItem>
                <FlexItem>
                  <Label isCompact {...statusLabelProps(status)} variant="filled">
                    {status}
                  </Label>
                </FlexItem>
              </Flex>
            </Title>
            <p>
              <strong>Cluster status</strong>
            </p>
          </ModalHeader>
          <ModalBody>
            <p>{detail}</p>
          </ModalBody>
        </Modal>
      )}
    </>
  );
};
