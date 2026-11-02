import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Flex,
  FlexItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Title,
} from '@patternfly/react-core';
import { PendingIcon } from '@patternfly/react-icons';
import { statusLabelProps } from '../../utilities/status';
import type { AvailabilityView } from './modelStatusInfo';
import { statusModalLayout } from './statusModalLayout';
import { modelPath } from './modelUtils';
import { titleOf, type ModelView } from './modelView';

type Props = {
  model: ModelView;
  availability: AvailabilityView;
};

/** Pending is the subscriptions hourglass in nonstatus purple. The other words use the shared tones. */
const availabilityLabelProps = (label: string) =>
  label === 'Pending' ? { color: 'purple' as const, icon: <PendingIcon /> } : statusLabelProps(label);

/**
 * The reason under the label. Pending uses the info text color, as the phase label does.
 * The status-color utility loses to Content's own color, so the token is set directly.
 */
const alertVariant = (label: string): 'info' | 'warning' | 'danger' => {
  if (label === 'Unavailable') return 'warning';
  if (label === 'Failed' || label === 'Invalid') return 'danger';
  return 'info';
};

const subtextTone = (label: string): 'info' | 'warning' | 'danger' | undefined => {
  if (label === 'Pending') return 'info';
  if (label === 'Unavailable') return 'warning';
  if (label === 'Failed' || label === 'Invalid') return 'danger';
  return undefined;
};

const subtextStyle = (label: string): CSSProperties => {
  const tone = subtextTone(label);
  return {
    textDecoration: 'underline dotted',
    ...(tone ? { color: `var(--pf-t--global--text--color--status--${tone}--default)` } : {}),
  };
};

/**
 * Availability on the Models list: a compact label, and the short reason under it when the MaaS
 * model ref has one. The label opens when that reason has a longer explanation. Available does not.
 */
export const ModelAvailability: React.FC<Props> = ({ model, availability }) => {
  const [open, setOpen] = useState(false);
  const opens = !!availability.heading && !!availability.body;
  return (
    <>
      <div>
        <Label
          {...availabilityLabelProps(availability.label)}
          isCompact
          variant={opens ? 'filled' : 'outline'}
          isClickable={opens}
          onClick={opens ? () => setOpen(true) : undefined}
          data-testid="model-availability-label"
        >
          {availability.label}
        </Label>
      </div>
      {availability.subtext && (
        <Button
          variant="link"
          isInline
          className="pf-v6-c-content--small"
          style={subtextStyle(availability.label)}
          onClick={opens ? () => setOpen(true) : undefined}
          data-testid="model-availability-subtext"
        >
          {availability.subtext}
        </Button>
      )}
      {open && opens && <AvailabilityModal model={model} availability={availability} onClose={() => setOpen(false)} />}
    </>
  );
};

const AvailabilityModal: React.FC<{ model: ModelView; availability: AvailabilityView; onClose: () => void }> = ({
  model,
  availability,
  onClose,
}) => {
  const title = titleOf(model);
  return (
    <Modal
      {...statusModalLayout}
      isOpen
      onClose={onClose}
      data-testid="model-availability-modal"
      aria-label={`${title} availability`}
    >
      <ModalHeader
        data-testid="model-availability-modal-header"
        style={{ '--pf-v6-c-modal-box__header--Gap': 'var(--pf-t--global--spacer--sm)' } as CSSProperties}
      >
        <Title headingLevel="h1" size="2xl" data-testid="model-availability-modal-title">
          <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>{title}</FlexItem>
            <FlexItem>
              <Label isCompact {...availabilityLabelProps(availability.label)} variant="filled">
                {availability.label}
              </Label>
            </FlexItem>
          </Flex>
        </Title>
        <p data-testid="model-availability-modal-subtitle">
          <strong>Availability</strong>
        </p>
      </ModalHeader>
      <ModalBody>
        <Alert isInline isPlain variant={alertVariant(availability.label)} title={availability.heading}>
          {availability.body}
        </Alert>
      </ModalBody>
      {(availability.subscriptionsLink || availability.modelsLink) && (
        <ModalFooter>
          <Flex gap={{ default: 'gapMd' }}>
            {availability.subscriptionsLink && (
              <Button variant="link" isInline component={(props) => <Link {...props} to="/subscriptions" />}>
                Go to <strong>Subscriptions</strong>
              </Button>
            )}
            {availability.modelsLink && (
              <Button variant="link" isInline component={(props) => <Link {...props} to={modelPath(model)} />}>
                Go to <strong>Models</strong>
              </Button>
            )}
          </Flex>
        </ModalFooter>
      )}
    </Modal>
  );
};
