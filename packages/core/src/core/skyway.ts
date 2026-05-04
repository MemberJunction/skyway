/**
 * @module core/skyway
 * Main orchestrator for Skyway migration operations.
 *
 * The `Skyway` class is the primary public API for programmatic usage.
 * It coordinates scanning, resolving, executing, and recording migrations.
 *
 * @example
 * ```typescript
 * import { Skyway } from '@memberjunction/skyway-core';
 * import { SqlServerProvider } from '@memberjunction/skyway-sqlserver';
 *
 * const provider = new SqlServerProvider({
 *   Server: 'localhost', Database: 'mydb', User: 'sa', Password: 'secret'
 * });
 *
 * const skyway = new Skyway({
 *   Database: { Server: 'localhost', Database: 'mydb', User: 'sa', Password: 'secret' },
 *   Migrations: { Locations: ['./migrations'], DefaultSchema: '__mj' },
 *   Placeholders: { 'flyway:defaultSchema': '__mj' },
 *   TransactionMode: 'per-run',
 *   Provider: provider,
 * });
 *
 * const result = await skyway.Migrate();
 * console.log(`Applied ${result.MigrationsApplied} migrations`);
 *
 * await skyway.Close();
 * ```
 */

import { SkywayConfig, ResolvedSkywayConfig, resolveConfig } from './config';
import { DatabaseProvider, ProviderTransaction, HistoryInsertParams } from '../db/provider';
import { HistoryRecord } from '../history/types';
import { ScanAndResolveMigrations } from '../migration/scanner';
import { ResolveMigrations, ResolverResult } from '../migration/resolver';
import { ResolvedMigration, MigrationStatus } from '../migration/types';
import { SubstitutePlaceholders, PlaceholderContext } from '../executor/placeholder';

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
 * Result of executing a single migration file.
 */
export interface MigrationExecutionResult {
  /** The migration that was executed */
  Migration: ResolvedMigration;

  /** Whether execution completed successfully */
  Success: boolean;

  /** Execution time in milliseconds */
  ExecutionTimeMS: number;

  /** Error details if execution failed */
  Error?: Error;
}

/**
 * Result of a `Clean()` operation.
 */
export interface CleanResult {
  /** Whether the clean completed successfully */
  Success: boolean;

  /** Number of objects dropped */
  ObjectsDropped: number;

  /** Details of what was dropped */
  DroppedObjects: string[];

  /** Error message if clean failed */
  ErrorMessage?: string;
}

/**
 * Result of a `Baseline()` operation.
 */
export interface BaselineResult {
  /** Whether the baseline completed successfully */
  Success: boolean;

  /** The version that was baselined */
  BaselineVersion: string;

  /** Error message if baseline failed */
  ErrorMessage?: string;
}

/**
 * Result of a `Repair()` operation.
 */
export interface RepairResult {
  /** Whether the repair completed successfully */
  Success: boolean;

  /** Number of failed entries removed */
  FailedEntriesRemoved: number;

  /** Number of checksums realigned */
  ChecksumsRealigned: number;

  /** Details of repairs made */
  RepairDetails: string[];

  /** Error message if repair failed */
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

  /** Called after each SQL batch completes successfully (verbose mode) */
  OnBatchEnd?: (batchIndex: number, totalBatches: number) => void;

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
  private readonly config: ResolvedSkywayConfig;
  private readonly provider: DatabaseProvider;
  private callbacks: SkywayCallbacks = {};

  /**
   * Creates a new Skyway instance.
   *
   * A `DatabaseProvider` must be supplied either via `config.Provider`
   * or Skyway will throw an error. The provider determines which database
   * platform is targeted (SQL Server, PostgreSQL, etc.).
   *
   * @param config - Migration configuration including database connection and provider
   * @throws Error if no DatabaseProvider is supplied
   */
  constructor(config: SkywayConfig) {
    this.config = resolveConfig(config);

    if (!this.config.Provider) {
      throw new Error(
        'No DatabaseProvider supplied. Pass a provider via config.Provider. ' +
        'Install @memberjunction/skyway-sqlserver or @memberjunction/skyway-postgres ' +
        'and create the appropriate provider instance.'
      );
    }

    this.provider = this.config.Provider;
  }

  /**
   * Registers callbacks for observing migration progress.
   * Returns `this` for chaining.
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
      await this.provider.Connect();

      const schema = this.config.Migrations.DefaultSchema;
      const historyTable = this.config.Migrations.HistoryTable;

      // Ensure schema and history table exist
      await this.provider.History.EnsureExists(schema, historyTable);

      // Insert schema creation marker if this is a fresh table
      const existingRecords = await this.provider.History.GetAllRecords(schema, historyTable);
      if (existingRecords.length === 0) {
        await this.insertSchemaMarker(schema, historyTable);
        this.callbacks.OnLog?.(`Created schema [${schema}]`);
      }

      // Scan and resolve migrations
      this.callbacks.OnLog?.('Scanning migration files...');
      const discovered = await ScanAndResolveMigrations(
        this.config.Migrations.Locations,
        (warning) => this.callbacks.OnLog?.(`Warning: ${warning}`)
      );
      this.callbacks.OnLog?.(`Found ${discovered.length} migration file(s)`);

      // Re-read history (may have changed after schema creation)
      const currentHistory = await this.provider.History.GetAllRecords(schema, historyTable);

      const resolution = ResolveMigrations(
        discovered,
        currentHistory,
        this.config.Migrations.BaselineVersion,
        this.config.Migrations.BaselineOnMigrate,
        this.config.Migrations.OutOfOrder
      );

      if (resolution.BaselineAutoSelected && resolution.EffectiveBaselineVersion) {
        this.callbacks.OnLog?.(
          `Auto-selected baseline version: ${resolution.EffectiveBaselineVersion} (highest of ${resolution.BaselineFileCount} baseline file(s))`
        );
      }

      // Check for out-of-order migrations when outOfOrder is disabled
      const ignoredMigrations = resolution.StatusReport.filter(
        (s) => s.State === 'IGNORED'
      );

      if (ignoredMigrations.length > 0) {
        for (const m of ignoredMigrations) {
          this.callbacks.OnLog?.(
            `WARNING: Out-of-order migration detected: ${m.Version} (${m.Description})`
          );
        }
        const versions = ignoredMigrations.map((m) => m.Version).join(', ');
        return {
          MigrationsApplied: 0,
          TotalExecutionTimeMS: Date.now() - startTime,
          CurrentVersion: this.getCurrentVersion(currentHistory),
          Details: [],
          Success: false,
          ErrorMessage:
            `Detected resolved migration not applied to database: ${versions}. ` +
            `To allow out-of-order migrations, set outOfOrder to true.`,
        };
      }

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

      // Dry-run mode
      if (this.config.DryRun) {
        this.callbacks.OnLog?.('DRY RUN — no migrations will be applied');
        for (const m of resolution.PendingMigrations) {
          this.callbacks.OnLog?.(
            `  Would apply: ${m.Version ?? '(repeatable)'} — ${m.Description}`
          );
        }
        return {
          MigrationsApplied: 0,
          TotalExecutionTimeMS: Date.now() - startTime,
          CurrentVersion: this.getCurrentVersion(currentHistory),
          Details: [],
          Success: true,
        };
      }

      // Execute migrations
      const result = await this.executeMigrationsWithHistory(resolution);

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
    await this.provider.Connect();

    const schema = this.config.Migrations.DefaultSchema;
    const historyTable = this.config.Migrations.HistoryTable;

    const discovered = await ScanAndResolveMigrations(
      this.config.Migrations.Locations
    );

    let applied: HistoryRecord[] = [];
    if (await this.provider.History.Exists(schema, historyTable)) {
      applied = await this.provider.History.GetAllRecords(schema, historyTable);
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
    await this.provider.Connect();

    const schema = this.config.Migrations.DefaultSchema;
    const historyTable = this.config.Migrations.HistoryTable;
    const errors: string[] = [];

    if (!(await this.provider.History.Exists(schema, historyTable))) {
      return { Valid: true, Errors: [] };
    }

    const applied = await this.provider.History.GetAllRecords(schema, historyTable);
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

    // Run resolver up-front so we can use its EffectiveBaselineVersion as a
    // floor below — records at/below the floor are subsumed by the baseline,
    // their disk files are expected to be absent.
    const resolution = ResolveMigrations(
      discovered,
      applied,
      this.config.Migrations.BaselineVersion,
      this.config.Migrations.BaselineOnMigrate,
      this.config.Migrations.OutOfOrder
    );
    const floor = resolution.EffectiveBaselineVersion;

    for (const record of applied) {
      if (record.Version === null || record.Type === 'SCHEMA') continue;

      // Baseline rows are one-shot bootstraps; their files get pruned after
      // running. Don't flag them as missing-from-disk.
      if (record.Type === 'BASELINE' || record.Type === 'SQL_BASELINE') continue;

      // Anything at or below the floor is subsumed by the baseline.
      if (floor !== null && record.Version <= floor) continue;

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

    // Out-of-order detection — the resolver already classified these as IGNORED.
    for (const status of resolution.StatusReport) {
      if (status.State === 'IGNORED') {
        errors.push(
          `Detected resolved migration not applied to database: ${status.Version}. ` +
          `To allow out-of-order migrations, set outOfOrder to true.`
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
   */
  async CreateDatabase(): Promise<void> {
    const dbName = this.config.Database.Database;
    const exists = await this.provider.DatabaseExists(dbName);
    if (!exists) {
      this.callbacks.OnLog?.(`Creating database [${dbName}]...`);
      await this.provider.CreateDatabase(dbName);
      this.callbacks.OnLog?.(`Database [${dbName}] created`);
    } else {
      this.callbacks.OnLog?.(`Database [${dbName}] already exists`);
    }
  }

  /**
   * Drops the target database if it exists.
   *
   * **WARNING**: This is destructive and irreversible!
   */
  async DropDatabase(): Promise<void> {
    const dbName = this.config.Database.Database;
    const exists = await this.provider.DatabaseExists(dbName);
    if (exists) {
      this.callbacks.OnLog?.(`Dropping database [${dbName}]...`);
      await this.provider.DropDatabase(dbName);
      this.callbacks.OnLog?.(`Database [${dbName}] dropped`);
    } else {
      this.callbacks.OnLog?.(`Database [${dbName}] does not exist`);
    }
  }

  /**
   * Drops all objects in the configured schema.
   *
   * **WARNING**: This is destructive and irreversible!
   */
  async Clean(): Promise<CleanResult> {
    const droppedObjects: string[] = [];

    try {
      await this.provider.Connect();
      const schema = this.config.Migrations.DefaultSchema;

      this.callbacks.OnLog?.(`Cleaning schema [${schema}]...`);

      // Get ordered list of drop operations from provider
      const operations = await this.provider.GetCleanOperations(schema);

      // Execute each drop operation
      for (const op of operations) {
        await this.provider.Execute(op.SQL);
        droppedObjects.push(op.Label);
        this.callbacks.OnLog?.(`  Dropped ${op.Label}`);
      }

      // Drop the schema itself
      await this.provider.DropSchema(schema);
      // Check if schema was actually dropped (provider skips built-in schemas)
      // We log it if it was in the operations list
      this.callbacks.OnLog?.(`Clean completed: ${droppedObjects.length} object(s) dropped`);

      return {
        Success: true,
        ObjectsDropped: droppedObjects.length,
        DroppedObjects: droppedObjects,
      };
    } catch (err) {
      return {
        Success: false,
        ObjectsDropped: droppedObjects.length,
        DroppedObjects: droppedObjects,
        ErrorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Baselines the database at a specified version.
   */
  async Baseline(version?: string): Promise<BaselineResult> {
    const baselineVersion = version ?? this.config.Migrations.BaselineVersion;

    try {
      await this.provider.Connect();

      const schema = this.config.Migrations.DefaultSchema;
      const historyTable = this.config.Migrations.HistoryTable;

      await this.provider.History.EnsureExists(schema, historyTable);

      // Check for existing migration records
      const records = await this.provider.History.GetAllRecords(schema, historyTable);
      const migrationRecords = records.filter(r => r.Type !== 'SCHEMA');
      if (migrationRecords.length > 0) {
        return {
          Success: false,
          BaselineVersion: baselineVersion,
          ErrorMessage:
            `Cannot baseline: history table already contains ${migrationRecords.length} migration record(s). ` +
            `Use repair to fix issues or clean to start fresh.`,
        };
      }

      // Insert schema marker if not present
      if (records.length === 0) {
        await this.insertSchemaMarker(schema, historyTable);
      }

      // Insert baseline record
      const nextRank = await this.provider.History.GetNextRank(schema, historyTable);
      await this.provider.History.InsertRecord(schema, historyTable, {
        InstalledRank: nextRank,
        Version: baselineVersion,
        Description: '<< Flyway Baseline >>',
        Type: 'BASELINE',
        Script: '<< Flyway Baseline >>',
        Checksum: null,
        InstalledBy: this.config.Database.User,
        ExecutionTime: 0,
        Success: true,
      });

      this.callbacks.OnLog?.(
        `Successfully baselined schema [${schema}] at version ${baselineVersion}`
      );

      return {
        Success: true,
        BaselineVersion: baselineVersion,
      };
    } catch (err) {
      return {
        Success: false,
        BaselineVersion: baselineVersion,
        ErrorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Repairs the schema history table.
   * Removes failed entries and realigns checksums.
   */
  async Repair(): Promise<RepairResult> {
    const repairDetails: string[] = [];

    try {
      await this.provider.Connect();

      const schema = this.config.Migrations.DefaultSchema;
      const historyTable = this.config.Migrations.HistoryTable;

      if (!(await this.provider.History.Exists(schema, historyTable))) {
        return {
          Success: true,
          FailedEntriesRemoved: 0,
          ChecksumsRealigned: 0,
          RepairDetails: ['History table does not exist — nothing to repair'],
        };
      }

      const records = await this.provider.History.GetAllRecords(schema, historyTable);

      // 1. Remove failed entries
      let failedRemoved = 0;
      for (const record of records) {
        if (!record.Success) {
          await this.provider.History.DeleteRecord(schema, historyTable, record.InstalledRank);
          const detail = `Removed failed entry: version=${record.Version}, description=${record.Description}`;
          repairDetails.push(detail);
          this.callbacks.OnLog?.(detail);
          failedRemoved++;
        }
      }

      // 2. Realign checksums
      const discovered = await ScanAndResolveMigrations(
        this.config.Migrations.Locations
      );
      const diskByVersion = new Map<string, ResolvedMigration>();
      for (const m of discovered) {
        if (m.Version) {
          diskByVersion.set(m.Version, m);
        }
      }

      let checksumsRealigned = 0;
      for (const record of records) {
        if (record.Version === null || record.Type === 'SCHEMA' || !record.Success) {
          continue;
        }
        const diskMigration = diskByVersion.get(record.Version);
        if (diskMigration && record.Checksum !== null && record.Checksum !== diskMigration.Checksum) {
          await this.provider.History.UpdateChecksum(schema, historyTable, record.InstalledRank, diskMigration.Checksum);
          const detail = `Realigned checksum for version ${record.Version}: ${record.Checksum} → ${diskMigration.Checksum}`;
          repairDetails.push(detail);
          this.callbacks.OnLog?.(detail);
          checksumsRealigned++;
        }
      }

      this.callbacks.OnLog?.(
        `Repair completed: ${failedRemoved} failed entry(ies) removed, ` +
        `${checksumsRealigned} checksum(s) realigned`
      );

      return {
        Success: true,
        FailedEntriesRemoved: failedRemoved,
        ChecksumsRealigned: checksumsRealigned,
        RepairDetails: repairDetails,
      };
    } catch (err) {
      return {
        Success: false,
        FailedEntriesRemoved: 0,
        ChecksumsRealigned: 0,
        RepairDetails: repairDetails,
        ErrorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Closes the database connection.
   * Should be called when done with the Skyway instance.
   */
  async Close(): Promise<void> {
    await this.provider.Disconnect();
  }

  // ─── Private Methods ──────────────────────────────────────────────

  /**
   * Inserts the schema creation marker (installed_rank 0).
   */
  private async insertSchemaMarker(schema: string, historyTable: string): Promise<void> {
    // Check if rank 0 already exists (idempotent)
    const records = await this.provider.History.GetAllRecords(schema, historyTable);
    if (records.some(r => r.InstalledRank === 0)) {
      return;
    }

    await this.provider.History.InsertRecord(schema, historyTable, {
      InstalledRank: 0,
      Version: null,
      Description: '<< Flyway Schema Creation >>',
      Type: 'SCHEMA',
      Script: `[${schema}]`,
      Checksum: null,
      InstalledBy: this.config.Database.User,
      ExecutionTime: 0,
      Success: true,
    });
  }

  /**
   * Executes pending migrations and records results in the history table.
   */
  private async executeMigrationsWithHistory(
    resolution: ResolverResult
  ): Promise<MigrationExecutionResult[]> {
    const migrations = resolution.PendingMigrations;

    if (this.config.TransactionMode === 'per-run') {
      return this.executePerRunWithHistory(migrations);
    } else {
      return this.executePerMigrationWithHistory(migrations);
    }
  }

  /**
   * Per-run transaction mode: wrap everything in one transaction.
   */
  private async executePerRunWithHistory(
    migrations: ResolvedMigration[]
  ): Promise<MigrationExecutionResult[]> {
    const results: MigrationExecutionResult[] = [];
    const schema = this.config.Migrations.DefaultSchema;
    const historyTable = this.config.Migrations.HistoryTable;
    const txn = await this.provider.BeginTransaction();

    try {
      this.callbacks.OnLog?.('Transaction started (per-run mode — all or nothing)');

      let nextRank = await this.provider.History.GetNextRank(schema, historyTable, txn);

      for (const migration of migrations) {
        this.callbacks.OnMigrationStart?.(migration);
        const result = await this.executeSingleMigration(txn, migration);
        results.push(result);

        if (result.Success) {
          await this.provider.History.InsertRecord(
            schema,
            historyTable,
            this.buildHistoryRecord(migration, nextRank++, result.ExecutionTimeMS),
            txn
          );

          this.callbacks.OnLog?.(
            `Migrated to version ${migration.Version ?? '(repeatable)'}: ${migration.Description} (${result.ExecutionTimeMS}ms)`
          );
          this.callbacks.OnMigrationEnd?.(result);
        } else {
          this.callbacks.OnLog?.(
            `Migration FAILED: ${migration.Version ?? migration.Description} — ${result.Error?.message}`
          );
          this.callbacks.OnMigrationEnd?.(result);

          try {
            await txn.Rollback();
            this.callbacks.OnLog?.('Transaction rolled back — no migrations were applied');
          } catch (rollbackErr) {
            this.callbacks.OnLog?.(`Warning: rollback error: ${rollbackErr}`);
          }
          return results;
        }
      }

      // All succeeded — commit
      await txn.Commit();
      this.callbacks.OnLog?.('Transaction committed — all migrations applied successfully');
      return results;
    } catch (err) {
      try {
        await txn.Rollback();
      } catch {
        // Swallow rollback error — the original error is more important
      }
      throw err;
    }
  }

  /**
   * Per-migration transaction mode: each migration gets its own transaction.
   */
  private async executePerMigrationWithHistory(
    migrations: ResolvedMigration[]
  ): Promise<MigrationExecutionResult[]> {
    const results: MigrationExecutionResult[] = [];
    const schema = this.config.Migrations.DefaultSchema;
    const historyTable = this.config.Migrations.HistoryTable;

    for (const migration of migrations) {
      const txn = await this.provider.BeginTransaction();

      try {
        this.callbacks.OnMigrationStart?.(migration);
        const result = await this.executeSingleMigration(txn, migration);
        results.push(result);

        if (result.Success) {
          const nextRank = await this.provider.History.GetNextRank(schema, historyTable, txn);
          await this.provider.History.InsertRecord(
            schema,
            historyTable,
            this.buildHistoryRecord(migration, nextRank, result.ExecutionTimeMS),
            txn
          );
          await txn.Commit();

          this.callbacks.OnLog?.(
            `Migrated to version ${migration.Version ?? '(repeatable)'}: ${migration.Description} (${result.ExecutionTimeMS}ms)`
          );
          this.callbacks.OnMigrationEnd?.(result);
        } else {
          this.callbacks.OnMigrationEnd?.(result);
          await txn.Rollback();
          this.callbacks.OnLog?.(
            `Migration rolled back: ${migration.Version ?? migration.Description}`
          );
          return results;
        }
      } catch (err) {
        try {
          await txn.Rollback();
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
   */
  private async executeSingleMigration(
    txn: ProviderTransaction,
    migration: ResolvedMigration
  ): Promise<MigrationExecutionResult> {
    const { ComputeChecksum } = await import('../migration/checksum');
    const { ExtractErrorIdentifiers, FindContextLines } = await import('../executor/error-context');
    const { MigrationExecutionError } = await import('./errors');

    const startTime = Date.now();

    try {
      // Substitute placeholders
      const context: PlaceholderContext = {
        DefaultSchema: this.config.Migrations.DefaultSchema,
        Timestamp: new Date().toISOString(),
        Database: this.config.Database.Database,
        User: this.config.Database.User,
        Table: this.config.Migrations.HistoryTable,
        Filename: migration.Filename,
      };
      const processedSQL = SubstitutePlaceholders(
        migration.SQL,
        this.config.Placeholders,
        context
      );

      // Repeatable migrations: recompute checksum after placeholder substitution
      if (migration.Type === 'repeatable') {
        migration.Checksum = ComputeChecksum(processedSQL);
      }

      // Split into batches using the provider's dialect-specific splitter
      const batches = this.provider.SplitScript(processedSQL);

      this.callbacks.OnLog?.(
        `  Executing ${migration.Filename}: ${batches.length} batch(es)`
      );

      // Execute each batch — capture per-batch failures with rich context
      // so the CLI can render line ranges + error identifiers + the failed
      // SQL. Uses the dialect-agnostic provider transaction (txn.Execute),
      // which routes through SqlServerProvider's mssql Request or
      // PostgresProvider's pg.PoolClient as appropriate.
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        for (let repeat = 0; repeat < batch.RepeatCount; repeat++) {
          try {
            await txn.Execute(batch.SQL);
          } catch (batchErr) {
            const elapsedMS = Date.now() - startTime;
            const errorMessage = batchErr instanceof Error ? batchErr.message : String(batchErr);

            // Extract identifiers from error and find related lines.
            // Identifier patterns are tuned for SQL Server messages but degrade
            // gracefully on PG (no matches → no context lines, still reports the batch).
            const identifiers = ExtractErrorIdentifiers(errorMessage);
            const contextLines = FindContextLines(batch.SQL, batch.StartLine, identifiers);

            const batchInfo = {
              BatchNumber: i + 1,
              TotalBatches: batches.length,
              StartLine: batch.StartLine,
              EndLine: batch.EndLine,
              SucceededBatches: i,
              BatchSQL: batch.SQL,
              ContextLines: contextLines.length > 0 ? contextLines : undefined,
            };

            const error = new MigrationExecutionError(
              migration.Version,
              migration.ScriptPath,
              `Failed at batch ${i + 1}/${batches.length} (lines ${batch.StartLine}-${batch.EndLine}): ${errorMessage}`,
              batch.SQL.substring(0, 500),
              batchErr instanceof Error ? batchErr : undefined,
              batchInfo
            );

            return {
              Migration: migration,
              Success: false,
              ExecutionTimeMS: elapsedMS,
              Error: error,
            };
          }
        }

        this.callbacks.OnBatchEnd?.(i + 1, batches.length);
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
   * Builds a HistoryInsertParams from a migration execution result.
   */
  private buildHistoryRecord(
    migration: ResolvedMigration,
    rank: number,
    executionTimeMS: number
  ): HistoryInsertParams {
    let type: string;
    switch (migration.Type) {
      case 'baseline':
        type = 'SQL_BASELINE';
        break;
      case 'versioned':
      case 'repeatable':
      default:
        type = 'SQL';
        break;
    }

    return {
      InstalledRank: rank,
      Version: migration.Version,
      Description: migration.Description,
      Type: type,
      Script: migration.ScriptPath,
      Checksum: migration.Checksum,
      InstalledBy: this.config.Database.User,
      ExecutionTime: executionTimeMS,
      Success: true,
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
