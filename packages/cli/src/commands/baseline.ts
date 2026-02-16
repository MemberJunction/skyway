/**
 * @module commands/baseline
 * Implementation of the `skyway baseline` CLI command.
 */

import { Skyway, SkywayConfig, ScanAndResolveMigrations } from '@skyway/core';
import { LogInfo, LogSuccess, LogError } from '../formatting';

/**
 * Executes the baseline command: marks the database as baselined at a version.
 *
 * @param config - Resolved Skyway configuration
 * @param version - Optional version override (uses config BaselineVersion if not specified)
 */
export async function RunBaseline(config: SkywayConfig, version?: string): Promise<boolean> {
  let effectiveVersion = version ?? config.Migrations.BaselineVersion ?? '1';

  // Auto-select highest baseline if no explicit version was provided
  if (!version && effectiveVersion === '1') {
    const discovered = await ScanAndResolveMigrations(config.Migrations.Locations);
    const baselines = discovered
      .filter((m) => m.Type === 'baseline')
      .sort((a, b) => a.Version!.localeCompare(b.Version!));
    if (baselines.length > 0) {
      effectiveVersion = baselines[baselines.length - 1].Version!;
      LogInfo(`Auto-selected baseline version: ${effectiveVersion} (highest of ${baselines.length} baseline file(s))`);
    }
  }

  const skyway = new Skyway(config);
  skyway.OnProgress({ OnLog: LogInfo });

  try {
    LogInfo(`Database: ${config.Database.Server}:${config.Database.Port ?? 1433}/${config.Database.Database}`);
    LogInfo(`Schema: ${config.Migrations.DefaultSchema ?? 'dbo'}`);
    LogInfo(`Baseline version: ${effectiveVersion}`);
    console.log();

    const result = await skyway.Baseline(effectiveVersion);

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
