/**
 * @module commands/baseline
 * Implementation of the `skyway baseline` CLI command.
 */

import { Skyway, SkywayConfig } from '@skyway/core';
import { LogInfo, LogSuccess, LogError } from '../formatting';

/**
 * Executes the baseline command: marks the database as baselined at a version.
 *
 * @param config - Resolved Skyway configuration
 * @param version - Optional version override (uses config BaselineVersion if not specified)
 */
export async function RunBaseline(config: SkywayConfig, version?: string): Promise<boolean> {
  const skyway = new Skyway(config);
  skyway.OnProgress({ OnLog: LogInfo });

  try {
    LogInfo(`Database: ${config.Database.Server}:${config.Database.Port ?? 1433}/${config.Database.Database}`);
    LogInfo(`Schema: ${config.Migrations.DefaultSchema ?? 'dbo'}`);
    LogInfo(`Baseline version: ${version ?? config.Migrations.BaselineVersion ?? '1'}`);
    console.log();

    const result = await skyway.Baseline(version);

    if (result.Success) {
      LogSuccess(`Baselined at version ${result.BaselineVersion}`);
    } else {
      LogError(result.ErrorMessage ?? 'Baseline failed');
    }

    console.log();
    return result.Success;
  } finally {
    await skyway.Close();
  }
}
