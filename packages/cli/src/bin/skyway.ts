#!/usr/bin/env node
/**
 * @module bin/skyway
 * CLI entry point for Skyway.
 *
 * Usage:
 *   skyway migrate [options]
 *   skyway info [options]
 *   skyway validate [options]
 *   skyway create-db [options]
 *   skyway drop-db [options]
 */

import { Command } from 'commander';
import { LoadConfig, CLIOptions } from '../config-loader';
import { PrintBanner, LogInfo, LogSuccess, LogError } from '../formatting';
import { RunMigrate } from '../commands/migrate';
import { RunInfo } from '../commands/info';
import { RunValidate } from '../commands/validate';
import { RunClean } from '../commands/clean';
import { RunBaseline } from '../commands/baseline';
import { RunRepair } from '../commands/repair';
import { Skyway } from '@skyway/core';

const program = new Command();

program
  .name('skyway')
  .description('Skyway — TypeScript-native Flyway-compatible database migrations')
  .version('0.1.0');

// ─── Shared Options ─────────────────────────────────────────────────

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option('-s, --server <host>', 'SQL Server hostname')
    .option('-p, --port <port>', 'SQL Server port', parseInt)
    .option('-d, --database <name>', 'Database name')
    .option('-u, --user <user>', 'Database user')
    .option('-P, --password <password>', 'Database password')
    .option('-l, --locations <paths>', 'Migration locations (comma-separated)')
    .option('--schema <schema>', 'Default schema name')
    .option('--table <table>', 'History table name')
    .option('--baseline-version <version>', 'Baseline version')
    .option('--baseline-on-migrate', 'Auto-baseline on empty database')
    .option('--transaction-mode <mode>', 'Transaction mode: per-run or per-migration')
    .option('--trust-server-certificate', 'Trust self-signed certificates')
    .option('--config <path>', 'Path to config file')
    .option('--placeholder <key=value>', 'Set a placeholder (repeatable)', collect, [])
    .option('--dry-run', 'Show pending migrations without executing them')
    .option('-q, --quiet', 'Suppress per-migration output, show summary only');
}

// ─── Commands ───────────────────────────────────────────────────────

addSharedOptions(
  program
    .command('migrate')
    .description('Apply pending migrations to the database')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const success = await RunMigrate(config, opts.quiet ?? false);
  process.exit(success ? 0 : 1);
});

addSharedOptions(
  program
    .command('info')
    .description('Show migration status')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const success = await RunInfo(config);
  process.exit(success ? 0 : 1);
});

addSharedOptions(
  program
    .command('validate')
    .description('Validate applied migration checksums')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const success = await RunValidate(config);
  process.exit(success ? 0 : 1);
});

addSharedOptions(
  program
    .command('clean')
    .description('Drop all objects in the configured schema (DESTRUCTIVE!)')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const success = await RunClean(config);
  process.exit(success ? 0 : 1);
});

addSharedOptions(
  program
    .command('baseline')
    .description('Baseline the database at a specific version')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const success = await RunBaseline(config, opts.baselineVersion);
  process.exit(success ? 0 : 1);
});

addSharedOptions(
  program
    .command('repair')
    .description('Repair the schema history table (remove failed entries, realign checksums)')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const success = await RunRepair(config);
  process.exit(success ? 0 : 1);
});

addSharedOptions(
  program
    .command('create-db')
    .description('Create the target database if it does not exist')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const skyway = new Skyway(config);
  skyway.OnProgress({ OnLog: LogInfo });
  try {
    await skyway.CreateDatabase();
    LogSuccess('Done');
  } catch (err) {
    LogError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await skyway.Close();
  }
  console.log();
});

addSharedOptions(
  program
    .command('drop-db')
    .description('Drop the target database (DESTRUCTIVE!)')
).action(async (opts) => {
  PrintBanner();
  const config = LoadConfig(mapOptions(opts));
  const skyway = new Skyway(config);
  skyway.OnProgress({ OnLog: LogInfo });
  try {
    await skyway.DropDatabase();
    LogSuccess('Done');
  } catch (err) {
    LogError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await skyway.Close();
  }
  console.log();
});

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Maps commander options to CLIOptions.
 */
function mapOptions(opts: Record<string, unknown>): CLIOptions {
  return {
    Server: opts.server as string | undefined,
    Port: opts.port as number | undefined,
    Database: opts.database as string | undefined,
    User: opts.user as string | undefined,
    Password: opts.password as string | undefined,
    Locations: opts.locations as string | undefined,
    Schema: opts.schema as string | undefined,
    Table: opts.table as string | undefined,
    BaselineVersion: opts.baselineVersion as string | undefined,
    BaselineOnMigrate: opts.baselineOnMigrate as boolean | undefined,
    TransactionMode: opts.transactionMode as string | undefined,
    TrustServerCertificate: opts.trustServerCertificate as boolean | undefined,
    Config: opts.config as string | undefined,
    Placeholders: opts.placeholder as string[] | undefined,
    DryRun: opts.dryRun as boolean | undefined,
  };
}

/**
 * Commander option collector for repeatable options.
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// Run
program.parse();
