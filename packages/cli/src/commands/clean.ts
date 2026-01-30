/**
 * @module commands/clean
 * Implementation of the `skyway clean` CLI command.
 */

import { Skyway, SkywayConfig } from '@skyway/core';
import { LogInfo, LogSuccess, LogError } from '../formatting';

/**
 * Executes the clean command: drops all objects in the configured schema.
 *
 * @param config - Resolved Skyway configuration
 */
export async function RunClean(config: SkywayConfig): Promise<boolean> {
  const skyway = new Skyway(config);
  skyway.OnProgress({ OnLog: LogInfo });

  try {
    LogInfo(`Database: ${config.Database.Server}:${config.Database.Port ?? 1433}/${config.Database.Database}`);
    LogInfo(`Schema: ${config.Migrations.DefaultSchema ?? 'dbo'}`);
    console.log();

    const result = await skyway.Clean();

    if (result.Success) {
      LogSuccess(`Clean completed: ${result.ObjectsDropped} object(s) dropped`);
    } else {
      LogError(result.ErrorMessage ?? 'Clean failed');
    }

    console.log();
    return result.Success;
  } finally {
    await skyway.Close();
  }
}
