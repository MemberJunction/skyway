/**
 * @module core/skyway
 * Main orchestrator for Skyway migration operations.
 *
 * The `Skyway` class is the primary public API for programmatic usage.
 * It coordinates scanning, resolving, executing, and recording migrations.
 *
 * @example
 * ```typescript
 * import { Skyway } from '@skyway/core';
 *
 * const skyway = new Skyway({
 *   Database: { Server: 'localhost', Database: 'mydb', User: 'sa', Password: 'secret' },
 *   Migrations: { Locations: ['./migrations'], DefaultSchema: '__mj' },
 *   Placeholders: { 'flyway:defaultSchema': '__mj' },
 *   TransactionMode: 'per-run',
 * });
 *
 * const result = await skyway.Migrate();
 * console.log(`Applied ${result.MigrationsApplied} migrations`);
 *
 * await skyway.Close();
 * ```
 */

import * as sql from 'mssql';
import { SkywayConfig, MigrationConfig, resolveConfig, TransactionMode } from './config';
import { ConnectionManager } from '../db/connection';
import { HistoryTable } from '../history/history-table';
import { HistoryRecord } from '../history/types';
import { ScanAndResolveMigrations } from '../migration/scanner';
import { ResolveMigrations, ResolverResult } from '../migration/resolver';
import { ResolvedMigration, MigrationStatus } from '../migration/types';
import { ExecuteMigrations, MigrationExecutionResult, ExecutionCallbacks } from '../executor/executor';
import { PlaceholderContext } from '../executor/placeholder';

/**
 * Result of a `Migrate()` operation.
 */
export interface MigrateResult {
  /** Number of migrations successfully applied */
  MigrationsApplied: number;

  /** Total execution time in milliseconds */
  TotalExecutionTimeMS: number;

  /** Current schema version after migration (null if no versioned migrations) */
  CurrentVersion: string | null;

  /** Detailed results for each migration executed */
  Details: MigrationExecutionResult[];

  /** Whether the run completed successfully (all migrations passed) */
  Success: boolean;

  /** Error message if the run failed */
  ErrorMessage?: string;
}

/**
 * Result of a `Validate()` operation.
 */
export interface ValidateResult {
  /** Whether all validations passed */
  Valid: boolean;

  /** List of validation error messages */
  Errors: string[];
}

/**
 * Callback interface for observing migration progress.
 */
export interface SkywayCallbacks {
  /** Called when a migration starts executing */
  OnMigrationStart?: (migration: ResolvedMigration) => void;

  /** Called when a migration finishes (success or failure) */
  OnMigrationEnd?: (result: MigrationExecutionResult) => void;

  /** Called for informational log messages */
  OnLog?: (message: string) => void;
}

/**
 * The main Skyway migration engine.
 *
 * Provides the full Flyway-compatible migration workflow:
 * - `Migrate()` — Apply pending migrations
 * - `Info()` — Get migration status report
 * - `Validate()` — Verify checksums of applied migrations
 * - `Clean()` — Drop all objects in the schema (destructive!)
 * - `CreateDatabase()` / `DropDatabase()` — Database lifecycle management
 */
export class Skyway {
  private readonly config: ReturnType<typeof resolveConfig>;
  private readonly connectionManager: ConnectionManager;
  private historyTable: HistoryTable | null = null;
  private callbacks: SkywayCallbacks = {};

  constructor(config: SkywayConfig) {
    this.config = resolveConfig(config);
    this.connectionManager = new ConnectionManager(this.config.Database);
  }

  /**
   * Registers callbacks for observing migration progress.
   * Returns `this` for chaining.
   *
   * @example
   * ```typescript
   * skyway
   *   .OnProgress({
   *     OnLog: (msg) => console.log(msg),
   *     OnMigrationEnd: (r) => console.log(`${r.Migration.Version}: ${r.Success ? 'OK' : 'FAIL'}`),
   *   })
   *   .Migrate();
   * ```
   */
  OnProgress(callbacks: SkywayCallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  /**
   * Applies all pending migrations to the database.
   *
   * The workflow:
   * 1. Connect to the database
   * 2. Ensure the history table exists
   * 3. Scan migration directories for `.sql` files
   * 4. Resolve which migrations are pending
   * 5. Execute pending migrations within a transaction
   * 6. Record each migration in the history table
   *
   * @returns Migration result with counts and details
   */
  async Migrate(): Promise<MigrateResult> {
    const startTime = Date.now();

    try {
      // Connect and set up
      await this.connectionManager.Connect();
      const pool = this.connectionManager.GetPool();

      this.historyTable = new HistoryTable(
        pool,
        this.config.Migrations.DefaultSchema,
        this.config.Migrations.HistoryTable
      );

      // Ensure schema and history table exist (outside any migration transaction)
      await this.historyTable.EnsureExists();

      // Insert schema creation marker if this is a fresh table
      const existingRecords = await this.historyTable.GetAllRecords();
      if (existingRecords.length === 0) {
        await this.historyTable.InsertSchemaMarker(this.config.Database.User);
        this.callbacks.OnLog?.(`Created schema [${this.config.Migrations.DefaultSchema}]`);
      }

      // Scan and resolve migrations
      this.callbacks.OnLog?.('Scanning migration files...');
      const discovered = await ScanAndResolveMigrations(
        this.config.Migrations.Locations,
        (warning) => this.callbacks.OnLog?.(`Warning: ${warning}`)
      );
      this.callbacks.OnLog?.(`Found ${discovered.length} migration file(s)`);

      // Re-read history (may have changed after schema creation)
      const currentHistory = await this.historyTable.GetAllRecords();

      const resolution = ResolveMigrations(
        discovered,
        currentHistory,
        this.config.Migrations.BaselineVersion,
        this.config.Migrations.BaselineOnMigrate,
        this.config.Migrations.OutOfOrder
      );

      if (resolution.PendingMigrations.length === 0) {
        this.callbacks.OnLog?.('Schema is up to date. No migrations to apply.');
        return {
          MigrationsApplied: 0,
          TotalExecutionTimeMS: Date.now() - startTime,
          CurrentVersion: this.getCurrentVersion(currentHistory),
          Details: [],
          Success: true,
        };
      }

      this.callbacks.OnLog?.(
        `${resolution.PendingMigrations.length} migration(s) pending`
      );

      // Execute migrations
      const result = await this.executeMigrationsWithHistory(
        pool,
        resolution,
        currentHistory
      );

      return {
        MigrationsApplied: result.filter((r) => r.Success).length,
        TotalExecutionTimeMS: Date.now() - startTime,
        CurrentVersion: this.getNewCurrentVersion(result, currentHistory),
        Details: result,
        Success: result.every((r) => r.Success),
        ErrorMessage: result.find((r) => !r.Success)?.Error?.message,
      };
    } catch (err) {
      return {
        MigrationsApplied: 0,
        TotalExecutionTimeMS: Date.now() - startTime,
        CurrentVersion: null,
        Details: [],
        Success: false,
        ErrorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Returns migration status information for all discovered and applied migrations.
   */
  async Info(): Promise<MigrationStatus[]> {
    await this.connectionManager.Connect();
    const pool = this.connectionManager.GetPool();

    this.historyTable = new HistoryTable(
      pool,
      this.config.Migrations.DefaultSchema,
      this.config.Migrations.HistoryTable
    );

    const discovered = await ScanAndResolveMigrations(
      this.config.Migrations.Locations
    );

    let applied: HistoryRecord[] = [];
    if (await this.historyTable.Exists()) {
      applied = await this.historyTable.GetAllRecords();
    }

    const resolution = ResolveMigrations(
      discovered,
      applied,
      this.config.Migrations.BaselineVersion,
      this.config.Migrations.BaselineOnMigrate,
      this.config.Migrations.OutOfOrder
    );

    return resolution.StatusReport;
  }

  /**
   * Validates that applied migrations match the current files on disk.
   * Checks checksums for all applied versioned migrations.
   */
  async Validate(): Promise<ValidateResult> {
    await this.connectionManager.Connect();
    const pool = this.connectionManager.GetPool();

    this.historyTable = new HistoryTable(
      pool,
      this.config.Migrations.DefaultSchema,
      this.config.Migrations.HistoryTable
    );

    const errors: string[] = [];

    if (!(await this.historyTable.Exists())) {
      return { Valid: true, Errors: [] };
    }

    const applied = await this.historyTable.GetAllRecords();
    const discovered = await ScanAndResolveMigrations(
      this.config.Migrations.Locations
    );

    // Build lookup by version
    const diskByVersion = new Map<string, ResolvedMigration>();
    for (const m of discovered) {
      if (m.Version) {
        diskByVersion.set(m.Version, m);
      }
    }

    for (const record of applied) {
      if (record.Version === null || record.Type === 'SCHEMA') continue;

      const diskMigration = diskByVersion.get(record.Version);
      if (!diskMigration) {
        errors.push(
          `Migration version ${record.Version} (${record.Description}) ` +
            `was applied but is no longer found on disk`
        );
        continue;
      }

      if (
        record.Checksum !== null &&
        record.Checksum !== diskMigration.Checksum
      ) {
        errors.push(
          `Checksum mismatch for version ${record.Version} (${record.Description}): ` +
            `expected ${record.Checksum} but computed ${diskMigration.Checksum}`
        );
      }
    }

    return {
      Valid: errors.length === 0,
      Errors: errors,
    };
  }

  /**
   * Creates the target database if it doesn't already exist.
   * Connects to the `master` database to execute CREATE DATABASE.
   */
  async CreateDatabase(): Promise<void> {
    const dbName = this.config.Database.Database;
    const masterPool = await this.connectionManager.ConnectToMaster();

    try {
      const request = new sql.Request(masterPool);
      const result = await request.query(
        `SELECT DB_ID('${dbName}') AS dbid`
      );

      if (result.recordset[0].dbid === null) {
        this.callbacks.OnLog?.(`Creating database [${dbName}]...`);
        const createRequest = new sql.Request(masterPool);
        await createRequest.batch(`CREATE DATABASE [${dbName}]`);
        this.callbacks.OnLog?.(`Database [${dbName}] created`);
      } else {
        this.callbacks.OnLog?.(`Database [${dbName}] already exists`);
      }
    } finally {
      await masterPool.close();
    }
  }

  /**
   * Drops the target database if it exists.
   * Connects to the `master` database to execute DROP DATABASE.
   *
   * **WARNING**: This is destructive and irreversible!
   */
  async DropDatabase(): Promise<void> {
    const dbName = this.config.Database.Database;
    const masterPool = await this.connectionManager.ConnectToMaster();

    try {
      const request = new sql.Request(masterPool);
      const result = await request.query(
        `SELECT DB_ID('${dbName}') AS dbid`
      );

      if (result.recordset[0].dbid !== null) {
        this.callbacks.OnLog?.(`Dropping database [${dbName}]...`);
        const dropRequest = new sql.Request(masterPool);
        await dropRequest.batch(`
          ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
          DROP DATABASE [${dbName}];
        `);
        this.callbacks.OnLog?.(`Database [${dbName}] dropped`);
      } else {
        this.callbacks.OnLog?.(`Database [${dbName}] does not exist`);
      }
    } finally {
      await masterPool.close();
    }
  }

  /**
   * Closes the database connection pool.
   * Should be called when done with the Skyway instance.
   */
  async Close(): Promise<void> {
    await this.connectionManager.Disconnect();
  }

  // ─── Private Methods ──────────────────────────────────────────────

  /**
   * Executes pending migrations and records results in the history table.
   * Handles both per-run and per-migration transaction modes.
   */
  private async executeMigrationsWithHistory(
    pool: sql.ConnectionPool,
    resolution: ResolverResult,
    existingHistory: HistoryRecord[]
  ): Promise<MigrationExecutionResult[]> {
    const migrations = resolution.PendingMigrations;
    const placeholderContext = this.buildPlaceholderContext();
    const transactionMode = this.config.TransactionMode;

    if (transactionMode === 'per-run') {
      return this.executePerRunWithHistory(pool, migrations, placeholderContext);
    } else {
      return this.executePerMigrationWithHistory(pool, migrations, placeholderContext);
    }
  }

  /**
   * Per-run transaction mode: wrap everything in one transaction.
   * History records are inserted within the same transaction so they
   * roll back together with the migration SQL on failure.
   */
  private async executePerRunWithHistory(
    pool: sql.ConnectionPool,
    migrations: ResolvedMigration[],
    placeholderContext: PlaceholderContext
  ): Promise<MigrationExecutionResult[]> {
    const results: MigrationExecutionResult[] = [];
    const transaction = new sql.Transaction(pool);

    try {
      await transaction.begin();
      this.callbacks.OnLog?.('Transaction started (per-run mode — all or nothing)');

      let nextRank = await this.historyTable!.GetNextRank(transaction);

      for (const migration of migrations) {
        this.callbacks.OnMigrationStart?.(migration);
        const result = await this.executeSingleWithinTransaction(
          transaction,
          migration,
          placeholderContext
        );
        results.push(result);

        if (result.Success) {
          // Record in history within the same transaction
          await this.historyTable!.InsertAppliedMigration(
            migration,
            nextRank++,
            result.ExecutionTimeMS,
            this.config.Database.User,
            transaction
          );

          this.callbacks.OnLog?.(
            `Migrated to version ${migration.Version ?? '(repeatable)'}: ${migration.Description} (${result.ExecutionTimeMS}ms)`
          );
          this.callbacks.OnMigrationEnd?.(result);
        } else {
          // Failure — roll back everything
          this.callbacks.OnLog?.(
            `Migration FAILED: ${migration.Version ?? migration.Description} — ${result.Error?.message}`
          );
          this.callbacks.OnMigrationEnd?.(result);

          try {
            await transaction.rollback();
            this.callbacks.OnLog?.('Transaction rolled back — no migrations were applied');
          } catch (rollbackErr) {
            this.callbacks.OnLog?.(`Warning: rollback error: ${rollbackErr}`);
          }
          return results;
        }
      }

      // All succeeded — commit
      await transaction.commit();
      this.callbacks.OnLog?.('Transaction committed — all migrations applied successfully');
      return results;
    } catch (err) {
      try {
        await transaction.rollback();
      } catch {
        // Swallow
      }
      throw err;
    }
  }

  /**
   * Per-migration transaction mode: each migration gets its own transaction.
   */
  private async executePerMigrationWithHistory(
    pool: sql.ConnectionPool,
    migrations: ResolvedMigration[],
    placeholderContext: PlaceholderContext
  ): Promise<MigrationExecutionResult[]> {
    const results: MigrationExecutionResult[] = [];

    for (const migration of migrations) {
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();
        this.callbacks.OnMigrationStart?.(migration);

        const result = await this.executeSingleWithinTransaction(
          transaction,
          migration,
          placeholderContext
        );
        results.push(result);

        if (result.Success) {
          const nextRank = await this.historyTable!.GetNextRank(transaction);
          await this.historyTable!.InsertAppliedMigration(
            migration,
            nextRank,
            result.ExecutionTimeMS,
            this.config.Database.User,
            transaction
          );
          await transaction.commit();

          this.callbacks.OnLog?.(
            `Migrated to version ${migration.Version ?? '(repeatable)'}: ${migration.Description} (${result.ExecutionTimeMS}ms)`
          );
          this.callbacks.OnMigrationEnd?.(result);
        } else {
          this.callbacks.OnMigrationEnd?.(result);
          await transaction.rollback();
          this.callbacks.OnLog?.(
            `Migration rolled back: ${migration.Version ?? migration.Description}`
          );
          return results;
        }
      } catch (err) {
        try {
          await transaction.rollback();
        } catch {
          // Swallow
        }
        throw err;
      }
    }

    return results;
  }

  /**
   * Executes a single migration file within an existing transaction.
   * Handles placeholder substitution and GO splitting.
   */
  private async executeSingleWithinTransaction(
    transaction: sql.Transaction,
    migration: ResolvedMigration,
    placeholderContext: PlaceholderContext
  ): Promise<MigrationExecutionResult> {
    const { SubstitutePlaceholders } = await import('../executor/placeholder');
    const { SplitOnGO } = await import('../executor/sql-splitter');
    const { ComputeChecksum } = await import('../migration/checksum');

    const startTime = Date.now();

    try {
      // Substitute placeholders
      const context: PlaceholderContext = {
        ...placeholderContext,
        Filename: migration.Filename,
      };
      const processedSQL = SubstitutePlaceholders(
        migration.SQL,
        this.config.Placeholders,
        context
      );

      // Flyway computes repeatable migration checksums AFTER placeholder substitution.
      // This causes ${flyway:timestamp} to produce a new checksum each run,
      // ensuring repeatable migrations always re-execute.
      // Versioned/baseline migrations use the raw content checksum.
      if (migration.Type === 'repeatable') {
        migration.Checksum = ComputeChecksum(processedSQL);
      }

      // Split on GO
      const batches = SplitOnGO(processedSQL);

      this.callbacks.OnLog?.(
        `  Executing ${migration.Filename}: ${batches.length} batch(es)`
      );

      // Execute each batch
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        for (let repeat = 0; repeat < batch.RepeatCount; repeat++) {
          const request = new sql.Request(transaction);
          await request.batch(batch.SQL);
        }
      }

      return {
        Migration: migration,
        Success: true,
        ExecutionTimeMS: Date.now() - startTime,
      };
    } catch (err) {
      return {
        Migration: migration,
        Success: false,
        ExecutionTimeMS: Date.now() - startTime,
        Error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Builds the placeholder context from current config and runtime state.
   */
  private buildPlaceholderContext(): PlaceholderContext {
    return {
      DefaultSchema: this.config.Migrations.DefaultSchema,
      Timestamp: new Date().toISOString(),
      Database: this.config.Database.Database,
      User: this.config.Database.User,
      Table: this.config.Migrations.HistoryTable,
    };
  }

  /**
   * Gets the current highest applied version from history records.
   */
  private getCurrentVersion(history: HistoryRecord[]): string | null {
    let highest: string | null = null;
    for (const record of history) {
      if (record.Version !== null && record.Type !== 'SCHEMA') {
        if (highest === null || record.Version > highest) {
          highest = record.Version;
        }
      }
    }
    return highest;
  }

  /**
   * Determines the new current version after applying migrations.
   */
  private getNewCurrentVersion(
    results: MigrationExecutionResult[],
    existingHistory: HistoryRecord[]
  ): string | null {
    let highest = this.getCurrentVersion(existingHistory);

    for (const result of results) {
      if (
        result.Success &&
        result.Migration.Version !== null &&
        (highest === null || result.Migration.Version > highest)
      ) {
        highest = result.Migration.Version;
      }
    }

    return highest;
  }
}
