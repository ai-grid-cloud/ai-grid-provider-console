// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/createSubscription/RateLimitRow.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/createSubscription/RateLimitRow.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useState } from 'react';
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownList,
  FormHelperText,
  HelperText,
  HelperTextItem,
  MenuToggle,
  NumberInput,
  Split,
  SplitItem,
  Stack,
  StackItem,
  ValidatedOptions,
} from '@patternfly/react-core';
import { MinusCircleIcon } from '@patternfly/react-icons';
import type { RateLimit } from '../../../utilities/rateLimits';
import { UNIT_OPTIONS } from '../../../utilities/rateLimits';

type Props = {
  id: string;
  rateLimit: RateLimit;
  onChange: (rateLimit: RateLimit) => void;
  onRemove?: () => void;
  showRemove: boolean;
  countError?: string;
  timeError?: string;
  countDigitError?: string;
  timeDigitError?: string;
};

const COUNT_STEP = 1000;

/** Parses a number input: empty is NaN (required), anything unparsable keeps the old value. */
const parsed = (value: string, previous: number): number => {
  if (value === '') return NaN;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? previous : Math.min(Number.MAX_SAFE_INTEGER, n);
};

/** One token limit: count, "tokens per", time and unit. */
export const RateLimitRow: React.FC<Props> = ({
  id,
  rateLimit,
  onChange,
  onRemove,
  showRemove,
  countError,
  timeError,
  countDigitError,
  timeDigitError,
}) => {
  const [unitDropdownOpen, setUnitDropdownOpen] = useState(false);
  const selectedUnitLabel = UNIT_OPTIONS.find((opt) => opt.value === rateLimit.unit)?.label ?? rateLimit.unit;
  const countMessage = countDigitError ?? countError;
  const timeMessage = timeDigitError ?? timeError;

  return (
    <Stack hasGutter>
      <StackItem>
        <Split hasGutter>
          <SplitItem>
            <NumberInput
              validated={countMessage != null ? ValidatedOptions.error : ValidatedOptions.default}
              id={`${id}-count`}
              data-testid={`${id}-count`}
              inputAriaLabel="Token count"
              value={Number.isNaN(rateLimit.count) ? '' : rateLimit.count}
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              onMinus={() =>
                onChange({ ...rateLimit, count: Math.max(1, (rateLimit.count || COUNT_STEP) - COUNT_STEP) })
              }
              onPlus={() =>
                onChange({
                  ...rateLimit,
                  count: Math.min(Number.MAX_SAFE_INTEGER, (rateLimit.count || 0) + COUNT_STEP),
                })
              }
              onChange={(event: React.FormEvent<HTMLInputElement>) =>
                onChange({ ...rateLimit, count: parsed(event.currentTarget.value, rateLimit.count) })
              }
            />
          </SplitItem>
          <SplitItem style={{ alignSelf: 'center' }}>tokens per</SplitItem>
          <SplitItem>
            <NumberInput
              validated={timeMessage != null ? ValidatedOptions.error : ValidatedOptions.default}
              id={`${id}-time`}
              data-testid={`${id}-time`}
              inputAriaLabel="Time value"
              value={Number.isNaN(rateLimit.time) ? '' : rateLimit.time}
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              onMinus={() => onChange({ ...rateLimit, time: Math.max(1, (rateLimit.time || 1) - 1) })}
              onPlus={() =>
                onChange({ ...rateLimit, time: Math.min(Number.MAX_SAFE_INTEGER, (rateLimit.time || 0) + 1) })
              }
              onChange={(event: React.FormEvent<HTMLInputElement>) =>
                onChange({ ...rateLimit, time: parsed(event.currentTarget.value, rateLimit.time) })
              }
            />
          </SplitItem>
          <SplitItem>
            <Dropdown
              isOpen={unitDropdownOpen}
              onOpenChange={setUnitDropdownOpen}
              toggle={(toggleRef) => (
                <MenuToggle
                  ref={toggleRef}
                  onClick={() => setUnitDropdownOpen(!unitDropdownOpen)}
                  isExpanded={unitDropdownOpen}
                  data-testid={`${id}-unit`}
                  style={{ minWidth: 100 }}
                >
                  {selectedUnitLabel}
                </MenuToggle>
              )}
            >
              <DropdownList>
                {UNIT_OPTIONS.map((option) => (
                  <DropdownItem
                    key={option.value}
                    onClick={() => {
                      onChange({ ...rateLimit, unit: option.value });
                      setUnitDropdownOpen(false);
                    }}
                  >
                    {option.label}
                  </DropdownItem>
                ))}
              </DropdownList>
            </Dropdown>
          </SplitItem>
          {showRemove && (
            <SplitItem>
              <Button variant="plain" aria-label="Remove rate limit" onClick={onRemove} data-testid={`${id}-remove`}>
                <MinusCircleIcon />
              </Button>
            </SplitItem>
          )}
        </Split>
      </StackItem>
      <StackItem>
        <FormHelperText data-testid={`${id}-helper-text`}>
          <HelperText>
            {countMessage != null && <HelperTextItem variant="error">{countMessage}</HelperTextItem>}
            {timeMessage != null && <HelperTextItem variant="error">{timeMessage}</HelperTextItem>}
          </HelperText>
        </FormHelperText>
      </StackItem>
    </Stack>
  );
};
