// The Availability column and its dialog, following
// jgiardino/ai-grid-provider-console@a4e6090 ModelAvailability.tsx: a compact label, the short reason under
// it, and a dialog with the longer explanation (for Unavailable, the backend's reason when it sent
// one: availabilityOf). The state is the backend's (ModelStatus.maas); the dialog also lists MaaS's
// own message for each ingress cluster (ModelStatus.ingress), because MaaS has more pending reasons
// than the design's copy names.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Flex,
  FlexItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  Title,
} from '@patternfly/react-core';
import { PendingIcon } from '@patternfly/react-icons';
import { subtextClassName } from '../../utilities/phaseLabelUtils';
import { statusLabelProps } from '../../utilities/status';
import { EMPTY_VALUE } from '../../utilities/format';
import type { AvailabilityView } from './modelStatusInfo';
import { statusModalLayout } from './statusModalLayout';
import { modelPath } from './modelUtils';
import { titleOf, type ModelView } from './modelView';

type Props = {
  model: Pick<ModelView, 'id' | 'displayName' | 'ingress'>;
  availability: AvailabilityView;
  /**
   * On the model's own page: the dialog leaves out "Go to the model", which would only reload the
   * page behind it.
   */
  onModelPage?: boolean;
};

/** Pending is the subscriptions hourglass in nonstatus purple; the other words use the shared tones. */
const availabilityLabelProps = (label: string) =>
  label === 'Pending' ? { color: 'purple' as const, icon: <PendingIcon /> } : statusLabelProps(label);

const alertVariant = (label: string): 'info' | 'warning' | 'danger' => {
  if (label === 'Unavailable') return 'warning';
  if (label === 'Failed') return 'danger';
  return 'info';
};

/**
 * Availability on the Models list and the model page: a compact label, and the short reason under it.
 * The label and the reason open the dialog when it has more to say; Available doesn't.
 */
export const ModelAvailability: React.FC<Props> = ({ model, availability, onModelPage }) => {
  const [open, setOpen] = useState(false);
  const opens = !!availability.heading && !!availability.body;
  if (open && !opens) {
    setOpen(false);
  }
  return (
    <>
      <div>
        <Label
          {...availabilityLabelProps(availability.label)}
          isCompact
          variant={opens ? 'filled' : 'outline'}
          isClickable={opens}
          onClick={opens ? () => setOpen(true) : undefined}
        >
          {availability.label}
          <span className="pf-v6-screen-reader"> availability of {titleOf(model)}</span>
        </Label>
      </div>
      {/* The reason under the label, in small text and the label's tone, as a subscription's subtext
          (getSubtextProps). One that opens the dialog is an inline link, which PatternFly underlines. */}
      {availability.subtext && (
        <Content component="small" className={opens ? undefined : subtextClassName(availability.label)}>
          {opens ? (
            <Button
              variant="link"
              isInline
              className={subtextClassName(availability.label)}
              onClick={() => setOpen(true)}
            >
              {availability.subtext}
              <span className="pf-v6-screen-reader">: {titleOf(model)}</span>
            </Button>
          ) : (
            availability.subtext
          )}
        </Content>
      )}
      {open && opens && (
        <AvailabilityModal
          model={model}
          availability={availability}
          onModelPage={onModelPage}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};

const AvailabilityModal: React.FC<Props & { onClose: () => void }> = ({
  model,
  availability,
  onModelPage,
  onClose,
}) => {
  const title = titleOf(model);
  const modelsLink = availability.modelsLink && !onModelPage;
  return (
    <Modal {...statusModalLayout} isOpen onClose={onClose} aria-label={`${title} availability`}>
      <ModalHeader>
        <Title headingLevel="h1" size="2xl">
          <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>{title}</FlexItem>
            <FlexItem>
              <Label isCompact {...availabilityLabelProps(availability.label)} variant="filled">
                {availability.label}
              </Label>
            </FlexItem>
          </Flex>
        </Title>
        <p>
          <strong>Availability</strong>
        </p>
      </ModalHeader>
      <ModalBody>
        <Stack hasGutter>
          <Alert isInline isPlain variant={alertVariant(availability.label)} title={availability.heading}>
            {availability.body}
          </Alert>
          {model.ingress.length > 0 && (
            <DescriptionList isCompact aria-label="What MaaS reported">
              {model.ingress.map((ingress) => (
                <DescriptionListGroup key={ingress.cluster}>
                  <DescriptionListTerm>MaaS on {ingress.cluster}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {[ingress.maas, ingress.message].filter(Boolean).join(': ') || EMPTY_VALUE}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ))}
            </DescriptionList>
          )}
        </Stack>
      </ModalBody>
      {(availability.subscriptionsLink || modelsLink) && (
        <ModalFooter>
          <Flex gap={{ default: 'gapMd' }}>
            {availability.subscriptionsLink && (
              <Button variant="link" isInline component={(props) => <Link {...props} to="/subscriptions" />}>
                Go to <strong>Subscriptions</strong>
              </Button>
            )}
            {modelsLink && (
              <Button variant="link" isInline component={(props) => <Link {...props} to={modelPath(model)} />}>
                Go to the model
              </Button>
            )}
          </Flex>
        </ModalFooter>
      )}
    </Modal>
  );
};
