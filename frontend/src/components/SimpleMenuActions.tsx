// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/SimpleMenuActions.tsx at 62319b8.
import { useState } from 'react';
import { Divider, Dropdown, DropdownItem, DropdownList, MenuToggle } from '@patternfly/react-core';
import { EllipsisVIcon } from '@patternfly/react-icons';

type Item = {
  key?: string;
  label?: string;
  isSpacer?: boolean;
  isDisabled?: boolean;
  /** Why the item can't be used now: it stays focusable, disabled, with this in a tooltip. */
  disabledReason?: string;
  /** A destructive action (Delete): danger styled. Put it last, after a spacer. */
  isDanger?: boolean;
  onClick?: () => void;
};

type Props = {
  testId?: string;
  ariaLabel: string;
  dropdownItems: Item[];
  /** A labeled toggle ("Actions") for a page's header; without it, a kebab for a table row. */
  toggleLabel?: string;
};

/**
 * An actions menu: a kebab for a table row, or a labeled toggle for a page header (PatternFly:
 * name the menu after its actions, or "Actions"). Destructive items are danger styled.
 */
export const SimpleMenuActions: React.FC<Props> = ({ testId, ariaLabel, dropdownItems, toggleLabel }) => {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      isOpen={open}
      onOpenChange={setOpen}
      // An item often opens a dialog and then disappears with the closed menu; focusing the toggle
      // first gives the dialog somewhere to return focus to when it closes, instead of <body>.
      shouldFocusToggleOnSelect
      popperProps={{ position: 'right' }}
      toggle={(ref) => (
        <MenuToggle
          ref={ref}
          aria-label={ariaLabel}
          data-testid={testId}
          variant={toggleLabel ? 'secondary' : 'plain'}
          isExpanded={open}
          onClick={() => setOpen(!open)}
        >
          {toggleLabel ?? <EllipsisVIcon />}
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
              isAriaDisabled={!!item.disabledReason}
              tooltipProps={item.disabledReason ? { content: item.disabledReason } : undefined}
              isDanger={item.isDanger}
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
