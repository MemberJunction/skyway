/**
 * @module migration/scanner
 * Discovers migration SQL files on disk by recursively scanning
 * configured migration directories.
 *
 * Files are filtered to `.sql` extension and parsed using the
 * filename parser. Invalid filenames are logged as warnings but
 * do not halt the scan — matching Flyway's `validateMigrationNaming=false`
 * default behavior.
 */

import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import { MigrationInfo, ResolvedMigration } from './types';
import { ParseMigrationFilename } from './parser';
import { ComputeChecksum } from './checksum';

/**
 * Callback for reporting non-fatal scan issues (e.g., unparseable filenames).
 */
export type ScanWarningCallback = (message: string) => void;

/**
 * Recursively scans the given directories for `.sql` migration files,
 * parses their filenames, and returns structured metadata.
 *
 * Files that do not match any known migration naming pattern are
 * silently skipped (or reported via the optional warning callback).
 *
 * @param locations - Array of directory paths to scan
 * @param onWarning - Optional callback for non-fatal warnings
 * @returns Array of parsed migration info objects, unsorted
 *
 * @example
 * ```typescript
 * const migrations = await ScanMigrations(['/workspace/MJ/migrations']);
 * console.log(`Found ${migrations.length} migration files`);
 * ```
 */
export async function ScanMigrations(
  locations: string[],
  onWarning?: ScanWarningCallback
): Promise<MigrationInfo[]> {
  const results: MigrationInfo[] = [];

  for (const location of locations) {
    const resolvedLocation = path.resolve(location);

    if (!fs.existsSync(resolvedLocation)) {
      onWarning?.(`Migration location does not exist: ${resolvedLocation}`);
      continue;
    }

    // Use fast-glob to recursively find all .sql files
    const sqlFiles = await fg('**/*.sql', {
      cwd: resolvedLocation,
      absolute: true,
      onlyFiles: true,
    });

    for (const filePath of sqlFiles) {
      try {
        const info = ParseMigrationFilename(filePath, resolvedLocation);
        results.push(info);
      } catch (err) {
        // Non-fatal: skip files with unrecognized naming patterns
        const message = err instanceof Error ? err.message : String(err);
        onWarning?.(message);
      }
    }
  }

  return results;
}

/**
 * Reads a migration file from disk and computes its checksum,
 * producing a fully resolved migration ready for execution.
 *
 * @param info - Parsed migration info (from scanner or parser)
 * @returns Resolved migration with SQL content and checksum
 */
export async function ResolveMigration(
  info: MigrationInfo
): Promise<ResolvedMigration> {
  const content = await fs.promises.readFile(info.FilePath, 'utf-8');
  const checksum = ComputeChecksum(content);

  return {
    ...info,
    SQL: content,
    Checksum: checksum,
  };
}

/**
 * Scans directories and fully resolves all discovered migrations
 * (reads file contents and computes checksums).
 *
 * This is a convenience function combining ScanMigrations + ResolveMigration.
 *
 * @param locations - Array of directory paths to scan
 * @param onWarning - Optional callback for non-fatal warnings
 * @returns Array of fully resolved migrations, unsorted
 */
export async function ScanAndResolveMigrations(
  locations: string[],
  onWarning?: ScanWarningCallback
): Promise<ResolvedMigration[]> {
  const infos = await ScanMigrations(locations, onWarning);
  const resolved = await Promise.all(infos.map(ResolveMigration));
  return resolved;
}
