/**
 * @module commands/clean
 * Implementation of the `skyway clean` CLI command.
 */

import { Skyway, SkywayConfig } from '@memberjunction/skyway-core';
import { LogInfo, LogSuccess, LogError, LogConnectionInfo } from '../formatting';

/**
 * Executes the clean command: drops all objects in the configured schema.
 *
 * @param config - Resolved Skyway configuration
 */
export async function RunClean(config: SkywayConfig): Promise<boolean> {
  const skyway = new Skyway(config);
  skyway.OnProgress({ OnLog: LogInfo });

  try {
    LogConnectionInfo(config);
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
