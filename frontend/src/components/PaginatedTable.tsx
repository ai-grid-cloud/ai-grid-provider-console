// Ported from krisv/ai-grid-cloud-provider-poc src/shared/dashboard.tsx (Table) at 62319b8:
// its pagination; the toolbar layout follows PatternFly's table guidelines instead.
import { useState } from 'react';
import { Pagination, Toolbar, ToolbarContent, ToolbarItem } from '@patternfly/react-core';

const PER_PAGE_DEFAULT = 10;

type Props<T> = {
  /** The filtered and sorted rows. */
  rows: T[];
  /** The list's toolbar items (search, filters, actions), on the left of the pagination. */
  toolbar?: React.ReactNode;
  /**
   * Clears the toolbar's filters. Needed when the toolbar shows its filters as labels
   * (ToolbarFilter): PatternFly then adds its own Clear all filters, which calls this. The labels
   * then fold away only below md, where such a toolbar's filters fold behind its ToolbarToggleGroup
   * (breakpoint="md") and show there; PatternFly's default, lg, would hide them with nowhere to see
   * them between the two.
   */
  clearAllFilters?: () => void;
  /** Renders the table for the rows of the current page. */
  children: (pageRows: T[]) => React.ReactNode;
};

/**
 * A list table with PatternFly's toolbar layout: one toolbar above the table holding the
 * list's own items and, at its end, the pagination. Pagination repeats below the table only
 * when there is more than one page. The page is clamped to the last one when the rows shrink,
 * for example after filtering.
 */
export const PaginatedTable = <T,>({ rows, toolbar, clearAllFilters, children }: Props<T>) => {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PER_PAGE_DEFAULT);
  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / perPage)));
  const pagination = (bottom: boolean) => (
    <Pagination
      itemCount={rows.length}
      page={safePage}
      perPage={perPage}
      isCompact={!bottom}
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
      <Toolbar clearAllFilters={clearAllFilters} collapseListedFiltersBreakpoint={clearAllFilters ? 'md' : undefined}>
        <ToolbarContent>
          {toolbar}
          <ToolbarItem variant="pagination" align={{ default: 'alignEnd' }}>
            {pagination(false)}
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>
      {children(rows.slice((safePage - 1) * perPage, safePage * perPage))}
      {rows.length > perPage && pagination(true)}
    </>
  );
};
