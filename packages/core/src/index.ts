/**
 * @module @memberjunction/skyway-core
 *
 * Skyway — A TypeScript-native Flyway-compatible database migration engine.
 *
 * This is the core package containing the `Skyway` class, provider interfaces,
 * migration types, and utilities. To connect to a specific database, install
 * a provider package:
 *
 * - `@memberjunction/skyway-sqlserver` — SQL Server (mssql/tedious)
 * - `@memberjunction/skyway-postgres` — PostgreSQL (pg)
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Skyway } from '@memberjunction/skyway-core';
 * import { SqlServerProvider } from '@memberjunction/skyway-sqlserver';
 *
 * const provider = new SqlServerProvider({
 *   Server: 'localhost',
 *   Database: 'my_app',
 *   User: 'sa',
 *   Password: 'secret',
 * });
 *
 * const skyway = new Skyway({
 *   Database: { Server: 'localhost', Database: 'my_app', User: 'sa', Password: 'secret' },
 *   Migrations: { Locations: ['./migrations'], DefaultSchema: 'dbo' },
 *   Provider: provider,
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
export {
  Skyway,
  MigrateResult,
  MigrationExecutionResult,
  ValidateResult,
  CleanResult,
  BaselineResult,
  RepairResult,
  SkywayCallbacks,
} from './core/skyway';

// ─── Provider Interface ─────────────────────────────────────────────
export {
  DatabaseProvider,
  DatabaseDialect,
  ProviderTransaction,
  HistoryTableProvider,
  HistoryInsertParams,
  CleanOperation,
} from './db/provider';

// ─── Configuration ───────────────────────────────────────────────────
export { SkywayConfig, MigrationConfig, TransactionMode, ResolvedSkywayConfig } from './core/config';

// ─── Database Types ──────────────────────────────────────────────────
export { DatabaseConfig, DatabaseConnectionOptions } from './db/types';

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

// ─── Executor Utilities ──────────────────────────────────────────────
export { SplitOnGO, SQLBatch } from './executor/sql-splitter';
export { SubstitutePlaceholders, PlaceholderContext } from './executor/placeholder';

// ─── History Types ───────────────────────────────────────────────────
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
