import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TypeaheadSelect } from '../components/TypeaheadSelect';

const OPTIONS = [
  { value: 'a', label: 'acme-robotics' },
  { value: 'g', label: 'globex-research' },
  { value: 'i', label: 'initech' },
];

const Harness = ({
  onBlur,
  onChange = () => undefined,
  options = OPTIONS,
  initial = '',
}: {
  onBlur?: () => void;
  onChange?: (value: string) => void;
  options?: typeof OPTIONS;
  initial?: string;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <TypeaheadSelect
      id="org"
      aria-label="Organization"
      placeholder="Select an organization"
      value={value}
      options={options}
      onBlur={onBlur}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
};

it('draws a PatternFly menu, filters as you type and picks with the keyboard', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<Harness onChange={onChange} />);
  const input = screen.getByRole('combobox', { name: 'Organization' });
  expect(input).toHaveAttribute('placeholder', 'Select an organization');
  expect(input).toHaveAttribute('autocomplete', 'off');

  await user.click(input);
  expect(screen.getAllByRole('option')).toHaveLength(3);
  await user.type(input, 'GLO');
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['globex-research']);
  await user.keyboard('{ArrowDown}{Enter}');
  expect(onChange).toHaveBeenLastCalledWith('g');
  expect(input).toHaveValue('globex-research');
  expect(input).toHaveAttribute('aria-expanded', 'false');

  // Typing and then leaving with Escape keeps the selection's label.
  await user.type(input, 'zz');
  expect(screen.getByRole('option', { name: 'No results found' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(input).toHaveValue('globex-research');
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('shows the selection again when closed by a click, without choosing', async () => {
  const user = userEvent.setup();
  render(<Harness initial="g" />);
  const input = screen.getByRole('combobox', { name: 'Organization' });
  await user.click(input);
  await user.type(input, 'ini');
  await user.click(input);
  expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(input).toHaveValue('globex-research');
  await user.click(screen.getByRole('button', { expanded: false }));
  expect(screen.getAllByRole('option')).toHaveLength(3);
});

it('closes on Tab and lets focus move to the next control', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Harness initial="a" />
      <button type="button">Next field</button>
    </>,
  );
  const input = screen.getByRole('combobox', { name: 'Organization' });
  await user.click(input);
  await user.type(input, 'glo');
  await user.tab();
  expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(input).toHaveValue('acme-robotics');
  // One Tab: PatternFly's toggle button has tabIndex -1, so the next field is next.
  expect(screen.getByRole('button', { name: 'Next field' })).toHaveFocus();
});

it('drops the highlight when the highlighted option goes away', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(<Harness onChange={onChange} />);
  const input = screen.getByRole('combobox', { name: 'Organization' });
  await user.click(input);
  await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
  expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'initech' }).id);
  rerender(<Harness onChange={onChange} options={OPTIONS.slice(0, 1)} />);
  expect(input).not.toHaveAttribute('aria-activedescendant');
  await user.keyboard('{ArrowDown}{Enter}');
  expect(onChange).toHaveBeenLastCalledWith('a');
});

it('calls onBlur when focus leaves the field, not when an option is clicked', async () => {
  const onBlur = vi.fn();
  const user = userEvent.setup();
  render(
    <>
      <Harness onBlur={onBlur} />
      <button type="button">Next field</button>
    </>,
  );
  const input = screen.getByRole('combobox', { name: 'Organization' });
  await user.click(input);
  await user.click(screen.getByRole('option', { name: 'initech' }));
  expect(input).toHaveValue('initech');
  expect(onBlur).not.toHaveBeenCalled();
  await user.tab();
  expect(onBlur).toHaveBeenCalledTimes(1);
});

it('calls onBlur when focus leaves after opening the menu with the toggle button', async () => {
  const onBlur = vi.fn();
  const user = userEvent.setup();
  render(
    <>
      <Harness onBlur={onBlur} />
      <button type="button">Next field</button>
    </>,
  );
  // The toggle hands focus back to the input, so leaving from there still counts as leaving the field.
  await user.click(screen.getByRole('button', { name: 'Organization options' }));
  expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveFocus();
  expect(onBlur).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Next field' }));
  expect(onBlur).toHaveBeenCalledTimes(1);
});
