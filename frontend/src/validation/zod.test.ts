import cases from '../../../mock/validation/cases.json';
import { fieldErrorsOf, modelFieldsSchema, validators } from '.';
import { z } from './zod';
import { getCountError, getTimeDigitError, getTimeError, type RateLimit } from '../utilities/rateLimits';

/**
 * zod's own English, in its 4.x and 3.x wording; none of it should reach a user. Not zod 3's bare
 * "Required": that is also the console's own field error for a missing value (frontend/AGENTS.md,
 * Wording), and zod 4, which the console uses, never says it.
 */
const zodDefault =
  /^(Invalid input|Invalid string|Invalid (url|email|URL|option|element|key|literal|enum)|Invalid$|Too (big|small)|Unrecognized key|Expected |(String|Number|Array) must)/;

const messages = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

// The console's pages refuse eval (their Content-Security-Policy), so zod must not compile schemas
// with `new Function`, nor probe whether it may: the refused probe is a policy violation.
it('keeps zod from compiling schemas with eval', () => {
  expect(z.config().jitless).toBe(true);
  expect(z.object({ a: z.string() }).safeParse({ a: 'x' }).success).toBe(true);
});

describe("the console's wording for zod issues", () => {
  it('words every shared validation case without zod defaults', () => {
    const all = cases.cases.flatMap((c) => Object.values(validators[c.schema as keyof typeof validators](c.input)));
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((message) => zodDefault.test(message))).toEqual([]);
  });

  // One schema without a message per issue code, and the sentence the user sees.
  it.each<[string, z.ZodType, unknown, string]>([
    ['a missing value', z.object({ a: z.string() }), {}, 'Required'],
    ['a null value', z.object({ a: z.number() }), { a: null }, 'Required'],
    ['text expected', z.string(), 1, 'Enter text.'],
    ['a number expected', z.number(), 'x', 'Enter a number.'],
    ['not a number', z.number(), Number.NaN, 'Enter a number.'],
    ['a whole number expected', z.number().int(), 1.5, 'Enter a whole number.'],
    ['true or false expected', z.boolean(), 'yes', 'Enter true or false.'],
    ['a list expected', z.array(z.string()), {}, 'Enter a list.'],
    ['fields expected', z.object({}), [], 'Enter a set of fields.'],
    ['fields expected in a record', z.record(z.string(), z.string()), [], 'Enter a set of fields.'],
    ['a field that must be absent', z.object({ a: z.never().optional() }), { a: 'x' }, 'Remove this field.'],
    ['an empty string', z.string().min(1), '', 'Required'],
    ['too short', z.string().min(3), 'ab', 'Enter at least 3 characters.'],
    ['too long', z.string().max(63), 'a'.repeat(64), 'Enter at most 63 characters.'],
    ['a wrong length', z.string().length(2), 'abc', 'Enter exactly 2 characters.'],
    ['an empty list', z.array(z.string()).min(1), [], 'Enter at least 1 item.'],
    ['too many items', z.array(z.string()).max(2), ['a', 'b', 'c'], 'Enter at most 2 items.'],
    ['a number below its range', z.number().int().min(1).max(64), 0, 'Enter a number from 1 to 64.'],
    ['a number above its range', z.number().int().min(1).max(64), 65, 'Enter a number from 1 to 64.'],
    ['a number below its minimum', z.number().min(1), 0, 'Enter a number of at least 1.'],
    ['a number above its maximum', z.number().max(64), 65, 'Enter a number of at most 64.'],
    ['a number not above its bound', z.number().gt(0), 0, 'Enter a number greater than 0.'],
    ['a number not below its bound', z.number().lt(10), 10, 'Enter a number less than 10.'],
    ['an unsafe integer', z.number().int(), 2 ** 60, 'Enter a smaller number.'],
    ['an unsafe negative integer', z.number().int(), -(2 ** 60), 'Enter a larger number.'],
    // Bounds of four digits or more read with thousands separators.
    ['a long text', z.string().max(4096), 'a'.repeat(4097), 'Enter at most 4,096 characters.'],
    [
      'a large range',
      z.number().int().min(-1_000_000).max(1_000_000),
      2_000_000,
      'Enter a number from -1,000,000 to 1,000,000.',
    ],
    ['a large minimum', z.number().min(1000), 999, 'Enter a number of at least 1,000.'],
    ['a large bound', z.number().lt(10_000), 10_000, 'Enter a number less than 10,000.'],
    ['a large multiple', z.number().multipleOf(1024), 1000, 'Enter a multiple of 1,024.'],
    ['a large bigint bound', z.bigint().max(1_000_000n), 2_000_000n, 'Enter a number of at most 1,000,000.'],
    // Decimals keep every digit: a rounded bound would state a different rule.
    ['a decimal multiple', z.number().multipleOf(0.0001), 0.00015, 'Enter a multiple of 0.0001.'],
    ['a decimal minimum', z.number().min(1.23456), 1, 'Enter a number of at least 1.23456.'],
    ['a pattern', z.string().regex(/^a+$/), 'b', 'Enter a valid value.'],
    ['a URL', z.url(), 'not a url', 'Enter a valid URL.'],
    ['an email address', z.email(), 'nobody', 'Enter a valid email address.'],
    ['a prefix', z.string().startsWith('hf://'), 'oci://x', 'Start with "hf://".'],
    ['a suffix', z.string().endsWith('.yaml'), 'values.json', 'End with ".yaml".'],
    ['a substring', z.string().includes('/'), 'model', 'Include "/".'],
    ['a multiple', z.number().multipleOf(5), 7, 'Enter a multiple of 5.'],
    ['an unknown field', z.strictObject({}), { a: 1 }, 'Remove the unknown field "a".'],
    ['unknown fields', z.strictObject({}), { a: 1, b: 2 }, 'Remove the unknown fields "a", "b".'],
    ['a union', z.union([z.literal(''), z.number()]), 'x', 'Enter a valid value.'],
    ['a literal', z.literal(true), false, 'Only true is allowed.'],
    ['an enum', z.enum(['hour', 'minute']), 'day', 'Choose one of: hour, minute.'],
    ['a refinement', z.string().refine((s) => s === 'ok'), 'no', 'Enter a valid value.'],
  ])('words %s', (_, schema, input, expected) => {
    const words = messages(schema, input);
    expect(words.at(-1)).toBe(expected);
    expect(words.filter((message) => zodDefault.test(message))).toEqual([]);
  });

  it("keeps a schema's own message", () => {
    expect(messages(z.string().min(1, 'Client ID is required.'), '')).toEqual(['Client ID is required.']);
  });

  it('says the range for a number too large for an integer, whichever issue comes last', () => {
    // 2 ** 54, a 17-digit number, fails zod's safe-integer bound first, then the schema's maximum; the field
    // shows the last message, and both say the range.
    const result = modelFieldsSchema.shape.replicas.safeParse(2 ** 54);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Enter a number from 1 to 99.',
      'Enter a number from 1 to 99.',
    ]);
    expect(fieldErrorsOf(modelFieldsSchema.pick({ replicas: true }), { replicas: 2 ** 54 })).toEqual({
      replicas: 'Enter a number from 1 to 99.',
    });
    // Without a range, the maximum that was broken still comes last.
    expect(messages(z.number().int().max(64), 2 ** 60)).toEqual([
      'Enter a smaller number.',
      'Enter a number of at most 64.',
    ]);
  });

  it("keeps the token rate limits' own messages, and words the rest", () => {
    const limit = (time: number, unit: RateLimit['unit'] = 'hour', count = 1000): RateLimit => ({ count, time, unit });
    const words = [
      getTimeDigitError(limit(8785)),
      getTimeError(limit(0)),
      getTimeError(limit(10_000, 'second')),
      getTimeError(limit(1.5)),
      getCountError(limit(1, 'hour', 0)),
      getCountError(limit(1, 'hour', 2 ** 60)),
    ];
    // The rate limits' own words, as #94 rewrote them (utilities/rateLimits.ts).
    expect(words).toEqual([
      'Enter at most 8,784 hours (366 days).',
      'Enter a time of at least 1.',
      'Enter a time of at most 9,999.',
      'Enter a whole number.',
      'Enter a number of at least 1.',
      'Enter a number from 1 to 1,000,000,000.',
    ]);
    expect(words.filter((message) => zodDefault.test(message ?? ''))).toEqual([]);
  });
});
