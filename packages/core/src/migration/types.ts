/**
 * @module migration/types
 * Type definitions for migration files and their metadata.
 */

/**
 * The category of a migration file, determined by its filename prefix.
 *
 * - `'versioned'` — `V` prefix. Runs once, tracked by version number.
 * - `'baseline'` — `B` prefix. Runs only on empty databases.
 * - `'repeatable'` — `R__` prefix. Runs after versioned migrations when checksum changes.
 */
export type MigrationType = 'versioned' | 'baseline' | 'repeatable';

/**
 * Metadata parsed from a migration filename.
 * Does not include file contents or checksum — those are resolved lazily.
 */
export interface MigrationInfo {
  /** The migration type: versioned, baseline, or repeatable */
  Type: MigrationType;

  /**
   * The version string extracted from the filename (e.g., "202601122300").
   * Null for repeatable migrations which have no version.
   */
  Version: string | null;

  /** Human-readable description derived from the filename (underscores → spaces) */
  Description: string;

  /** The original filename (basename only, no directory path) */
  Filename: string;

  /** Absolute path to the migration file on disk */
  FilePath: string;

  /**
   * Relative path from the migration root for recording in the history table.
   * Matches Flyway's `script` column format (e.g., "v3/V202601200000__desc.sql").
   */
  ScriptPath: string;
}

/**
 * A fully resolved migration ready for execution.
 * Includes the file contents and computed checksum.
 */
export interface ResolvedMigration extends MigrationInfo {
  /** Raw SQL content of the migration file (before placeholder substitution) */
  SQL: string;

  /**
   * CRC32 checksum of the normalized file content.
   * Computed using the same algorithm as Flyway (Java CRC32)
   * for compatibility with existing history tables.
   */
  Checksum: number;
}

/**
 * The state of a migration relative to the database.
 */
export type MigrationState =
  | 'PENDING'          // Discovered on disk but not yet applied
  | 'APPLIED'          // Successfully applied to the database
  | 'MISSING'          // In history table but not found on disk
  | 'FAILED'           // Recorded as failed in history table
  | 'OUTDATED'         // Repeatable migration with changed checksum
  | 'BASELINE'         // Applied as a baseline migration
  | 'ABOVE_BASELINE';  // Version is above baseline, skipped

/**
 * Combined view of a migration's disk info and database state.
 * Used by the `Info` command to display migration status.
 */
export interface MigrationStatus {
  /** Migration type */
  Type: MigrationType;

  /** Version string, or null for repeatable */
  Version: string | null;

  /** Human-readable description */
  Description: string;

  /** Current state relative to the database */
  State: MigrationState;

  /** Script path (filename relative to migration root) */
  Script: string;

  /** Checksum from disk (null if file not found) */
  DiskChecksum: number | null;

  /** Checksum from history table (null if not applied) */
  AppliedChecksum: number | null;

  /** When this migration was applied, if ever */
  InstalledOn: Date | null;

  /** Execution time in milliseconds, if applied */
  ExecutionTime: number | null;
}
