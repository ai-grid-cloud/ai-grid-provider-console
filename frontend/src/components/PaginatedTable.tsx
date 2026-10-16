// Ported from krisv/ai-grid-cloud-provider-poc src/shared/dashboard.tsx (Table) at 62319b8:
// its pagination only; each page keeps its own table markup, sorting and filters.
import { useState } from 'react';
import { Pagination } from '@patternfly/react-core';

type Props<T> = {
  /** The filtered and sorted rows. */
  rows: T[];
  /** Renders the table for the rows of the current page. */
  children: (pageRows: T[]) => React.ReactNode;
};

/**
 * Pages a list table as the PoC's dashboard Table does: 10 rows per page,
 * pagination above and below the table, and the page clamped to the last one
 * when the rows shrink, for example after filtering.
 */
export const PaginatedTable = <T,>({ rows, children }: Props<T>) => {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);
  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / perPage)));
  const pagination = (bottom: boolean) => (
    <Pagination
      itemCount={rows.length}
      page={safePage}
      perPage={perPage}
      variant={bottom ? 'bottom' : 'top'}
      onSetPage={(_event, value) => setPage(value)}
      onPerPageSelect={(_event, value) => {
        setPerPage(value);
        setPage(1);
      }}
    />
  );
  return (
    <>
      {pagination(false)}
      {children(rows.slice((safePage - 1) * perPage, safePage * perPage))}
      {pagination(true)}
    </>
  );
};
