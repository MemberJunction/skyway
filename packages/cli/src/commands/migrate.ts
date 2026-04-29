/**
 * @module commands/migrate
 * Implementation of the `skyway migrate` CLI command.
 */

import { Skyway } from '@memberjunction/skyway-core';
import { SkywayConfig } from '@memberjunction/skyway-core';
import {
  LogMigrationStart,
  LogMigrationEnd,
  LogInfo,
  LogBatchProgress,
  PrintMigrateSummary,
  LogConnectionInfo,
} from '../formatting';

/**
 * Executes the migrate command: applies all pending migrations.
 *
 * @param config - Resolved Skyway configuration
 * @param quiet - When true, suppress per-migration output
 * @param verbose - When true, enable per-batch progress logging
 */
export async function RunMigrate(config: SkywayConfig, quiet: boolean = false, verbose: boolean = false): Promise<boolean> {
  const skyway = new Skyway(config);

  if (!quiet) {
    skyway.OnProgress({
      OnMigrationStart: LogMigrationStart,
      OnMigrationEnd: LogMigrationEnd,
      OnBatchEnd: verbose ? LogBatchProgress : undefined,
      OnLog: LogInfo,
    });
  } else {
    skyway.OnProgress({
      OnLog: LogInfo,
    });
  }

  try {
    LogConnectionInfo(config);
    LogInfo(`Locations: ${config.Migrations.Locations.join(', ')}`);
    LogInfo(`Transaction mode: ${config.TransactionMode ?? 'per-run'}`);
    if (config.Verbose || verbose) {
      LogInfo('Verbose: enabled');
    }
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
      result.ErrorMessage,
      config.TransactionMode ?? 'per-run'
    );

    return result.Success;
  } finally {
    await skyway.Close();
  }
}
