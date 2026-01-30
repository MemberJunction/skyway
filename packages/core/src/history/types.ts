/**
 * @module history/types
 * Type definitions for the Flyway schema history table records.
 */

/**
 * The type column values used by Flyway in the history table.
 *
 * - `'SCHEMA'` — Schema creation marker (installed_rank 0)
 * - `'SQL'` — A versioned SQL migration
 * - `'SQL_BASELINE'` — A baseline SQL migration
 * - `'BASELINE'` — A baseline marker (non-SQL)
 */
export type HistoryRecordType = 'SCHEMA' | 'SQL' | 'SQL_BASELINE' | 'BASELINE';

/**
 * A single row from the `flyway_schema_history` table.
 * Field names match the database column names exactly.
 */
export interface HistoryRecord {
  /** Sequential rank of this migration (primary key) */
  InstalledRank: number;

  /** Version string (null for repeatable and schema creation entries) */
  Version: string | null;

  /** Human-readable description */
  Description: string;

  /** Type of migration record */
  Type: HistoryRecordType;

  /** Relative path to the migration script file */
  Script: string;

  /** CRC32 checksum of the migration file (null for schema creation) */
  Checksum: number | null;

  /** Database user who ran this migration */
  InstalledBy: string;

  /** When this migration was applied */
  InstalledOn: Date;

  /** Execution time in milliseconds */
  ExecutionTime: number;

  /** Whether the migration succeeded */
  Success: boolean;
}
