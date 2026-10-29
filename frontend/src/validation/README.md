# Form validation

The console validates input with zod. Import `z` from `src/validation/zod` (ESLint refuses `'zod'`
anywhere else): that module installs `consoleErrorMap`, the console's wording for every zod issue,
so a schema written without a single message still reads well:

| Issue                                                      | Message                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| A missing or null value, or an empty string with `.min(1)` | Required.                                                                 |
| Wrong type                                                 | Enter text. / Enter a number. / Enter a whole number. / Enter a list. / … |
| String length                                              | Enter at least 3 characters. / Enter at most 63 characters.               |
| List length                                                | Enter at least 1 item. / Enter at most 64 items.                          |
| Number with both bounds                                    | Enter a number from 1 to 64. (whichever bound it crosses)                 |
| Number with one bound                                      | Enter a number of at least 1. / Enter a number of at most 64.             |
| Pattern, union, refinement                                 | Enter a valid value.                                                      |
| URL, email                                                 | Enter a valid URL. / Enter a valid email address.                         |
| Unknown key in a strict object                             | Remove the unknown field "x".                                             |
| Literal, enum                                              | Only true is allowed. / Choose one of: hour, minute.                      |

## Adding a field

1. Add it to its schema in `index.ts` with the rules alone: `z.string().trim().min(1).max(253)`.
2. Write a message only where a field-specific sentence helps the user more than the default: a
   pattern (`'Use lowercase letters, numbers, and hyphens.'`, since "Enter a valid value." doesn't say
   what is valid), a refinement, or a rule that names the field (`'Select an organization'`). A
   schema's own message always wins over the map.
3. Show it with `fieldErrorsOf` (every field's last message) or `fieldMessage` (one text field).

## The cases and the fake backend

The cases in `mock/validation/cases.json` run in the frontend (`cases.test.ts`) and pin each
schema's messages. The console's fake backend still checks identity providers for the Organizations
pages (`bff/internal/fakebackend/validate.go`) with the same messages; change them together until
Organizations moves to the backend's API. `zod.test.ts` fails if any of zod's
own English reaches a user. The real backend words its errors itself; the console shows them as sent.
