/**
 * @module core/config
 * Skyway configuration types and defaults.
 */

import { DatabaseConfig } from '../db/types';

/**
 * Controls how transactions are applied during a migration run.
 *
 * - `'per-run'` — Wraps the entire migration run in a single transaction.
 *   If any migration fails, ALL migrations in the run are rolled back.
 *   This is the safest mode and the Skyway default.
 *
 * - `'per-migration'` — Each migration file runs in its own transaction.
 *   If migration 5 of 10 fails, migrations 1-4 remain committed and
 *   only migration 5 is rolled back. Matches Flyway's default behavior.
 */
export type TransactionMode = 'per-run' | 'per-migration';

/**
 * Complete configuration for a Skyway migration run.
 */
export interface SkywayConfig {
  /** SQL Server connection settings */
  Database: DatabaseConfig;

  /** Migration file discovery and execution settings */
  Migrations: MigrationConfig;

  /**
   * Placeholder key-value pairs for substitution in migration SQL.
   *
   * Only placeholders registered here (or built-in `flyway:*` placeholders)
   * are substituted. All other `$\{...\}` patterns are left untouched,
   * which is a key improvement over Flyway's aggressive replacement.
   *
   * @example
   * ```typescript
   * {
   *   'flyway:defaultSchema': '__mj',
   *   'appVersion': '3.0.0'
   * }
   * ```
   */
  Placeholders?: Record<string, string>;

  /**
   * Transaction mode for migration execution.
   * Defaults to `'per-run'` (all-or-nothing).
   */
  TransactionMode?: TransactionMode;

  /**
   * When true, Migrate() will log pending migrations without executing them.
   * Defaults to false.
   */
  DryRun?: boolean;
}

/**
 * Configuration for migration file discovery and execution behavior.
 */
export interface MigrationConfig {
  /**
   * Filesystem paths to scan recursively for migration SQL files.
   * Supports absolute and relative paths.
   *
   * @example `['./migrations']` or `['/workspace/MJ/migrations']`
   */
  Locations: string[];

  /**
   * The default database schema for migration objects.
   * Used as the value for `$\{flyway:defaultSchema\}` placeholder
   * and as the schema for the history table.
   *
   * Defaults to `'dbo'`.
   */
  DefaultSchema?: string;

  /**
   * Name of the schema history table.
   * Defaults to `'flyway_schema_history'` for Flyway compatibility.
   */
  HistoryTable?: string;

  /**
   * Version string for baseline migrations.
   * When `BaselineOnMigrate` is true and the database has no history,
   * a baseline entry is recorded at this version.
   */
  BaselineVersion?: string;

  /**
   * Whether to automatically apply baseline migrations on an empty database.
   * When true, `B`-prefixed migration files matching the BaselineVersion
   * are executed on databases with no prior migration history.
   *
   * Defaults to false.
   */
  BaselineOnMigrate?: boolean;

  /**
   * Whether to allow out-of-order migration execution.
   * When true, migrations with versions lower than the current latest
   * applied version can still be executed.
   *
   * Defaults to false.
   */
  OutOfOrder?: boolean;
}

/**
 * Merges user-provided config with sensible defaults.
 * @param config - Partial configuration provided by the user
 * @returns Complete configuration with all defaults applied
 */
export function resolveConfig(config: SkywayConfig): Required<SkywayConfig> & { Migrations: Required<MigrationConfig> } {
  return {
    Database: config.Database,
    Migrations: {
      Locations: config.Migrations.Locations,
      DefaultSchema: config.Migrations.DefaultSchema ?? 'dbo',
      HistoryTable: config.Migrations.HistoryTable ?? 'flyway_schema_history',
      BaselineVersion: config.Migrations.BaselineVersion ?? '1',
      BaselineOnMigrate: config.Migrations.BaselineOnMigrate ?? false,
      OutOfOrder: config.Migrations.OutOfOrder ?? false,
    },
    Placeholders: config.Placeholders ?? {},
    TransactionMode: config.TransactionMode ?? 'per-run',
    DryRun: config.DryRun ?? false,
  };
}
