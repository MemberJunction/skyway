/**
 * @module db/identifier
 * SQL identifier validation — shared by all database providers.
 *
 * Provider implementations inevitably need to interpolate schema names, table
 * names, and database names into SQL (these cannot be parameterized via the
 * driver's prepared-statement API — SQL binds values, not identifiers). To
 * keep that safe, providers MUST validate identifiers before interpolation.
 *
 * The validator here enforces a conservative whitelist: an identifier must
 * match `/^[A-Za-z_][A-Za-z_0-9]*$/` — a leading letter or underscore, then
 * letters/digits/underscores. This rejects quotes, semicolons, whitespace,
 * brackets, and every character an attacker would need for injection.
 *
 * Rationale for strictness over "quote-escape and hope":
 * - `[${id}]` on SQL Server isn't safe: `]` inside the identifier terminates
 *   the bracket. Escape rules differ per dialect.
 * - `"${id}"` on PostgreSQL isn't safe: `"` inside the identifier terminates
 *   the quote. Escape rules differ per dialect.
 * - A whitelist sidesteps both — if you can't spell injection with letters,
 *   digits, and underscores, we're done. The tradeoff is rejecting exotic
 *   identifier names (hyphens, spaces, unicode), which MJ doesn't use.
 *
 * If a downstream project needs looser rules, they should call
 * `QuoteIdentifier` on their dialect and own the escaping — don't loosen
 * this validator.
 */

/**
 * The pattern every SQL identifier must match before being interpolated.
 * Exported so callers can reference it in error messages or share it between
 * provider tests.
 */
export const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z_0-9]*$/;

/**
 * Reasonable upper bound on identifier length. SQL Server and PostgreSQL both
 * allow longer (128 and 63 respectively by default) but enforcing a strict cap
 * keeps error messages clear and defends against pathologically long input.
 */
export const SQL_IDENTIFIER_MAX_LENGTH = 128;

/**
 * Validates that a string is safe to interpolate as a SQL identifier.
 * Throws with a caller-friendly message on failure.
 *
 * @param value The identifier to validate (schema name, table name, database name, etc.)
 * @param role  A short label for error messages (e.g. "schema", "database", "history table").
 * @returns The validated identifier (same string) for convenient inline use.
 * @throws Error if the identifier is empty, too long, or contains disallowed characters.
 *
 * @example
 * // Throws: schema must match /^[A-Za-z_][A-Za-z_0-9]*$/, got: "drop_tables;--"
 * validateSqlIdentifier("drop_tables;--", "schema");
 */
export function validateSqlIdentifier(value: string, role: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${role} identifier is required and must be a non-empty string`);
  }
  if (value.length > SQL_IDENTIFIER_MAX_LENGTH) {
    throw new Error(
      `${role} identifier exceeds ${SQL_IDENTIFIER_MAX_LENGTH} characters (got ${value.length})`
    );
  }
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `${role} identifier must match ${SQL_IDENTIFIER_PATTERN}, got: ${JSON.stringify(value)}`
    );
  }
  return value;
}
