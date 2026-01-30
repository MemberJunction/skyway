/**
 * @module executor/placeholder
 * Placeholder substitution engine for migration SQL.
 *
 * **Key improvement over Flyway**: Only substitutes *known* placeholders.
 * Flyway aggressively replaces every `${...}` pattern, which breaks
 * JavaScript template literals, JSON templates, and other code embedded
 * in SQL strings. Skyway only touches:
 *
 * 1. Built-in `${flyway:*}` placeholders (defaultSchema, timestamp, etc.)
 * 2. Explicitly registered user placeholders from the config
 *
 * All other `${...}` patterns are left completely untouched.
 */

/**
 * Built-in placeholder names that Skyway recognizes in the `flyway:` namespace.
 * These are always available regardless of user configuration.
 */
const BUILTIN_FLYWAY_PLACEHOLDERS = new Set([
  'flyway:defaultSchema',
  'flyway:database',
  'flyway:user',
  'flyway:timestamp',
  'flyway:filename',
  'flyway:workingDirectory',
  'flyway:table',
]);

/**
 * Substitutes known placeholders in migration SQL content.
 *
 * Only replaces `${name}` patterns where `name` is either:
 * - A built-in `flyway:*` placeholder with a resolved value
 * - An explicitly registered user placeholder
 *
 * Unknown `${...}` patterns (like JavaScript template literals) are preserved.
 *
 * @param sql - Raw SQL content with placeholder tokens
 * @param placeholders - Map of placeholder name → replacement value
 * @param context - Runtime context for resolving built-in placeholders
 * @returns SQL with known placeholders replaced
 *
 * @example
 * ```typescript
 * const result = SubstitutePlaceholders(
 *   'CREATE TABLE [${flyway:defaultSchema}].[Users] (Name NVARCHAR(100))',
 *   { 'flyway:defaultSchema': '__mj' },
 *   { DefaultSchema: '__mj', Timestamp: new Date().toISOString() }
 * );
 * // result === 'CREATE TABLE [__mj].[Users] (Name NVARCHAR(100))'
 * ```
 */
export function SubstitutePlaceholders(
  sql: string,
  placeholders: Record<string, string>,
  context: PlaceholderContext
): string {
  // Build the complete placeholder map (built-ins + user-defined)
  const resolvedMap = buildPlaceholderMap(placeholders, context);

  // Replace only known placeholders
  // Pattern: ${name} where name can contain letters, digits, colons, underscores, dots
  return sql.replace(/\$\{([^}]+)\}/g, (fullMatch, name: string) => {
    if (resolvedMap.has(name)) {
      return resolvedMap.get(name)!;
    }
    // Unknown placeholder — leave it untouched
    return fullMatch;
  });
}

/**
 * Runtime context for resolving built-in Flyway placeholders.
 */
export interface PlaceholderContext {
  /** The configured default schema (e.g., "__mj") */
  DefaultSchema: string;

  /** Current timestamp string for ${flyway:timestamp} */
  Timestamp: string;

  /** Database name for ${flyway:database} */
  Database?: string;

  /** Connected user for ${flyway:user} */
  User?: string;

  /** Current migration filename for ${flyway:filename} */
  Filename?: string;

  /** History table name for ${flyway:table} */
  Table?: string;
}

/**
 * Builds the complete placeholder resolution map by merging
 * built-in Flyway placeholders with user-defined ones.
 *
 * User-defined placeholders take precedence over built-ins
 * if there's a naming conflict.
 */
function buildPlaceholderMap(
  userPlaceholders: Record<string, string>,
  context: PlaceholderContext
): Map<string, string> {
  const map = new Map<string, string>();

  // Built-in Flyway placeholders
  map.set('flyway:defaultSchema', context.DefaultSchema);
  map.set('flyway:timestamp', context.Timestamp);

  if (context.Database) {
    map.set('flyway:database', context.Database);
  }
  if (context.User) {
    map.set('flyway:user', context.User);
  }
  if (context.Filename) {
    map.set('flyway:filename', context.Filename);
  }
  if (context.Table) {
    map.set('flyway:table', context.Table);
  }

  // User-defined placeholders (can override built-ins)
  for (const [key, value] of Object.entries(userPlaceholders)) {
    map.set(key, value);
  }

  return map;
}
