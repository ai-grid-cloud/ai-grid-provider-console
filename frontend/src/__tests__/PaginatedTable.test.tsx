import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PaginatedTable } from '../components/PaginatedTable';

const items = Array.from({ length: 25 }, (_, i) => `item-${i + 1}`);

/** A list with a filter, like the console's list pages. */
const List: React.FC = () => {
  const [filter, setFilter] = useState('');
  const rows = items.filter((item) => item.includes(filter));
  return (
    <>
      <input aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <PaginatedTable rows={rows}>
        {(pageRows) => (
          <ul aria-label="Rows">
            {pageRows.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        )}
      </PaginatedTable>
    </>
  );
};

const shown = () =>
  within(screen.getByRole('list', { name: 'Rows' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

it('shows 10 rows per page with pagination above and below', () => {
  render(<List />);
  expect(shown()).toEqual(items.slice(0, 10));
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(2);
  expect(screen.getAllByText('1 - 10').length).toBeGreaterThan(0);
});

it('moves to the next page', async () => {
  const user = userEvent.setup();
  render(<List />);
  await user.click(screen.getAllByRole('button', { name: 'Go to next page' })[0]);
  expect(shown()).toEqual(items.slice(10, 20));
});

it('changes the number of rows per page', async () => {
  const user = userEvent.setup();
  render(<List />);
  await user.click(screen.getAllByRole('button', { name: /1 - 10 of/ })[0]);
  await user.click(screen.getByRole('menuitem', { name: '20 per page' }));
  expect(shown()).toEqual(items.slice(0, 20));
});

it('clamps the page when filtering leaves fewer pages', async () => {
  const user = userEvent.setup();
  render(<List />);
  await user.click(screen.getAllByRole('button', { name: 'Go to last page' })[0]);
  expect(shown()).toEqual(items.slice(20));
  await user.type(screen.getByRole('textbox', { name: 'Filter' }), 'item-1');
  // item-1 and item-10 to item-19: 11 rows, so the last page is 2.
  expect(shown()).toEqual(['item-19']);
  await user.type(screen.getByRole('textbox', { name: 'Filter' }), '2');
  expect(shown()).toEqual(['item-12']);
});
