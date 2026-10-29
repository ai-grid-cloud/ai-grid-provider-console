# Building console pages

How every page of the console looks and behaves, so a new page reads like the others. It follows
PatternFly 6's components and documented patterns: use them before writing CSS, and check
[PatternFly's empty state](https://www.patternfly.org/components/empty-state/design-guidelines),
[table](https://www.patternfly.org/components/table/design-guidelines) and
[content](https://www.patternfly.org/content-design/overview) guidelines when in doubt. The repository's
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
- "—" (`EMPTY_VALUE`) for a missing value; numbers right-aligned (`className="console-number"` on
  the `Th` and the `Td`).

## Status

- `StatusLabel` only, compact in tables and page headers. The word and its colour come from
  `utilities/status.tsx`; one word per state ("Active" for a subscription and its policy alike).
- A status label is an outline label with its reason in a tooltip, and opens nothing. The details
  live on the page: the Models list's expanded row, the details pages, a subscription's policies.
- A label is clickable (filled) only where a whole column opens each row's details, for every row:
  today only the locations table of a model (`ModelLocationsTable`). Never mix the two variants in
  one column.

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

The console is for provider admins: people who run the hub and its clusters, but who did not write
the console. Write so that someone new to AI Grid can act on every message. The words follow
PatternFly's [content design](https://www.patternfly.org/content-design/overview) guides, with
odh-dashboard as the reference product. The terms come from [GLOSSARY.md](../GLOSSARY.md).

1. **Sentence case for everything**: page titles, nav items, tabs, buttons, menu items, column
   headers and modal titles. Proper nouns keep their capitals: AI Grid, OpenShift, OpenShift AI,
   Git, MaaS, KServe, OIDC, Perses, NVIDIA. "Cloud Provider Admin Console" is the one title-case
   string, because it is the product name.
   ([capitalization](https://www.patternfly.org/content-design/grammar/capitalization))
2. **No end punctuation in titles, headings, buttons, labels, tabs, column headers or toasts.** The
   one exception is the "?" of a confirmation modal ("Delete organization?"). Body text, helper
   text, tooltips and field errors that are full sentences end with a period; fragments don't.
   ([punctuation](https://www.patternfly.org/content-design/grammar/punctuation))
3. **Professional and plain, not chatty.** Leave out "Oops", "Something went wrong", "ran into a
   problem", "Are you sure", "please", "talks to", "Check it", "if you end up back here", and filler
   "yet" or "now". Contractions are fine: state the fact and the next step.
   ([brand voice](https://www.patternfly.org/content-design/brand-voice-and-tone))
4. **One term per concept, the glossary's**:
   - _cluster_, not managed cluster or ManagedCluster; _AI Grid cluster_ for a Grid member;
   - _organization_, never tenant; the people who use a subscription are _users_ in its _groups_;
   - _model_, not model deployment;
   - _location_ (the label models are deployed by) and _site_ (the place's name);
   - the roles _Ingress_, _Inference_ and _Combined_;
   - _hub_ (lowercase), _provider admin_, and _your hub administrator_ for whoever grants access;
   - _AI Grid_, never "the grid", "grid" or "fleet".
5. **A help icon, not a longer label.** Wherever a term could confuse an admin (a role, a count, a
   status), put its explanation in a help popover (`HelpPopover`, or a `FormGroup`'s `labelHelp`)
   beside it. A cluster's role always has one, wherever it is shown or chosen.
6. **Verbs** ([terminology](https://www.patternfly.org/content-design/grammar/terminology)):
   - _Create_ a new object, with _Delete_ as its opposite.
   - _Add_ and _Remove_ put an existing thing into or out of a container ("Add to AI Grid", "Add
     models", "Add domain").
   - _Deploy_ is for models only.
   - _Edit_, never Change or Modify. _Select_, never Choose.
   - _Log in_ and _Log out_, never sign in or out.
   - _View details_ in row menus.
7. **Error titles are "Unable to &lt;verb&gt; &lt;object&gt;"**: "Unable to load clusters", "Unable
   to delete organization". Never "Error loading", "Failed to" or "Something went wrong". In the
   body, say what happened (usually the server's message) and then what to do.
8. **Empty lists are titled "No &lt;objects&gt;"**, with a body that starts with the goal: "To
   &lt;goal&gt;, &lt;action&gt;."
9. **A filter that matches nothing** shows "No results found", "Adjust your filters and try
   again." and Clear all filters, on every list.
10. **No access** is "Access permissions needed", with a body that ends "To &lt;goal&gt;, ask your
    hub administrator ...".
11. **Not found** is "&lt;Object&gt; not found", one sentence, then "Go to &lt;list&gt;".
12. **Success toasts are "&lt;Object&gt; &lt;past participle&gt;"**: "Organization created", "Model
    deployed", "local-cluster added to AI Grid". No "successfully" and no period.
13. **Confirmation modals** follow one pattern
    ([modal](https://www.patternfly.org/components/modal/design-guidelines)):
    - the title is "&lt;Verb&gt; &lt;object&gt;?";
    - the danger button repeats the verb, and Cancel is a link;
    - the body states the consequence in three lines or fewer, with no "Are you sure";
    - a destructive action asks for "Type &lt;name&gt; to confirm:".
14. **Helper text says what to enter or what constraint applies.** It doesn't repeat the label or
    explain what the field is. Write examples as "For example, us-east."
15. **Field errors are one imperative sentence that ends with a period and says how to fix the
    input**: "Required.", "Enter a number from 1 to 99.", "Select at least one location.". The same
    constraint gets the same words everywhere, and a limit names its value.
16. **No internal jargon.** Don't write label keys (`ai-grid/enabled`), Kubernetes kinds (Policy,
    ManifestWork, MaaSModelRef), "controller", "pods", "KEDA", "ACM Search", "git mode", "CEL",
    "telemetry" or "Thanos". Name what the admin sees or acts on. Keep the names an admin types or
    selects: vLLM, MIG, OIDC, JWKS, Secret, `hf://`.
17. **Tooltips are short and add something the label doesn't.** A status tooltip gives the reason,
    and a full sentence ends with a period.
    ([tooltips](https://www.patternfly.org/content-design/writing-guides/tooltips))
18. **Use the Oxford comma, American spelling ("color"), and thousands separators (1,000,000).**
19. **Keep button labels the same while an action runs**: use `isLoading`, not "Saving..." or
    "Creating...". Loading labels are "Loading &lt;objects&gt;", with no ellipsis.
20. **A feature the backend lacks gets one sentence everywhere**: "&lt;Feature&gt; is not available
    on this AI Grid backend."

## Tests

Query by role and accessible name; no timeouts or sleeps. A shared state is tested once in
`src/__tests__/shared-ui.test.tsx`; a page's tests check that it uses it (its title and Retry).
