/**
 * @module executor/executor
 * Executes migration SQL against SQL Server with transaction wrapping.
 *
 * The executor handles:
 * - Placeholder substitution in SQL content
 * - Splitting scripts on GO batch separators
 * - Executing each batch sequentially within a transaction
 * - Timing execution for the history table
 * - Rolling back on failure
 *
 * **Transaction Strategy**: The entire migration run is wrapped in a
 * single transaction (per-run mode) or each migration gets its own
 * transaction (per-migration mode). SQL Server supports transactional
 * DDL, so CREATE TABLE, ALTER TABLE, etc. all roll back cleanly.
 *
 * **Nested Transaction Handling**: If a migration's SQL contains its
 * own BEGIN TRAN/COMMIT, SQL Server treats these as nested transactions
 * via the @@TRANCOUNT mechanism. The inner COMMIT only decrements the
 * count — it doesn't actually commit until the outermost COMMIT.
 * An inner ROLLBACK, however, rolls back everything. We handle this
 * by detecting @@TRANCOUNT after each batch.
 */

import * as sql from 'mssql';
import { ResolvedMigration } from '../migration/types';
import { SplitOnGO } from './sql-splitter';
import { SubstitutePlaceholders, PlaceholderContext } from './placeholder';
import { MigrationExecutionError, TransactionError } from '../core/errors';

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
 * Callback for reporting migration execution progress.
 */
export interface ExecutionCallbacks {
  /** Called before a migration starts executing */
  OnMigrationStart?: (migration: ResolvedMigration) => void;

  /** Called after a migration completes (success or failure) */
  OnMigrationEnd?: (result: MigrationExecutionResult) => void;

  /** Called before each SQL batch within a migration */
  OnBatchStart?: (batchIndex: number, totalBatches: number) => void;

  /** Called for informational log messages */
  OnLog?: (message: string) => void;
}

/**
 * Executes a list of migrations against SQL Server.
 *
 * In `'per-run'` mode, all migrations are wrapped in a single transaction.
 * If any migration fails, everything rolls back.
 *
 * In `'per-migration'` mode, each migration gets its own transaction.
 * If migration N fails, migrations 1..N-1 are committed, and N is rolled back.
 *
 * @param pool - Connected SQL Server connection pool
 * @param migrations - Ordered list of migrations to execute
 * @param placeholderContext - Context for resolving built-in placeholders
 * @param userPlaceholders - User-defined placeholder key-value pairs
 * @param transactionMode - How to wrap transactions
 * @param callbacks - Optional progress callbacks
 * @returns Array of execution results for each migration
 * @throws TransactionError if the transaction cannot be committed or rolled back
 */
export async function ExecuteMigrations(
  pool: sql.ConnectionPool,
  migrations: ResolvedMigration[],
  placeholderContext: PlaceholderContext,
  userPlaceholders: Record<string, string>,
  transactionMode: 'per-run' | 'per-migration',
  callbacks?: ExecutionCallbacks
): Promise<MigrationExecutionResult[]> {
  if (migrations.length === 0) {
    return [];
  }

  if (transactionMode === 'per-run') {
    return executeWithRunTransaction(
      pool,
      migrations,
      placeholderContext,
      userPlaceholders,
      callbacks
    );
  } else {
    return executeWithPerMigrationTransactions(
      pool,
      migrations,
      placeholderContext,
      userPlaceholders,
      callbacks
    );
  }
}

/**
 * Wraps the entire migration run in a single transaction.
 * All migrations succeed or all are rolled back.
 */
async function executeWithRunTransaction(
  pool: sql.ConnectionPool,
  migrations: ResolvedMigration[],
  placeholderContext: PlaceholderContext,
  userPlaceholders: Record<string, string>,
  callbacks?: ExecutionCallbacks
): Promise<MigrationExecutionResult[]> {
  const results: MigrationExecutionResult[] = [];
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();
    callbacks?.OnLog?.('Transaction started (per-run mode)');

    for (const migration of migrations) {
      const result = await executeSingleMigration(
        transaction,
        migration,
        placeholderContext,
        userPlaceholders,
        callbacks
      );
      results.push(result);

      if (!result.Success) {
        // Failure — roll everything back
        callbacks?.OnLog?.(
          `Migration ${migration.Version ?? migration.Description} failed. Rolling back entire run...`
        );
        try {
          await transaction.rollback();
          callbacks?.OnLog?.('Transaction rolled back successfully');
        } catch (rollbackErr) {
          throw new TransactionError(
            'Failed to rollback transaction after migration failure',
            rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
          );
        }
        return results;
      }
    }

    // All migrations succeeded — commit
    try {
      await transaction.commit();
      callbacks?.OnLog?.('Transaction committed successfully');
    } catch (commitErr) {
      throw new TransactionError(
        'Failed to commit transaction after successful migrations',
        commitErr instanceof Error ? commitErr : new Error(String(commitErr))
      );
    }

    return results;
  } catch (err) {
    // If error is already a TransactionError, rethrow
    if (err instanceof TransactionError) {
      throw err;
    }

    // Unexpected error — attempt rollback
    try {
      await transaction.rollback();
    } catch {
      // Swallow rollback error — the original error is more important
    }
    throw err;
  }
}

/**
 * Each migration gets its own transaction.
 * If migration N fails, 1..N-1 are committed, N is rolled back.
 */
async function executeWithPerMigrationTransactions(
  pool: sql.ConnectionPool,
  migrations: ResolvedMigration[],
  placeholderContext: PlaceholderContext,
  userPlaceholders: Record<string, string>,
  callbacks?: ExecutionCallbacks
): Promise<MigrationExecutionResult[]> {
  const results: MigrationExecutionResult[] = [];

  for (const migration of migrations) {
    const transaction = new sql.Transaction(pool);

    try {
      await transaction.begin();

      const result = await executeSingleMigration(
        transaction,
        migration,
        placeholderContext,
        userPlaceholders,
        callbacks
      );
      results.push(result);

      if (result.Success) {
        await transaction.commit();
      } else {
        await transaction.rollback();
        callbacks?.OnLog?.(
          `Migration ${migration.Version ?? migration.Description} rolled back`
        );
        return results; // Stop on first failure
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
 *
 * Steps:
 * 1. Substitute placeholders in the SQL content
 * 2. Split the SQL on GO statements into batches
 * 3. Execute each batch sequentially using the transaction
 * 4. Time the total execution
 *
 * @returns Execution result with timing and success/failure status
 */
async function executeSingleMigration(
  transaction: sql.Transaction,
  migration: ResolvedMigration,
  placeholderContext: PlaceholderContext,
  userPlaceholders: Record<string, string>,
  callbacks?: ExecutionCallbacks
): Promise<MigrationExecutionResult> {
  callbacks?.OnMigrationStart?.(migration);
  const startTime = Date.now();

  try {
    // Step 1: Substitute placeholders
    const context: PlaceholderContext = {
      ...placeholderContext,
      Filename: migration.Filename,
    };
    const processedSQL = SubstitutePlaceholders(
      migration.SQL,
      userPlaceholders,
      context
    );

    // Step 2: Split on GO
    const batches = SplitOnGO(processedSQL);

    callbacks?.OnLog?.(
      `Executing ${migration.Filename}: ${batches.length} batch(es)`
    );

    // Step 3: Execute each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      callbacks?.OnBatchStart?.(i + 1, batches.length);

      for (let repeat = 0; repeat < batch.RepeatCount; repeat++) {
        try {
          const request = new sql.Request(transaction);
          await request.batch(batch.SQL);
        } catch (batchErr) {
          const elapsedMS = Date.now() - startTime;
          const error = new MigrationExecutionError(
            migration.Version,
            migration.ScriptPath,
            `Failed at batch ${i + 1}/${batches.length} (line ${batch.StartLine}): ${
              batchErr instanceof Error ? batchErr.message : String(batchErr)
            }`,
            batch.SQL.substring(0, 500),
            batchErr instanceof Error ? batchErr : undefined
          );

          const result: MigrationExecutionResult = {
            Migration: migration,
            Success: false,
            ExecutionTimeMS: elapsedMS,
            Error: error,
          };
          callbacks?.OnMigrationEnd?.(result);
          return result;
        }
      }
    }

    // Step 4: Success
    const elapsedMS = Date.now() - startTime;
    const result: MigrationExecutionResult = {
      Migration: migration,
      Success: true,
      ExecutionTimeMS: elapsedMS,
    };
    callbacks?.OnMigrationEnd?.(result);
    return result;
  } catch (err) {
    const elapsedMS = Date.now() - startTime;
    const result: MigrationExecutionResult = {
      Migration: migration,
      Success: false,
      ExecutionTimeMS: elapsedMS,
      Error: err instanceof Error ? err : new Error(String(err)),
    };
    callbacks?.OnMigrationEnd?.(result);
    return result;
  }
}
