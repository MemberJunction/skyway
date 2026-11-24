/**
 * @module db/lock-timeout
 * Validation for `DatabaseConnectionOptions.LockTimeout`, which providers
 * interpolate into a `SET` statement and so must check first.
 */

/** Both SQL Server and PostgreSQL store the lock timeout as a 32-bit signed int. */
export const LOCK_TIMEOUT_MAX_MS = 2_147_483_647;

/**
 * Validates a lock timeout in milliseconds before it is interpolated into SQL.
 * `0` is rejected because the engines read it in opposite ways: SQL Server
 * fails at once, PostgreSQL disables the timeout. Use `1` to fail at once on
 * both, or leave `LockTimeout` unset for no limit.
 *
 * @param value The configured `LockTimeout`. Typed `unknown` because JSON/JS
 *              config files can carry any value at runtime.
 * @returns The validated value, for inline use.
 * @throws Error unless the value is an integer from 1 to {@link LOCK_TIMEOUT_MAX_MS}.
 */
export function validateLockTimeout(value: unknown): number {
  const valid = typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= LOCK_TIMEOUT_MAX_MS;
  if (!valid) {
    // String() for numbers and bigints: JSON.stringify prints NaN/Infinity as "null" and throws on bigint.
    const shown = typeof value === 'number' || typeof value === 'bigint' ? String(value) : JSON.stringify(value);
    throw new Error(
      `LockTimeout must be an integer from 1 to ${LOCK_TIMEOUT_MAX_MS} (milliseconds), got: ${shown}`
    );
  }
  return value;
}
