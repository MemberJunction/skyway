/**
 * @module commands/migrate
 * Implementation of the `skyway migrate` CLI command.
 */

import { Skyway } from '@memberjunction/skyway-core';
import { SkywayConfig } from '@memberjunction/skyway-core';
import { LogMigrationStart, LogMigrationEnd, LogInfo, LogError, PrintMigrateSummary } from '../formatting';

/**
 * Executes the migrate command: applies all pending migrations.
 *
 * @param config - Resolved Skyway configuration
 * @param quiet - When true, suppress per-migration output
 */
export async function RunMigrate(config: SkywayConfig, quiet: boolean = false): Promise<boolean> {
  const skyway = new Skyway(config);

  if (!quiet) {
    skyway.OnProgress({
      OnMigrationStart: LogMigrationStart,
      OnMigrationEnd: LogMigrationEnd,
      OnLog: LogInfo,
    });
  } else {
    skyway.OnProgress({
      OnLog: LogInfo,
    });
  }

  try {
    const defaultPort = config.Database.Dialect === 'postgresql' ? 5432 : 1433;
    LogInfo(`Dialect: ${config.Database.Dialect ?? 'sqlserver'}`);
    LogInfo(`Database: ${config.Database.Server}:${config.Database.Port ?? defaultPort}/${config.Database.Database}`);
    LogInfo(`Schema: ${config.Migrations.DefaultSchema ?? (config.Database.Dialect === 'postgresql' ? 'public' : 'dbo')}`);
    LogInfo(`Locations: ${config.Migrations.Locations.join(', ')}`);
    LogInfo(`Transaction mode: ${config.TransactionMode ?? 'per-run'}`);
    if (config.DryRun) {
      LogInfo('Mode: DRY RUN');
    }
    console.log();

    const result = await skyway.Migrate();

    PrintMigrateSummary(
      result.MigrationsApplied,
      result.TotalExecutionTimeMS,
      result.CurrentVersion,
      result.Success,
      result.ErrorMessage
    );

    return result.Success;
  } finally {
    await skyway.Close();
  }
}
