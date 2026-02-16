/**
 * @module commands/validate
 * Implementation of the `skyway validate` CLI command.
 */

import { Skyway, SkywayConfig } from '@memberjunction/skyway-core';
import { LogInfo, LogSuccess, LogError } from '../formatting';

/**
 * Executes the validate command: verifies checksums of applied migrations.
 *
 * @param config - Resolved Skyway configuration
 */
export async function RunValidate(config: SkywayConfig): Promise<boolean> {
  const skyway = new Skyway(config);

  try {
    LogInfo(`Validating migrations against ${config.Database.Database}...`);
    console.log();

    const result = await skyway.Validate();

    if (result.Valid) {
      LogSuccess('All migrations validated successfully');
    } else {
      LogError('Validation failed:');
      for (const error of result.Errors) {
        console.log(`    - ${error}`);
      }
    }

    console.log();
    return result.Valid;
  } catch (err) {
    LogError(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    await skyway.Close();
  }
}
