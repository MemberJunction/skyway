/**
 * @module db/provider
 * Database provider interface for Skyway.
 *
 * The `DatabaseProvider` abstracts all database-specific operations so that
 * the core Skyway engine can work with any supported database platform.
 * Each provider encapsulates:
 * - Connection lifecycle management
 * - Transaction creation and execution
 * - History table DDL and CRUD
 * - Schema cleanup (Clean) operations
 * - Database creation/deletion
 * - SQL script splitting (GO for SQL Server, single-batch for PG)
 */

import { SQLBatch } from '../executor/sql-splitter';
import { HistoryRecord } from '../history/types';
import { DatabaseConfig } from './types';

/**
 * Supported database dialects.
 */
export type DatabaseDialect = 'sqlserver' | 'postgresql';

/**
 * Core abstraction for all database operations.
 *
 * Each supported database platform provides an implementation of this
 * interface in its own package (e.g., `@memberjunction/skyway-sqlserver`,
 * `@memberjunction/skyway-postgres`).
 */
export interface DatabaseProvider {
  // ─── Connection Lifecycle ──────────────────────────────────────────

  /**
   * Opens the connection to the database.
   * Must be called before any other operations.
   * Safe to call multiple times — subsequent calls are no-ops if already connected.
   */
  Connect(): Promise<void>;

  /**
   * Closes the connection and releases all resources.
   * Safe to call multiple times.
   */
  Disconnect(): Promise<void>;

  /** Returns true if the provider is currently connected. */
  readonly IsConnected: boolean;

  // ─── Database-Level Operations ─────────────────────────────────────

  /**
   * Checks whether the specified database exists on the server.
   * Connects to a system database (e.g., `master` or `postgres`) to check.
   */
  DatabaseExists(dbName: string): Promise<boolean>;

  /**
   * Creates a new database on the server.
   * Connects to a system database to execute CREATE DATABASE.
   */
  CreateDatabase(dbName: string): Promise<void>;

  /**
   * Drops the specified database.
   * Connects to a system database to execute DROP DATABASE.
   *
   * **WARNING**: This is destructive and irreversible!
   */
  DropDatabase(dbName: string): Promise<void>;

  // ─── Transaction Management ────────────────────────────────────────

  /**
   * Begins a new transaction and returns a handle for executing
   * SQL within that transaction.
   */
  BeginTransaction(): Promise<ProviderTransaction>;

  // ─── Direct Execution (no transaction) ─────────────────────────────

  /**
   * Executes a SQL statement outside of any transaction context.
   * Used for DDL that must run outside transactions, or for
   * operations that don't need transactional safety.
   */
  Execute(sql: string): Promise<void>;

  /**
   * Executes a SQL query and returns the result rows.
   * Used for SELECT-style queries outside of a transaction.
   */
  Query<T = Record<string, unknown>>(sql: string): Promise<T[]>;

  // ─── Dialect Info ──────────────────────────────────────────────────

  /** The database dialect this provider targets. */
  readonly Dialect: DatabaseDialect;

  /** The default schema name for this dialect ('dbo' for SQL Server, 'public' for PG). */
  readonly DefaultSchema: string;

  /** The default connection port for this dialect (1433 for SQL Server, 5432 for PG). */
  readonly DefaultPort: number;

  /**
   * The database connection config this provider was constructed with.
   *
   * Skyway uses this as a fallback when `SkywayConfig.Database` isn't passed —
   * letting callers supply connection details once via the provider rather than
   * duplicating them in `SkywayConfig.Database`. Read-only; mutating the
   * returned object has no effect on the live provider.
   */
  readonly Config: DatabaseConfig;

  // ─── Script Splitting ──────────────────────────────────────────────

  /**
   * Splits a SQL script into executable batches according to dialect rules.
   *
   * - **SQL Server**: Splits on `GO` batch separators.
   * - **PostgreSQL**: Returns the entire script as a single batch
   *   (PG does not use batch separators).
   */
  SplitScript(script: string): SQLBatch[];

  // ─── History Table Management ──────────────────────────────────────

  /**
   * Provides dialect-specific CRUD operations for the Flyway-compatible
   * schema history table.
   */
  readonly History: HistoryTableProvider;

  // ─── Schema Cleanup ────────────────────────────────────────────────

  /**
   * Returns an ordered list of SQL statements to drop all objects
   * in the specified schema (FK constraints, views, procedures,
   * functions, types, tables).
   *
   * The caller executes each statement and uses the label for logging.
   */
  GetCleanOperations(schema: string): Promise<CleanOperation[]>;

  /**
   * Drops the specified schema itself (after all objects have been removed).
   * Implementations should skip built-in schemas (e.g., `dbo`, `public`).
   */
  DropSchema(schema: string): Promise<void>;
}

// ─── Transaction ───────────────────────────────────────────────────────

/**
 * Handle for executing SQL within a transaction.
 *
 * Created by `DatabaseProvider.BeginTransaction()`. The caller must
 * call either `Commit()` or `Rollback()` when done.
 */
export interface ProviderTransaction {
  /** Executes a SQL statement within this transaction. */
  Execute(sql: string): Promise<void>;

  /** Executes a SQL query within this transaction and returns result rows. */
  Query<T = Record<string, unknown>>(sql: string): Promise<T[]>;

  /** Commits the transaction. */
  Commit(): Promise<void>;

  /** Rolls back the transaction. */
  Rollback(): Promise<void>;
}

// ─── History Table Provider ────────────────────────────────────────────

/**
 * Dialect-specific operations for the `flyway_schema_history` table.
 *
 * Each database provider implements this with the appropriate DDL,
 * quoting, parameterization, and system catalog queries for its platform.
 */
export interface HistoryTableProvider {
  /**
   * Creates the schema (if needed) and history table (if it doesn't exist).
   * Also creates the success index matching Flyway's schema.
   */
  EnsureExists(schema: string, tableName: string, txn?: ProviderTransaction): Promise<void>;

  /** Returns true if the history table exists in the database. */
  Exists(schema: string, tableName: string): Promise<boolean>;

  /** Retrieves all records from the history table, ordered by installed_rank. */
  GetAllRecords(schema: string, tableName: string, txn?: ProviderTransaction): Promise<HistoryRecord[]>;

  /** Returns the next available installed_rank value. */
  GetNextRank(schema: string, tableName: string, txn?: ProviderTransaction): Promise<number>;

  /**
   * Inserts a record into the history table.
   * Used for applied migrations, schema markers, baselines, and failed entries.
   */
  InsertRecord(
    schema: string,
    tableName: string,
    record: HistoryInsertParams,
    txn?: ProviderTransaction
  ): Promise<void>;

  /** Deletes a record from the history table by installed_rank. */
  DeleteRecord(
    schema: string,
    tableName: string,
    installedRank: number,
    txn?: ProviderTransaction
  ): Promise<void>;

  /** Updates the checksum of a record in the history table. */
  UpdateChecksum(
    schema: string,
    tableName: string,
    installedRank: number,
    newChecksum: number,
    txn?: ProviderTransaction
  ): Promise<void>;
}

// ─── Supporting Types ──────────────────────────────────────────────────

/**
 * Parameters for inserting a record into the history table.
 * This is the dialect-agnostic representation — each provider
 * maps these to its own parameterized query format.
 */
export interface HistoryInsertParams {
  InstalledRank: number;
  Version: string | null;
  Description: string;
  Type: string;
  Script: string;
  Checksum: number | null;
  InstalledBy: string;
  ExecutionTime: number;
  Success: boolean;
}

/**
 * A single cleanup operation returned by `GetCleanOperations()`.
 */
export interface CleanOperation {
  /** The SQL statement to execute (e.g., DROP TABLE, ALTER TABLE DROP CONSTRAINT). */
  SQL: string;

  /** Human-readable label for logging (e.g., "FK constraint [fk_name] on [schema].[table]"). */
  Label: string;
}
