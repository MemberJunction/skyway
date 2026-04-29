/**
 * @module formatting
 * Console output formatting for the Skyway CLI.
 * Provides colored, structured output for migration status and progress.
 */

import chalk from 'chalk';
import {
  MigrationStatus,
  MigrationState,
  ResolvedMigration,
  MigrationExecutionResult,
  MigrationExecutionError,
  SkywayConfig,
  TruncateSQL,
} from '@memberjunction/skyway-core';

/**
 * Dialect-aware default port — 1433 for SQL Server, 5432 for PostgreSQL.
 * Exported so CLI command modules can render consistent connection info
 * regardless of which dialect the user configured.
 */
export function DefaultPortForDialect(dialect: NonNullable<SkywayConfig['Database']>['Dialect']): number {
  return dialect === 'postgresql' ? 5432 : 1433;
}

/**
 * Dialect-aware default schema — 'dbo' for SQL Server, 'public' for PostgreSQL.
 */
export function DefaultSchemaForDialect(dialect: NonNullable<SkywayConfig['Database']>['Dialect']): string {
  return dialect === 'postgresql' ? 'public' : 'dbo';
}

/**
 * Emits the standard connection-info block (dialect / database / schema) that
 * every command shares. Uses dialect-aware defaults so a PG run doesn't
 * falsely advertise port 1433 or schema `dbo`.
 *
 * Falls back to `Provider.Config` when `Database` isn't set explicitly —
 * matches the same precedence rule `resolveConfig()` uses.
 */
export function LogConnectionInfo(config: SkywayConfig): void {
  const database = config.Database ?? config.Provider?.Config;
  if (!database) {
    // Should never reach here — Skyway's own resolveConfig throws first.
    LogInfo('Connection info unavailable: no Database or Provider in config.');
    return;
  }
  const dialect = database.Dialect ?? config.Provider?.Dialect ?? 'sqlserver';
  const port = database.Port ?? DefaultPortForDialect(dialect);
  const schema =
    config.Migrations.DefaultSchema ?? DefaultSchemaForDialect(dialect);
  LogInfo(`Dialect: ${dialect}`);
  LogInfo(`Database: ${database.Server}:${port}/${database.Database}`);
  LogInfo(`Schema: ${schema}`);
}

/**
 * Prints the Skyway banner to the console.
 */
export function PrintBanner(): void {
  console.log(chalk.cyan.bold('\n  Skyway') + chalk.gray(' — TypeScript-native database migrations'));
  console.log(chalk.gray('  ─────────────────────────────────────────\n'));
}

/**
 * Formats a migration status table for the `info` command.
 */
export function PrintInfoTable(statuses: MigrationStatus[]): void {
  if (statuses.length === 0) {
    console.log(chalk.yellow('  No migrations found.'));
    return;
  }

  // Header
  console.log(
    chalk.gray('  ') +
      padRight('Version', 16) +
      padRight('Description', 50) +
      padRight('Type', 12) +
      padRight('State', 12) +
      padRight('Checksum', 14)
  );
  console.log(chalk.gray('  ' + '─'.repeat(104)));

  for (const status of statuses) {
    const stateColor = getStateColor(status.State);
    const version = status.Version ?? '(repeatable)';

    console.log(
      '  ' +
        padRight(version, 16) +
        padRight(truncate(status.Description, 48), 50) +
        padRight(status.Type, 12) +
        stateColor(padRight(status.State, 12)) +
        chalk.gray(status.DiskChecksum?.toString() ?? '')
    );
  }
  console.log();
}

/**
 * Logs a migration execution start.
 */
export function LogMigrationStart(migration: ResolvedMigration): void {
  const label = migration.Version
    ? `v${migration.Version}`
    : `(repeatable)`;
  process.stdout.write(
    chalk.gray('  ') +
      chalk.white(`Migrating to ${label}: ${migration.Description}...`)
  );
}

/**
 * Logs a migration execution result with detailed batch and context info on failure.
 */
export function LogMigrationEnd(result: MigrationExecutionResult): void {
  if (result.Success) {
    console.log(chalk.green(` OK`) + chalk.gray(` (${result.ExecutionTimeMS}ms)`));
  } else {
    console.log(chalk.red(` FAILED`));
    if (result.Error) {
      const err = result.Error;
      if (err instanceof MigrationExecutionError && err.BatchInfo) {
        const info = err.BatchInfo;
        console.log(chalk.red(`\n    Migration failed: ${err.Script}`));
        console.log(chalk.red(`    Batch ${info.BatchNumber} of ${info.TotalBatches} failed`));
        console.log(chalk.red(`    File lines: ${info.StartLine}-${info.EndLine}`));
        console.log(chalk.gray(`    ${info.SucceededBatches} batch(es) succeeded before failure`));

        // Show the original SQL Server error
        const cause = err.cause;
        if (cause instanceof Error) {
          console.log(chalk.red(`\n    SQL Error: ${cause.message}`));
        }

        // Show context lines that reference identifiers from the error
        if (info.ContextLines && info.ContextLines.length > 0) {
          console.log(chalk.yellow(`\n    Related lines in failed batch:`));
          for (const ctx of info.ContextLines) {
            console.log(chalk.yellow(`      Line ${ctx.LineNumber}: `) + chalk.white(ctx.Text));
          }
        }

        // Show truncated batch SQL
        console.log(chalk.gray(`\n    Failed batch SQL (first 500 chars):`));
        const truncated = TruncateSQL(info.BatchSQL, 500);
        for (const line of truncated.split('\n')) {
          console.log(chalk.gray(`      ${line}`));
        }
      } else {
        console.log(chalk.red(`    ${err.message}`));
      }
    }
  }
}

/**
 * Logs verbose batch progress.
 */
export function LogBatchProgress(batchIndex: number, totalBatches: number): void {
  console.log(chalk.gray(`    Batch ${batchIndex}/${totalBatches} completed`));
}

/**
 * Logs an informational message.
 */
export function LogInfo(message: string): void {
  console.log(chalk.gray('  ') + message);
}

/**
 * Logs a success summary.
 */
export function LogSuccess(message: string): void {
  console.log(chalk.green('\n  ' + message));
}

/**
 * Logs an error message.
 */
export function LogError(message: string): void {
  console.log(chalk.red('\n  ERROR: ' + message));
}

/**
 * Prints a summary banner after a migrate operation.
 */
export function PrintMigrateSummary(
  applied: number,
  totalMs: number,
  currentVersion: string | null,
  success: boolean,
  errorMessage?: string,
  transactionMode?: string
): void {
  console.log();
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  if (success) {
    console.log(
      chalk.green.bold('  SUCCESS') +
      chalk.gray(` — ${applied} migration(s) applied in ${formatElapsed(totalMs)}`)
    );
    if (currentVersion) {
      console.log(chalk.gray(`  Current version: `) + chalk.white(currentVersion));
    }
  } else {
    console.log(
      chalk.red.bold('  FAILED') +
      chalk.gray(` — ${applied} migration(s) applied before failure`)
    );
    if (errorMessage) {
      console.log(chalk.red(`  ${errorMessage}`));
    }

    // Transaction safety reporting
    if (transactionMode === 'per-run') {
      console.log(chalk.yellow(`  Transaction mode: per-run — all changes have been rolled back`));
    } else if (transactionMode === 'per-migration') {
      if (applied > 0) {
        console.log(chalk.yellow(`  Transaction mode: per-migration — ${applied} prior migration(s) remain committed, failed migration was rolled back`));
      } else {
        console.log(chalk.yellow(`  Transaction mode: per-migration — failed migration was rolled back`));
      }
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log();
}

/**
 * Formats elapsed time in a human-readable way.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

/**
 * Returns a chalk color function for a migration state.
 */
function getStateColor(state: MigrationState): chalk.Chalk {
  switch (state) {
    case 'APPLIED':
    case 'BASELINE':
      return chalk.green;
    case 'PENDING':
      return chalk.yellow;
    case 'FAILED':
      return chalk.red;
    case 'MISSING':
      return chalk.red;
    case 'IGNORED':
      return chalk.red;
    case 'OUTDATED':
      return chalk.magenta;
    case 'ABOVE_BASELINE':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/**
 * Right-pads a string to a given width.
 */
function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

/**
 * Truncates a string to a maximum length, appending '...' if needed.
 */
function truncate(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : str.substring(0, maxLen - 3) + '...';
}
