// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/MaasModelsSection.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/MaasModelsSection.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Only the subscription uses are ported, so the PoC's customization props are dropped.
import { Fragment, useState } from 'react';
import {
  Bullseye,
  Button,
  Content,
  Divider,
  Dropdown,
  DropdownItem,
  DropdownList,
  Flex,
  FlexItem,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  MenuToggle,
  Stack,
  StackItem,
  Title,
} from '@patternfly/react-core';
import { EllipsisVIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { MaaSModelRefSummary, ModelSubscriptionRef } from '../api/types';
import { formatTokenLimits } from '../pages/subscriptions/viewSubscription/utils';
import { isSameModel, modelKey } from '../utilities/authpolicies';
import { TableRowTitleDescription } from './TableRowTitleDescription';

type Props = {
  modelRefSummaries: MaaSModelRefSummary[];
  modelRefsWithRateLimits?: ModelSubscriptionRef[];
  /** A form field with add, edit-limits and remove actions, instead of a read-only section. */
  editable?: boolean;
  onAddModels?: () => void;
  onEditLimits?: (index: number) => void;
  onRemoveModel?: (index: number) => void;
  validationError?: string;
};

/** A subscription's models and their token limits. */
export const MaasModelsSection: React.FC<Props> = ({
  modelRefSummaries,
  modelRefsWithRateLimits = [],
  editable = false,
  onAddModels,
  onEditLimits,
  onRemoveModel,
  validationError,
}) => {
  const [openKebabIndex, setOpenKebabIndex] = useState<number | null>(null);
  const isUnlimited = (model: MaaSModelRefSummary) =>
    !!modelRefsWithRateLimits.find((ref) => isSameModel(ref, model))?.unlimited;

  const table = modelRefSummaries.length > 0 && (
    <Table aria-label="subscription models" variant="compact" data-testid="subscription-models-table">
      <Thead>
        <Tr>
          <Th width={50}>Name</Th>
          <Th width={25}>Token limits</Th>
          {editable && <Th screenReaderText="Actions" />}
        </Tr>
      </Thead>
      <Tbody>
        {modelRefSummaries.map((modelRef, index) => {
          const tokenLimitsLines = formatTokenLimits(modelRefsWithRateLimits, modelRef);
          const tokenLimitsDisplay = tokenLimitsLines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {line}
            </Fragment>
          ));
          let tokenLimits: React.ReactNode = tokenLimitsDisplay;
          if (isUnlimited(modelRef)) {
            tokenLimits = 'Unlimited';
          } else if (editable && onEditLimits) {
            tokenLimits =
              tokenLimitsLines.length > 0 ? (
                <Button variant="link" isInline onClick={() => onEditLimits(index)}>
                  {tokenLimitsDisplay}
                </Button>
              ) : (
                <Stack style={{ gap: 'var(--pf-t--global--spacer--sm)' }}>
                  <StackItem>
                    <Button
                      variant="link"
                      isInline
                      icon={<PlusCircleIcon />}
                      onClick={() => onEditLimits(index)}
                      data-testid={`add-token-limit-${index}`}
                    >
                      Add token limit
                    </Button>
                  </StackItem>
                  <StackItem>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem variant="error" data-testid={`token-limit-required-error-${index}`}>
                          At least one token limit is required
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </StackItem>
                </Stack>
              );
          }

          return (
            <Tr key={modelKey(modelRef)}>
              <Td dataLabel="Name">
                <TableRowTitleDescription
                  title={<strong>{modelRef.displayName ?? modelRef.name}</strong>}
                  subtitle={<code>{modelRef.name}</code>}
                  description={modelRef.description}
                  truncateDescriptionLines={2}
                />
              </Td>
              <Td dataLabel="Token limits">{tokenLimits}</Td>
              {editable && (
                <Td isActionCell>
                  <Dropdown
                    isOpen={openKebabIndex === index}
                    onOpenChange={(open) => setOpenKebabIndex(open ? index : null)}
                    toggle={(toggleRef) => (
                      <MenuToggle
                        ref={toggleRef}
                        variant="plain"
                        onClick={() => setOpenKebabIndex(openKebabIndex === index ? null : index)}
                        isExpanded={openKebabIndex === index}
                        aria-label={`Actions for ${modelRef.name}`}
                      >
                        <EllipsisVIcon />
                      </MenuToggle>
                    )}
                    popperProps={{ position: 'right' }}
                  >
                    <DropdownList>
                      {onEditLimits && (
                        <DropdownItem
                          key="edit-token-limits"
                          isDisabled={isUnlimited(modelRef)}
                          onClick={() => {
                            onEditLimits(index);
                            setOpenKebabIndex(null);
                          }}
                        >
                          Edit token limits
                        </DropdownItem>
                      )}
                      {onRemoveModel && <Divider component="li" />}
                      <DropdownItem
                        key="remove"
                        isDanger
                        onClick={() => {
                          onRemoveModel?.(index);
                          setOpenKebabIndex(null);
                        }}
                      >
                        Remove
                      </DropdownItem>
                    </DropdownList>
                  </Dropdown>
                </Td>
              )}
            </Tr>
          );
        })}
      </Tbody>
    </Table>
  );

  if (editable) {
    return (
      <FormGroup label="Models" fieldId="subscription-models" isRequired data-testid="subscription-models-section">
        <Stack hasGutter>
          <StackItem>
            <Content>
              Select models to make available to members of this subscription, then set token limits for each one.
            </Content>
          </StackItem>
          {validationError && (
            <StackItem>
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant="error">{validationError}</HelperTextItem>
                </HelperText>
              </FormHelperText>
            </StackItem>
          )}
          {table && <StackItem>{table}</StackItem>}
          <StackItem>
            <Button variant="link" icon={<PlusCircleIcon />} onClick={onAddModels} data-testid="add-models-button">
              Add models
            </Button>
          </StackItem>
        </Stack>
      </FormGroup>
    );
  }

  return (
    <Stack hasGutter data-testid="subscription-models-section">
      <StackItem>
        <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsSm' }}>
          <FlexItem>
            <Title headingLevel="h2" size="xl">
              Models
            </Title>
          </FlexItem>
          <FlexItem>
            <Content component="p">Models available to members of this subscription.</Content>
          </FlexItem>
        </Flex>
      </StackItem>
      <StackItem>
        {modelRefSummaries.length === 0 ? (
          <Bullseye>
            <Content component="p">No models assigned to this subscription.</Content>
          </Bullseye>
        ) : (
          table
        )}
      </StackItem>
    </Stack>
  );
};
