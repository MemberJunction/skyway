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
 * Definition of a user-defined extra column on the history table.
 *
 * Skyway creates the column during `EnsureExists` and, when `Value` is
 * supplied, writes it into every history row inserted during the run.
 * Columns without a `Value` must be nullable or carry a `DefaultValue` so
 * inserts don't fail.
 *
 * Example — stamp each history row with the `CompanyIntegrationID` that
 * triggered the run:
 * ```typescript
 * HistoryExtraColumns: [
 *   { Name: 'CompanyIntegrationID', SqlType: 'UNIQUEIDENTIFIER', IsNullable: false, Value: companyIntegrationId }
 * ]
 * ```
 */
export interface HistoryExtraColumn {
  /** Column name. */
  Name: string;

  /** Raw SQL type, e.g. `UNIQUEIDENTIFIER`, `NVARCHAR(200)`, `INT`. */
  SqlType: string;

  /** Whether the column allows NULL. Defaults to `true`. */
  IsNullable?: boolean;

  /**
   * SQL literal used as the column's DEFAULT, e.g. `NEWID()`, `GETUTCDATE()`,
   * `N'Unknown'`. Written verbatim into the `CREATE TABLE` clause.
   */
  DefaultValue?: string;

  /**
   * Value to stamp into this column on every history row written during the
   * run. Bound as a SQL parameter (safe against injection). If omitted, the
   * column falls through to its `DefaultValue` or NULL.
   */
  Value?: unknown;

  /** Optional human-readable description (currently informational only). */
  Description?: string;
}

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
