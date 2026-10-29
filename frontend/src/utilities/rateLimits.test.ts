import { describe, expect, it } from 'vitest';
import {
  formatTokenRateLimitLine,
  formatWindow,
  getSavedWindowMessage,
  getTimeDigitError,
  parseWindow,
  rateLimitExceedsMaxDigits,
  toRateLimit,
  toTokenRateLimit,
} from './rateLimits';

// Windows the MaaSSubscription CRD accepts, `^[1-9]\d{0,3}(s|m|h)$`: every unit, both ends of the range.
const accepted = ['1s', '30s', '9999s', '1m', '5m', '60m', '9999m', '1h', '24h', '100h', '8784h', '9999h'];

// Windows the CRD refuses: other units and Go durations, combined units, zero, leading zeros,
// more than four digits, upper case, spaces, fractions, signs and the human-readable form.
const refused = [
  '',
  'h',
  '1',
  '500ms',
  '2d',
  '1w',
  '1h30m',
  '0h',
  '0s',
  '01h',
  '10000h',
  '1H',
  ' 1h',
  '1h ',
  '1 h',
  '1.5h',
  '-1h',
  '+1h',
  '1 hour',
  '24 hours',
];

describe('parseWindow', () => {
  it.each([
    ['1s', 1, 'second'],
    ['30m', 30, 'minute'],
    ['24h', 24, 'hour'],
    ['9999h', 9999, 'hour'],
  ] as const)('reads %s as %d %s', (window, time, unit) => {
    expect(parseWindow(window)).toEqual({ time, unit });
  });

  it.each(refused)('does not read %j', (window) => {
    expect(parseWindow(window)).toBeUndefined();
  });
});

describe('the token limit form', () => {
  it.each(accepted)('saves %s back unchanged', (window) => {
    expect(toTokenRateLimit(toRateLimit({ limit: 1000, window }))).toEqual({ limit: 1000, window });
  });

  it.each(refused)('leaves the time of %j empty instead of guessing one, and keeps the window', (window) => {
    const limit = toRateLimit({ limit: 1000, window });
    expect(limit.count).toBe(1000);
    expect(limit.time).toBeNaN();
    expect(limit.savedWindow).toBe(window);
  });

  it('names a saved window it cannot read until a valid time replaces it', () => {
    const limit = toRateLimit({ limit: 1000, window: '1h30m' });
    const message = 'The saved value "1h30m" is not valid. Enter a time from 1 to 9,999.';
    expect(getSavedWindowMessage(limit)).toBe(message);
    expect(getSavedWindowMessage({ ...limit, time: 0 })).toBe(message);
    expect(getSavedWindowMessage({ ...limit, time: 10000 })).toBe(message);
    expect(getSavedWindowMessage({ ...limit, time: 90 })).toBeUndefined();
    expect(toTokenRateLimit({ ...limit, time: 90, unit: 'minute' })).toEqual({ limit: 1000, window: '90m' });
  });

  it('names nothing for a window it reads', () => {
    expect(toRateLimit({ limit: 1000, window: '1h' })).toEqual({ count: 1000, time: 1, unit: 'hour' });
    expect(getSavedWindowMessage({ count: 1000, time: NaN, unit: 'hour' })).toBeUndefined();
  });
});

describe('the longest window, 366 days', () => {
  const hoursMessage = 'Enter at most 8,784 hours (366 days).';

  it.each([
    [8784, 'hour', undefined],
    [8785, 'hour', hoursMessage],
    [9999, 'hour', hoursMessage],
    [10000, 'hour', hoursMessage],
    [9999, 'minute', undefined],
    [9999, 'second', undefined],
    [10000, 'minute', 'Enter a time of at most 9,999.'],
    [NaN, 'hour', undefined],
  ] as const)('%d %s: %s', (time, unit, want) => {
    const limit = { count: 1000, time, unit };
    expect(getTimeDigitError(limit)).toBe(want);
    expect(rateLimitExceedsMaxDigits(limit)).toBe(want !== undefined);
  });
});

describe('formatWindow', () => {
  it.each([
    ['1s', '1 second'],
    ['30s', '30 seconds'],
    ['1m', '1 minute'],
    ['1h', '1 hour'],
    ['24h', '24 hours'],
    ['9999m', '9,999 minutes'],
  ])('shows %s as %s', (window, want) => {
    expect(formatWindow(window)).toBe(want);
  });

  it.each(['500ms', '2d', '1h30m', '0h', '1 hour'])('shows %s as it is', (window) => {
    expect(formatWindow(window)).toBe(window);
  });

  it('shows a token limit line', () => {
    expect(formatTokenRateLimitLine(100000, '1h')).toBe('100,000 / 1 hour');
    expect(formatTokenRateLimitLine(5, '1h30m')).toBe('5 / 1h30m');
  });
});
