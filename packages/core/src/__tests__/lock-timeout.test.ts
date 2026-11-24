import { describe, it, expect } from 'vitest';
import { validateLockTimeout, LOCK_TIMEOUT_MAX_MS } from '../db/lock-timeout';

describe('validateLockTimeout', () => {
  it.each([1, 2000, LOCK_TIMEOUT_MAX_MS])('accepts %s', (value) => {
    expect(validateLockTimeout(value)).toBe(value);
  });

  it.each([
    ['zero (opposite meanings across engines)', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['above int32', LOCK_TIMEOUT_MAX_MS + 1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['numeric string', '2000'],
    ['injection string', '0; DROP TABLE x'],
    ['null', null],
    ['bigint', 2000n],
  ])('rejects %s', (_label, value) => {
    expect(() => validateLockTimeout(value)).toThrow(/LockTimeout must be an integer from 1/);
  });

  it.each([
    [NaN, 'got: NaN'],
    [Infinity, 'got: Infinity'],
    [2000n, 'got: 2000'],
    ['2000', 'got: "2000"'],
  ])('shows %s as it was configured', (value, shown) => {
    expect(() => validateLockTimeout(value)).toThrow(shown);
  });
});
