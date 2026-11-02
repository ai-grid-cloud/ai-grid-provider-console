# Building console pages

How every page of the console looks and behaves, so a new page reads like the others. It follows
PatternFly 6's components and documented patterns: use them before writing CSS, and check
[PatternFly's empty state](https://www.patternfly.org/components/empty-state/design-guidelines),
[table](https://www.patternfly.org/components/table/design-guidelines) and
[content](https://www.patternfly.org/ux-writing/about) guidelines when in doubt. The repository's
rules (what the BFF may do, how a feature is added) are in [../AGENTS.md](../AGENTS.md); building
against the fake backend is in [../mock/AGENTS.md](../mock/AGENTS.md).

## A page

A page is a `PageHeader` and one filled `PageSection`, through `PageStateSection`
(`src/components/states/`), which picks what the section shows:

- the header: the breadcrumb, the h1, the object's compact status beside it, then its actions (an
  external link first, then the `Actions` menu, `SimpleMenuActions` with `toggleLabel`);
- the spinner (`PageLoading`) while the first load is out: under a list page's static header, or
  alone on a page for one object (a details, edit or wizard page that loads one, which passes
  `notFound`). Such a page builds no title or breadcrumb from the URL's id: its header appears with
  the object, so it never shows the id first and the name a moment later. If the first load fails,
  the header names the list;
- the failed load's state when nothing has shown yet (`LoadError`, below), without the status and
  actions, which need the object;
- the content, with a `StaleDataAlert` above it while a reload has failed.

Never write a page-level `EmptyState` or `Alert` for these by hand: use the components below.

Spacing between siblings comes from PatternFly's layouts (`Stack` or `Flex` with a gutter), not
margin or padding utilities; where a utility is the only way, it carries a one-line reason. The
breadcrumb goes to `PageHeader`, which puts it in PatternFly's `PageBreadcrumb` section.
A vertical `Flex` also sets `flexWrap={{ default: 'nowrap' }}`: `Flex` wraps by default, and in a
container of limited height (a wizard step) its column wraps into side-by-side columns. A page whose
content is a `Wizard` passes `isWizard` to `PageStateSection` (or uses `PageSection type="wizard"`),
so the wizard fills the page, its footer stays in view and only the step scrolls; content in a
step is spaced by a `Stack` or a `Form`.

## States

All in `src/components/states/`; `LoadError` (`src/components/LoadError.tsx`) picks the right one for
a failed load.

| State                           | Component                                          | Looks like                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                         | `PageLoading`                                      | a spinner in the middle of the section, under a list's header; alone on an object's page                                                                            |
| Load failed, nothing to show    | `ErrorState`                                       | large empty state, red exclamation (`status="danger"`), h2 "Unable to load &lt;object&gt;" (singular on a page for one object), the server's message, primary Retry |
| 404 on a page for one object    | `NotFoundState`                                    | large, path-missing icon, "&lt;Object&gt; not found", "Go to &lt;List&gt;"; the header shows the list's name, not the id                                            |
| 501 (the backend lacks the RPC) | `NotAvailableState`                                | large, grey wrench, no Retry                                                                                                                                        |
| 401                             | `SessionEnded`, once for the console               | `LoadError` shows nothing                                                                                                                                           |
| No access                       | `FullPageState`                                    | large, lock icon; `inPage` under a page's header (a 403)                                                                                                            |
| Data still shown, reload failed | `StaleDataAlert`                                   | warning inline alert under the header, "Showing the last loaded &lt;objects&gt;", the server's message, Retry; a section that failed gets one inside the section    |
| Empty list                      | `EmptyListState`                                   | large, grey plus-circle (cubes for a list nobody creates here, such as Clusters), "No &lt;objects&gt;", the create button for a user who may create                 |
| Empty section                   | `SectionEmptyState`                                | extra small, no icon                                                                                                                                                |
| Filter matches nothing          | `TableEmptyRow` (`NoResultsState` outside a table) | "No results found", Clear all filters; only for a filter, never for a table with no rows                                                                            |

`LoadError` takes `onRetry` always: every failure that can pass offers Retry.

## Lists

- `PaginatedTable`, its toolbar holding the filter, the create button, then refresh.
- The search box is `ToolbarSearch`, its placeholder "Filter by &lt;fields&gt;", its name "Filter
  &lt;objects&gt;". A list that filters by more than one attribute uses PatternFly's attribute
  search (the Subscriptions toolbar).
- Every column sortable.
- The row menu is `SimpleMenuActions`, last, for users who may write only: View details, Edit, a
  divider, Delete.
- "—" (`EMPTY_VALUE`) for a missing value; numbers right-aligned (`className="pf-v6-u-text-align-end"`
  on the `Th` and the `Td`). PatternFly's cell props center a column (`textCenter`) and do not
  right-align one.

## Status

- `StatusLabel` only, compact in tables and page headers. The word and its colour come from
  `utilities/status.tsx`; one word per state ("Active" for a subscription and its policy alike).
- A status label is an outline label with its reason in a tooltip, and opens nothing, except on the
  Models list: Ready stays outline and is not clickable, and every other model phase is filled and
  opens `ModelStatusModal`. A model's page keeps the outline label; its alert explains the phase.
  The subscription creation form, including Add models, opens that same dialog for Partially ready.
- A label is clickable (filled) where a whole column opens each row's details, for every row: the
  locations table of a model (`ModelLocationsTable`), which opens that cluster's deployment status.
  Never mix outline and filled labels in one column.

## Time

`RelativeTime` everywhere ("3 days ago", the full date in its tooltip), on details pages too.

## Forms and actions

- Field errors show after the field is touched; the server's field errors map to their fields.
- A failed save is an inline danger alert, "Unable to &lt;verb&gt; &lt;object&gt;".
- Buttons: primary (or danger), then Cancel as a link.
- A big create is a `Wizard` with `ConsoleWizardFooter`; a small one a `Form` with an `ActionGroup`.
- Every delete, and Remove from AI Grid, asks for the object's name typed in (`DeleteModal`).
- After an action succeeds, a success toast: navigate with `state: { notice }` (`NoticeToast`).
- Write actions show only for a user who may write (`isProviderAdmin`); when `/user` fails, the
  console says so above every page rather than quietly hiding them.

## Wording

Sentence case; headings without a trailing period; short. "Unable to load &lt;object&gt;",
"&lt;Object&gt; not found", "No &lt;objects&gt;", "Showing the last loaded &lt;objects&gt;". Say
"cluster", not "ManagedCluster", in the UI.

## Tests

Query by role and accessible name; no timeouts or sleeps. A shared state is tested once in
`src/__tests__/shared-ui.test.tsx`; a page's tests check that it uses it (its title and Retry).
