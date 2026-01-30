/**
 * @module @skyway/core
 *
 * Skyway — A TypeScript-native Flyway-compatible database migration engine
 * for SQL Server.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Skyway } from '@skyway/core';
 *
 * const skyway = new Skyway({
 *   Database: {
 *     Server: 'localhost',
 *     Database: 'my_app',
 *     User: 'sa',
 *     Password: 'secret',
 *   },
 *   Migrations: {
 *     Locations: ['./migrations'],
 *     DefaultSchema: 'dbo',
 *     BaselineOnMigrate: true,
 *   },
 *   TransactionMode: 'per-run',
 * });
 *
 * const result = await skyway.Migrate();
 * console.log(`Applied ${result.MigrationsApplied} migrations`);
 *
 * await skyway.Close();
 * ```
 *
 * @packageDocumentation
 */

// ─── Main API ────────────────────────────────────────────────────────
export { Skyway, MigrateResult, ValidateResult, CleanResult, BaselineResult, RepairResult, SkywayCallbacks } from './core/skyway';

// ─── Configuration ───────────────────────────────────────────────────
export { SkywayConfig, MigrationConfig, TransactionMode } from './core/config';

// ─── Database ────────────────────────────────────────────────────────
export { DatabaseConfig, DatabaseConnectionOptions } from './db/types';
export { ConnectionManager } from './db/connection';

// ─── Migration Types ─────────────────────────────────────────────────
export {
  MigrationType,
  MigrationInfo,
  ResolvedMigration,
  MigrationState,
  MigrationStatus,
} from './migration/types';

// ─── Migration Utilities ─────────────────────────────────────────────
export { ParseMigrationFilename } from './migration/parser';
export { ComputeChecksum } from './migration/checksum';
export {
  ScanMigrations,
  ResolveMigration,
  ScanAndResolveMigrations,
} from './migration/scanner';
export { ResolveMigrations } from './migration/resolver';

// ─── Executor ────────────────────────────────────────────────────────
export { SplitOnGO, SQLBatch } from './executor/sql-splitter';
export { SubstitutePlaceholders, PlaceholderContext } from './executor/placeholder';
export { MigrationExecutionResult, ExecutionCallbacks } from './executor/executor';

// ─── History ─────────────────────────────────────────────────────────
export { HistoryTable } from './history/history-table';
export { HistoryRecord, HistoryRecordType } from './history/types';

// ─── Errors ──────────────────────────────────────────────────────────
export {
  SkywayError,
  MigrationExecutionError,
  MigrationParseError,
  ChecksumMismatchError,
  TransactionError,
  ConnectionError,
} from './core/errors';
