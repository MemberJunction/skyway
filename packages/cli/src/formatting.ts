/**
 * @module formatting
 * Console output formatting for the Skyway CLI.
 * Provides colored, structured output for migration status and progress.
 */

import chalk from 'chalk';
import { MigrationStatus, MigrationState, ResolvedMigration, MigrationExecutionResult } from '@skyway/core';

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
 * Logs a migration execution result.
 */
export function LogMigrationEnd(result: MigrationExecutionResult): void {
  if (result.Success) {
    console.log(chalk.green(` OK`) + chalk.gray(` (${result.ExecutionTimeMS}ms)`));
  } else {
    console.log(chalk.red(` FAILED`));
    if (result.Error) {
      console.log(chalk.red(`    ${result.Error.message}`));
    }
  }
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
