import { describe, it, expect } from 'vitest';
import { validateLockTimeout, LOCK_TIMEOUT_MAX_MS } from '../db/lock-timeout';

describe('validateLockTimeout', () => {
  it.each([0, 1, 2000, LOCK_TIMEOUT_MAX_MS])('accepts %s', (value) => {
    expect(validateLockTimeout(value)).toBe(value);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['above int32', LOCK_TIMEOUT_MAX_MS + 1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['numeric string', '2000'],
    ['injection string', '0; DROP TABLE x'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(() => validateLockTimeout(value)).toThrow(/LockTimeout must be an integer/);
  });
});
