/**
 * @module config-loader
 * Loads Skyway configuration from files and environment variables.
 *
 * Configuration is loaded in order of precedence (highest first):
 * 1. CLI flags (passed directly)
 * 2. Environment variables
 * 3. Config file (skyway.json or skyway.config.js)
 * 4. .env file (via dotenv)
 * 5. Built-in defaults
 */

import * as fs from 'fs';
import * as path from 'path';
import { SkywayConfig } from '@skyway/core';

/**
 * Configuration file names searched in order.
 */
const CONFIG_FILE_NAMES = [
  'skyway.json',
  'skyway.config.json',
  'skyway.config.js',
  'skyway.config.cjs',
];

/**
 * CLI options that can override config file settings.
 */
export interface CLIOptions {
  /** Database server hostname */
  Server?: string;

  /** Database server port */
  Port?: number;

  /** Database name */
  Database?: string;

  /** Database user */
  User?: string;

  /** Database password */
  Password?: string;

  /** Migration locations (comma-separated paths) */
  Locations?: string;

  /** Default schema name */
  Schema?: string;

  /** History table name */
  Table?: string;

  /** Baseline version */
  BaselineVersion?: string;

  /** Whether to auto-baseline */
  BaselineOnMigrate?: boolean;

  /** Transaction mode */
  TransactionMode?: string;

  /** Trust server certificate */
  TrustServerCertificate?: boolean;

  /** Path to config file */
  Config?: string;

  /** Placeholders in key=value format */
  Placeholders?: string[];
}

/**
 * Loads and merges configuration from all sources.
 *
 * @param cliOptions - Options passed via CLI flags
 * @param cwd - Working directory for config file discovery
 * @returns Merged SkywayConfig
 * @throws Error if required configuration is missing
 */
export function LoadConfig(cliOptions: CLIOptions, cwd: string = process.cwd()): SkywayConfig {
  // Load .env file if present
  try {
    require('dotenv').config({ path: path.join(cwd, '.env') });
  } catch {
    // dotenv is optional
  }

  // Load config file
  const fileConfig = loadConfigFile(cliOptions.Config, cwd);

  // Merge: CLI > env > file > defaults
  const server = cliOptions.Server
    ?? process.env.SKYWAY_SERVER ?? process.env.DB_HOST
    ?? fileConfig?.Database?.Server
    ?? 'localhost';

  const port = cliOptions.Port
    ?? (process.env.SKYWAY_PORT ? parseInt(process.env.SKYWAY_PORT) : undefined)
    ?? (process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined)
    ?? fileConfig?.Database?.Port
    ?? 1433;

  const database = cliOptions.Database
    ?? process.env.SKYWAY_DATABASE ?? process.env.DB_DATABASE
    ?? fileConfig?.Database?.Database;

  const user = cliOptions.User
    ?? process.env.SKYWAY_USER ?? process.env.DB_USER
    ?? fileConfig?.Database?.User;

  const password = cliOptions.Password
    ?? process.env.SKYWAY_PASSWORD ?? process.env.DB_PASSWORD
    ?? fileConfig?.Database?.Password;

  if (!database) {
    throw new Error('Database name is required. Set via --database, SKYWAY_DATABASE env var, or config file.');
  }
  if (!user) {
    throw new Error('Database user is required. Set via --user, SKYWAY_USER env var, or config file.');
  }
  if (!password) {
    throw new Error('Database password is required. Set via --password, SKYWAY_PASSWORD env var, or config file.');
  }

  const locations = cliOptions.Locations
    ? cliOptions.Locations.split(',').map((l) => l.trim())
    : fileConfig?.Migrations?.Locations ?? ['./migrations'];

  const schema = cliOptions.Schema
    ?? process.env.SKYWAY_SCHEMA
    ?? fileConfig?.Migrations?.DefaultSchema
    ?? 'dbo';

  // Parse placeholders from CLI (key=value pairs)
  const placeholders: Record<string, string> = { ...fileConfig?.Placeholders };
  if (cliOptions.Placeholders) {
    for (const p of cliOptions.Placeholders) {
      const eqIdx = p.indexOf('=');
      if (eqIdx > 0) {
        placeholders[p.substring(0, eqIdx)] = p.substring(eqIdx + 1);
      }
    }
  }

  return {
    Database: {
      Server: server,
      Port: port,
      Database: database,
      User: user,
      Password: password,
      Options: {
        TrustServerCertificate: cliOptions.TrustServerCertificate
          ?? fileConfig?.Database?.Options?.TrustServerCertificate
          ?? true,
        Encrypt: fileConfig?.Database?.Options?.Encrypt ?? false,
        RequestTimeout: fileConfig?.Database?.Options?.RequestTimeout ?? 300_000,
      },
    },
    Migrations: {
      Locations: locations,
      DefaultSchema: schema,
      HistoryTable: cliOptions.Table
        ?? fileConfig?.Migrations?.HistoryTable
        ?? 'flyway_schema_history',
      BaselineVersion: cliOptions.BaselineVersion
        ?? fileConfig?.Migrations?.BaselineVersion
        ?? '1',
      BaselineOnMigrate: cliOptions.BaselineOnMigrate
        ?? fileConfig?.Migrations?.BaselineOnMigrate
        ?? false,
      OutOfOrder: fileConfig?.Migrations?.OutOfOrder ?? false,
    },
    Placeholders: placeholders,
    TransactionMode: (cliOptions.TransactionMode as 'per-run' | 'per-migration')
      ?? fileConfig?.TransactionMode
      ?? 'per-run',
  };
}

/**
 * Searches for and loads a config file.
 */
function loadConfigFile(
  explicitPath: string | undefined,
  cwd: string
): Partial<SkywayConfig> | null {
  if (explicitPath) {
    const fullPath = path.resolve(cwd, explicitPath);
    if (fs.existsSync(fullPath)) {
      return loadFile(fullPath);
    }
    throw new Error(`Config file not found: ${fullPath}`);
  }

  // Search for config files
  for (const name of CONFIG_FILE_NAMES) {
    const fullPath = path.join(cwd, name);
    if (fs.existsSync(fullPath)) {
      return loadFile(fullPath);
    }
  }

  return null;
}

/**
 * Loads a single config file (JSON or JS).
 */
function loadFile(filePath: string): Partial<SkywayConfig> {
  if (filePath.endsWith('.json')) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }
  // JS/CJS files
  return require(filePath);
}
