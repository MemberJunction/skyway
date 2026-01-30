/**
 * @module commands/migrate
 * Implementation of the `skyway migrate` CLI command.
 */

import { Skyway } from '@skyway/core';
import { SkywayConfig } from '@skyway/core';
import { LogMigrationStart, LogMigrationEnd, LogInfo, LogSuccess, LogError } from '../formatting';

/**
 * Executes the migrate command: applies all pending migrations.
 *
 * @param config - Resolved Skyway configuration
 */
export async function RunMigrate(config: SkywayConfig): Promise<boolean> {
  const skyway = new Skyway(config);

  skyway.OnProgress({
    OnMigrationStart: LogMigrationStart,
    OnMigrationEnd: LogMigrationEnd,
    OnLog: LogInfo,
  });

  try {
    LogInfo(`Database: ${config.Database.Server}:${config.Database.Port ?? 1433}/${config.Database.Database}`);
    LogInfo(`Schema: ${config.Migrations.DefaultSchema ?? 'dbo'}`);
    LogInfo(`Locations: ${config.Migrations.Locations.join(', ')}`);
    LogInfo(`Transaction mode: ${config.TransactionMode ?? 'per-run'}`);
    console.log();

    const result = await skyway.Migrate();

    if (result.Success) {
      LogSuccess(
        `Successfully applied ${result.MigrationsApplied} migration(s) ` +
          `(${result.TotalExecutionTimeMS}ms)`
      );
      if (result.CurrentVersion) {
        LogInfo(`Current version: ${result.CurrentVersion}`);
      }
    } else {
      LogError(result.ErrorMessage ?? 'Migration failed');
    }

    console.log();
    return result.Success;
  } finally {
    await skyway.Close();
  }
}
