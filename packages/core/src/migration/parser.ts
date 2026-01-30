/**
 * @module migration/parser
 * Parses migration filenames into structured metadata.
 *
 * Supports the three Flyway filename conventions:
 * - Versioned:  `V{version}__{description}.sql`
 * - Baseline:   `B{version}__{description}.sql`
 * - Repeatable:  `R__{description}.sql`
 *
 * The version is typically a timestamp like `202601122300` but can be
 * any sortable numeric string. The description uses underscores as
 * word separators, which are converted to spaces for display.
 */

import * as path from 'path';
import { MigrationInfo, MigrationType } from './types';
import { MigrationParseError } from '../core/errors';

/**
 * Regex for versioned (`V`) and baseline (`B`) migration filenames.
 *
 * Groups:
 *  1. Prefix character (`V` or `B`, case-insensitive)
 *  2. Version string (digits, dots, underscores before the double-underscore)
 *  3. Description (everything between `__` and `.sql`)
 */
const VERSIONED_PATTERN = /^([VvBb])(\d[\w.]*)__(.+)\.sql$/;

/**
 * Regex for repeatable (`R__`) migration filenames.
 *
 * Groups:
 *  1. Description (everything between `R__` and `.sql`)
 */
const REPEATABLE_PATTERN = /^[Rr]__(.+)\.sql$/;

/**
 * Parses a migration filename into structured metadata.
 *
 * @param filePath - Absolute path to the migration file
 * @param migrationRoot - Root directory of the migration location, used to compute the relative script path
 * @returns Parsed migration info
 * @throws MigrationParseError if the filename does not match any known pattern
 *
 * @example
 * ```typescript
 * const info = ParseMigrationFilename(
 *   '/workspace/MJ/migrations/v3/V202601200000__v3.1.x__Add_Table.sql',
 *   '/workspace/MJ/migrations'
 * );
 * // info.Type === 'versioned'
 * // info.Version === '202601200000'
 * // info.Description === 'v3.1.x  Add Table'
 * ```
 */
export function ParseMigrationFilename(
  filePath: string,
  migrationRoot: string
): MigrationInfo {
  const filename = path.basename(filePath);

  // Try repeatable pattern first (simpler, no version)
  const repeatableMatch = filename.match(REPEATABLE_PATTERN);
  if (repeatableMatch) {
    return {
      Type: 'repeatable',
      Version: null,
      Description: formatDescription(repeatableMatch[1]),
      Filename: filename,
      FilePath: filePath,
      ScriptPath: computeScriptPath(filePath, migrationRoot),
    };
  }

  // Try versioned / baseline pattern
  const versionedMatch = filename.match(VERSIONED_PATTERN);
  if (versionedMatch) {
    const prefix = versionedMatch[1].toUpperCase();
    const type: MigrationType = prefix === 'B' ? 'baseline' : 'versioned';

    return {
      Type: type,
      Version: versionedMatch[2],
      Description: formatDescription(versionedMatch[3]),
      Filename: filename,
      FilePath: filePath,
      ScriptPath: computeScriptPath(filePath, migrationRoot),
    };
  }

  throw new MigrationParseError(
    filename,
    `Cannot parse migration filename "${filename}". Expected format: ` +
      `V{version}__{description}.sql, B{version}__{description}.sql, or R__{description}.sql`
  );
}

/**
 * Converts a filename description segment to a human-readable string.
 * Replaces underscores with spaces, matching Flyway's behavior.
 *
 * @param raw - Raw description from filename (e.g., "Add_Users_Table")
 * @returns Formatted description (e.g., "Add Users Table")
 */
function formatDescription(raw: string): string {
  return raw.replace(/_/g, ' ');
}

/**
 * Computes the script path relative to the migration root directory.
 * Uses forward slashes for consistency (matching Flyway's format).
 *
 * @param filePath - Absolute file path
 * @param migrationRoot - Migration root directory
 * @returns Relative path like "v3/V202601200000__desc.sql"
 */
function computeScriptPath(filePath: string, migrationRoot: string): string {
  const relative = path.relative(migrationRoot, filePath);
  // Normalize to forward slashes for cross-platform consistency
  return relative.replace(/\\/g, '/');
}
