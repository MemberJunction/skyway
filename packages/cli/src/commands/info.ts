/**
 * @module commands/info
 * Implementation of the `skyway info` CLI command.
 */

import { Skyway, SkywayConfig } from '@skyway/core';
import { PrintInfoTable, LogInfo, LogError } from '../formatting';

/**
 * Executes the info command: displays migration status.
 *
 * @param config - Resolved Skyway configuration
 */
export async function RunInfo(config: SkywayConfig): Promise<boolean> {
  const skyway = new Skyway(config);

  try {
    LogInfo(`Database: ${config.Database.Server}:${config.Database.Port ?? 1433}/${config.Database.Database}`);
    console.log();

    const statuses = await skyway.Info();
    PrintInfoTable(statuses);

    const pending = statuses.filter((s) => s.State === 'PENDING' || s.State === 'OUTDATED');
    if (pending.length > 0) {
      LogInfo(`${pending.length} pending migration(s)`);
    } else {
      LogInfo('Schema is up to date');
    }

    console.log();
    return true;
  } catch (err) {
    LogError(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    await skyway.Close();
  }
}
