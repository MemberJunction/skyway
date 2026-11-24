/**
 * @module db/lock-timeout
 * Validation for `DatabaseConnectionOptions.LockTimeout`, which providers
 * interpolate into a `SET` statement and so must check first.
 */

/** Both SQL Server and PostgreSQL store the lock timeout as a 32-bit signed int. */
export const LOCK_TIMEOUT_MAX_MS = 2_147_483_647;

/**
 * Validates a lock timeout in milliseconds before it is interpolated into SQL.
 *
 * @param value The configured `LockTimeout`. Typed `unknown` because JSON/JS
 *              config files can carry any value at runtime.
 * @returns The validated value, for inline use.
 * @throws Error unless the value is an integer from 0 to {@link LOCK_TIMEOUT_MAX_MS}.
 */
export function validateLockTimeout(value: unknown): number {
  const valid = typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= LOCK_TIMEOUT_MAX_MS;
  if (!valid) {
    throw new Error(
      `LockTimeout must be an integer from 0 to ${LOCK_TIMEOUT_MAX_MS} (milliseconds), got: ${JSON.stringify(value)}`
    );
  }
  return value;
}
