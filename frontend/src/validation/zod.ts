/**
 * The console's zod: import `z` from here, never from 'zod' (eslint enforces it), so every schema gets
 * the console's wording. `consoleErrorMap` words each issue a schema doesn't word itself, in short
 * sentences a user can act on; a schema's own message (`.min(1, '...')`, `{ error: ... }`) still wins.
 * mock/validation/cases.json pins the resulting messages (cases.test.ts).
 *
 * z.config is global to the zod copy, which Perses shares; Perses's own schemas set their messages.
 */
import { z } from 'zod';

const plural = (n: number | bigint, one: string, many: string) => `${n} ${Number(n) === 1 ? one : many}`;

/** A bound zod puts on every integer schema, which says nothing about the field. */
const isSafeIntegerBound = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) || Math.abs(n) >= Number.MAX_SAFE_INTEGER;

/** "Enter a number from 1 to 64." when the schema has both bounds, else the one bound the input broke. */
const numberRange = (schema: unknown, fallback: string): string => {
  if (schema instanceof z.ZodNumber) {
    const { minValue, maxValue } = schema;
    if (!isSafeIntegerBound(minValue) && !isSafeIntegerBound(maxValue)) {
      return `Enter a number from ${minValue} to ${maxValue}.`;
    }
  }
  return fallback;
};

const typeMessages: Record<string, string> = {
  string: 'Enter text.',
  number: 'Enter a number.',
  int: 'Enter a whole number.',
  bigint: 'Enter a whole number.',
  boolean: 'Enter true or false.',
  array: 'Enter a list.',
  object: 'Enter a set of fields.',
  record: 'Enter a set of fields.',
  never: 'Remove this field.',
};

const formatMessages: Record<string, string> = {
  url: 'Enter a valid URL.',
  email: 'Enter a valid email address.',
};

/** A string's or a list's length bound: "Enter exactly 3 items.", "Enter at most 63 characters." */
const lengthMessage = (
  bound: number | bigint,
  exact: boolean | undefined,
  side: 'least' | 'most',
  one: string,
  many: string,
) => (exact ? `Enter exactly ${plural(bound, one, many)}.` : `Enter at ${side} ${plural(bound, one, many)}.`);

export const consoleErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input == null && issue.expected !== 'never') return 'Required.';
      return typeMessages[issue.expected] ?? 'Enter a valid value.';
    case 'too_small':
      switch (issue.origin) {
        case 'string':
          // A string of at least one character is simply required.
          if (!issue.exact && Number(issue.minimum) <= 1) return 'Required.';
          return lengthMessage(issue.minimum, issue.exact, 'least', 'character', 'characters');
        case 'array':
        case 'set':
          return lengthMessage(issue.minimum, issue.exact, 'least', 'item', 'items');
        case 'number':
        case 'int':
        case 'bigint':
          if (issue.origin === 'int' && isSafeIntegerBound(Number(issue.minimum))) {
            return numberRange(issue.schema, 'Enter a larger number.');
          }
          return numberRange(
            issue.schema,
            issue.inclusive
              ? `Enter a number of at least ${issue.minimum}.`
              : `Enter a number greater than ${issue.minimum}.`,
          );
        default:
          return 'Enter a larger value.';
      }
    case 'too_big':
      switch (issue.origin) {
        case 'string':
          return lengthMessage(issue.maximum, issue.exact, 'most', 'character', 'characters');
        case 'array':
        case 'set':
          return lengthMessage(issue.maximum, issue.exact, 'most', 'item', 'items');
        case 'number':
        case 'int':
        case 'bigint':
          if (issue.origin === 'int' && isSafeIntegerBound(Number(issue.maximum))) {
            return numberRange(issue.schema, 'Enter a smaller number.');
          }
          return numberRange(
            issue.schema,
            issue.inclusive
              ? `Enter a number of at most ${issue.maximum}.`
              : `Enter a number less than ${issue.maximum}.`,
          );
        default:
          return 'Enter a smaller value.';
      }
    case 'invalid_format':
      if (issue.format === 'starts_with') return `Start with "${issue.prefix}".`;
      if (issue.format === 'ends_with') return `End with "${issue.suffix}".`;
      if (issue.format === 'includes') return `Include "${issue.includes}".`;
      return formatMessages[issue.format] ?? 'Enter a valid value.';
    case 'not_multiple_of':
      return `Enter a multiple of ${issue.divisor}.`;
    case 'unrecognized_keys':
      return issue.keys.length === 1
        ? `Remove the unknown field "${issue.keys[0]}".`
        : `Remove the unknown fields ${issue.keys.map((key) => `"${key}"`).join(', ')}.`;
    case 'invalid_value':
      return issue.values.length === 1
        ? `Only ${String(issue.values[0])} is allowed.`
        : `Choose one of: ${issue.values.map(String).join(', ')}.`;
    case 'invalid_union':
    case 'invalid_key':
    case 'invalid_element':
    case 'custom':
      return 'Enter a valid value.';
  }
};

z.config({ customError: consoleErrorMap });

export { z };
