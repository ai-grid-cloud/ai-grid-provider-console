// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/SimpleMenuActions.tsx at 62319b8.
import { useState } from 'react';
import { Divider, Dropdown, DropdownItem, DropdownList, MenuToggle } from '@patternfly/react-core';
import { EllipsisVIcon } from '@patternfly/react-icons';

type Item = { key?: string; label?: string; isSpacer?: boolean; isDisabled?: boolean; onClick?: () => void };

type Props = { testId?: string; ariaLabel: string; dropdownItems: Item[] };

/** A kebab menu of row actions. */
export const SimpleMenuActions: React.FC<Props> = ({ testId, ariaLabel, dropdownItems }) => {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      isOpen={open}
      onOpenChange={setOpen}
      popperProps={{ position: 'right' }}
      toggle={(ref) => (
        <MenuToggle
          ref={ref}
          aria-label={ariaLabel}
          data-testid={testId}
          variant="plain"
          isExpanded={open}
          onClick={() => setOpen(!open)}
        >
          <EllipsisVIcon />
        </MenuToggle>
      )}
    >
      <DropdownList>
        {dropdownItems.map((item, index) =>
          item.isSpacer ? (
            <Divider key={index} component="li" />
          ) : (
            <DropdownItem
              key={item.key}
              isDisabled={item.isDisabled}
              onClick={() => {
                setOpen(false);
                item.onClick?.();
              }}
            >
              {item.label}
            </DropdownItem>
          ),
        )}
      </DropdownList>
    </Dropdown>
  );
};
