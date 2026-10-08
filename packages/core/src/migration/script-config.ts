/**
 * @module migration/script-config
 * Flyway-compatible per-script configuration files.
 *
 * A migration `V1__add_index.sql` may have a sibling `V1__add_index.sql.conf` holding
 * `key=value` lines, as Flyway supports. Skyway reads `executeInTransaction`; other keys are
 * ignored so files written for Flyway still load.
 */

import * as fs from 'fs';

/** Settings Skyway honors from a script config file. */
export interface ScriptConfig {
  /** `executeInTransaction=false` runs the migration outside a transaction. */
  ExecuteInTransaction?: boolean;
}

/** Suffix of a script config file, appended to the migration's full file name. */
export const SCRIPT_CONFIG_SUFFIX = '.conf';

/**
 * Parses script config file content: one `key=value` per line, `#` comments and blank lines
 * ignored, keys case-insensitive.
 *
 * @throws Error when `executeInTransaction` has a value other than true or false
 */
export function ParseScriptConfig(content: string, sourceName = 'script config'): ScriptConfig {
  const config: ScriptConfig = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (key === 'executeintransaction') {
      if (value !== 'true' && value !== 'false') {
        throw new Error(`${sourceName}: executeInTransaction must be true or false (got "${value}")`);
      }
      config.ExecuteInTransaction = value === 'true';
    }
  }
  return config;
}

/** Reads `<migrationPath>.conf` when it exists; an empty config otherwise. */
export async function LoadScriptConfig(migrationPath: string): Promise<ScriptConfig> {
  const configPath = migrationPath + SCRIPT_CONFIG_SUFFIX;
  let content: string;
  try {
    content = await fs.promises.readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
  return ParseScriptConfig(content, configPath);
}
