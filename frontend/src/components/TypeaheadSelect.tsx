// A single-value PatternFly typeahead select (PatternFly 6 "Select > Typeahead" example), so a
// form's one-of-many pickers draw the same menu as MultiSelection instead of the browser's.
import { useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type Ref } from 'react';
import {
  MenuToggle,
  type MenuToggleElement,
  Select,
  SelectList,
  SelectOption,
  TextInputGroup,
  TextInputGroupMain,
} from '@patternfly/react-core';
import { resolveSelectPopperAppendTo, useModalOverflowUnlock } from './selectPopper';

export type TypeaheadSelectOption = {
  value: string;
  label: string;
  description?: string;
};

type Props = {
  /** The input's id, so a FormGroup or <label> can point at it. */
  id: string;
  value: string;
  options: TypeaheadSelectOption[];
  onChange: (value: string) => void;
  /** Focus left the field (not into its own menu or toggle), as a text input's blur. */
  onBlur?: () => void;
  placeholder?: string;
  /** Required: PatternFly's input otherwise announces itself as "Type to filter", over any <label>. */
  'aria-label': string;
  /** The id of the field's helper text, read with the field. */
  'aria-describedby'?: string;
  /** 'danger' marks the field invalid, for the eye and for assistive technology. */
  status?: 'danger';
  'data-testid'?: string;
};

export const TypeaheadSelect = ({
  id,
  value,
  options,
  onChange,
  onBlur,
  placeholder,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  status,
  'data-testid': testId,
}: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  // What the user has typed since the menu opened; null shows the selected option's label.
  const [filter, setFilter] = useState<string | null>(null);
  // The highlighted option, by value, so a list that changes under it can't leave a stale highlight.
  const [focusedValue, setFocusedValue] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const instanceId = useId().replace(/:/g, '');
  const listboxId = `${id}-listbox`;
  const optionId = (index: number) => `${instanceId}-option-${index}`;

  useModalOverflowUnlock(isOpen, inputRef);

  const selected = options.find((o) => o.value === value);
  const visible = useMemo(() => {
    const text = filter?.trim().toLowerCase();
    return text ? options.filter((o) => o.label.toLowerCase().includes(text)) : options;
  }, [filter, options]);
  const focusedIndex = visible.findIndex((o) => o.value === focusedValue);

  // Every way of closing goes through here, so typed text never stays on a closed field.
  const close = () => {
    setIsOpen(false);
    setFilter(null);
    setFocusedValue(null);
  };
  const toggleMenu = () => (isOpen ? close() : setIsOpen(true));

  // Clicking an option or the toggle button moves focus there for a moment; that isn't leaving
  // the field, so it doesn't mark it touched before the choice lands.
  const onInputBlur = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget as Node | null;
    const ownToggle = event.currentTarget.closest('.pf-v6-c-menu-toggle');
    if (next && (ownToggle?.contains(next) || document.getElementById(listboxId)?.contains(next))) return;
    onBlur?.();
  };

  const choose = (next: string) => {
    onChange(next);
    close();
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        setIsOpen(true);
        if (visible.length === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next =
          focusedIndex < 0
            ? step > 0
              ? 0
              : visible.length - 1
            : (focusedIndex + step + visible.length) % visible.length;
        setFocusedValue(visible[next].value);
        return;
      }
      case 'Enter':
        event.preventDefault();
        if (isOpen && focusedIndex >= 0) {
          choose(visible[focusedIndex].value);
        } else {
          toggleMenu();
        }
        return;
      // Tab keeps its default, moving focus on; Select only closes on Escape (see onOpenChangeKeys).
      case 'Tab':
      case 'Escape':
        close();
        return;
    }
  };

  const toggle = (toggleRef: Ref<MenuToggleElement>) => (
    <MenuToggle
      ref={toggleRef}
      variant="typeahead"
      // Names the menu's open button after the field, not PatternFly's "Menu toggle".
      aria-label={`${ariaLabel} options`}
      isFullWidth
      isExpanded={isOpen}
      status={status}
      onClick={() => {
        toggleMenu();
        inputRef.current?.focus();
      }}
    >
      <TextInputGroup isPlain>
        <TextInputGroupMain
          inputId={id}
          inputProps={{
            autoComplete: 'off',
            'aria-invalid': status === 'danger',
            ...(testId && { 'data-testid': testId }),
            ...(ariaDescribedBy && { 'aria-describedby': ariaDescribedBy }),
          }}
          ref={inputRef}
          value={filter ?? selected?.label ?? ''}
          placeholder={placeholder}
          aria-label={ariaLabel}
          role="combobox"
          isExpanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={isOpen && focusedIndex >= 0 ? optionId(focusedIndex) : undefined}
          onClick={toggleMenu}
          onChange={(_event, text) => {
            setFilter(text);
            setFocusedValue(null);
            setIsOpen(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={onInputBlur}
        />
      </TextInputGroup>
    </MenuToggle>
  );

  return (
    <Select
      id={`${id}-select`}
      isOpen={isOpen}
      selected={value}
      onSelect={(_event, next) => {
        if (typeof next === 'string') choose(next);
      }}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      // PatternFly's default also takes Tab, prevents it and refocuses the toggle, which here is the
      // input itself, so focus would stay put; onKeyDown closes on Tab and lets focus move instead.
      onOpenChangeKeys={['Escape']}
      toggle={toggle}
      variant="typeahead"
      isScrollable
      popperProps={{ appendTo: () => resolveSelectPopperAppendTo(inputRef.current) }}
    >
      <SelectList id={listboxId} aria-label={ariaLabel}>
        {visible.length === 0 ? (
          <SelectOption isDisabled>No results found</SelectOption>
        ) : (
          visible.map((o, index) => (
            <SelectOption
              key={o.value}
              id={optionId(index)}
              value={o.value}
              description={o.description}
              isFocused={focusedIndex === index}
            >
              {o.label}
            </SelectOption>
          ))
        )}
      </SelectList>
    </Select>
  );
};
