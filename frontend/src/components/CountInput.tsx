import { NumberInput } from '@patternfly/react-core';

type Props = {
  id: string;
  /** The accessible name, the same as the field's label. */
  label: string;
  /** The text the user typed, so an empty or partial entry can show its error. */
  value: string;
  min: number;
  max: number;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** The id of the field's helper text, read with the field. */
  describedBy?: string;
  validated?: 'error' | 'default';
  isDisabled?: boolean;
};

/** Accepts only digits, so what the field shows is what the form validates and sends. */
const WHOLE_NUMBER = /^\d*$/;

/** A whole-number field with − and + buttons, kept short (PatternFly's number input). */
export const CountInput: React.FC<Props> = ({
  id,
  label,
  value,
  min,
  max,
  onChange,
  onBlur,
  describedBy,
  validated,
  isDisabled,
}) => {
  const current = Number.parseInt(value, 10);
  const step = (delta: number) =>
    onChange(String(Math.min(max, Math.max(min, (Number.isNaN(current) ? min : current) + delta))));
  return (
    <NumberInput
      // The id goes on the <input> itself, so the FormGroup's label and the helper text attach to it.
      inputProps={{ id, 'aria-describedby': describedBy }}
      inputName={id}
      inputAriaLabel={label}
      minusBtnAriaLabel={`Decrease ${label.toLowerCase()}`}
      plusBtnAriaLabel={`Increase ${label.toLowerCase()}`}
      value={value === '' ? '' : current}
      min={min}
      max={max}
      widthChars={4}
      validated={validated}
      isDisabled={isDisabled}
      onMinus={() => step(-1)}
      onPlus={() => step(1)}
      onChange={(event: React.FormEvent<HTMLInputElement>) => {
        // On blur NumberInput rewrites the input to Number(text), turning an empty field into 0.
        // Put back what the user left, so an emptied field stays empty and says "Required".
        if (event.type === 'blur') {
          event.currentTarget.value = value;
          return;
        }
        // Anything but digits (1e1, 1.5, -2) is refused rather than shown as one number and sent as another.
        const text = event.currentTarget.value.trim();
        if (WHOLE_NUMBER.test(text)) {
          onChange(text === '' ? '' : String(Number(text)));
        }
      }}
      onBlur={onBlur}
    />
  );
};
