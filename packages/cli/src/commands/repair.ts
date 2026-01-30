/**
 * @module commands/repair
 * Implementation of the `skyway repair` CLI command.
 */

import { Skyway, SkywayConfig } from '@skyway/core';
import { LogInfo, LogSuccess, LogError } from '../formatting';

/**
 * Executes the repair command: removes failed entries and realigns checksums.
 *
 * @param config - Resolved Skyway configuration
 */
export async function RunRepair(config: SkywayConfig): Promise<boolean> {
  const skyway = new Skyway(config);
  skyway.OnProgress({ OnLog: LogInfo });

  try {
    LogInfo(`Database: ${config.Database.Server}:${config.Database.Port ?? 1433}/${config.Database.Database}`);
    LogInfo(`Schema: ${config.Migrations.DefaultSchema ?? 'dbo'}`);
    console.log();

    const result = await skyway.Repair();

    if (result.Success) {
      LogSuccess(
        `Repair completed: ${result.FailedEntriesRemoved} failed entry(ies) removed, ` +
        `${result.ChecksumsRealigned} checksum(s) realigned`
      );
    } else {
      LogError(result.ErrorMessage ?? 'Repair failed');
    }

    console.log();
    return result.Success;
  } finally {
    await skyway.Close();
  }
}
