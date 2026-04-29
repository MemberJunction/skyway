/**
 * @module db/types
 * Database connection configuration types for Skyway.
 */

import { DatabaseDialect } from './provider';

/**
 * Configuration for connecting to a database instance.
 *
 * Works with any supported dialect. The `Dialect` field determines
 * which provider is used and which defaults apply (port, schema, etc.).
 */
export interface DatabaseConfig {
  /**
   * The database dialect to use.
   * Defaults to `'sqlserver'` for backward compatibility.
   */
  Dialect?: DatabaseDialect;

  /** Database server hostname or IP address */
  Server: string;

  /**
   * Database server port.
   * Defaults to 1433 for SQL Server, 5432 for PostgreSQL.
   */
  Port?: number;

  /** Database name to connect to */
  Database: string;

  /** Login username */
  User: string;

  /** Login password */
  Password: string;

  /** Additional connection options */
  Options?: DatabaseConnectionOptions;
}

/**
 * Extended connection options for fine-tuning database connectivity.
 * Some options are dialect-specific — irrelevant options are ignored
 * by providers that don't support them.
 */
export interface DatabaseConnectionOptions {
  // ─── SQL Server Options ──────────────────────────────────────────

  /** Whether to encrypt the connection. Defaults to true (SQL Server) */
  Encrypt?: boolean;

  /** Whether to trust self-signed certificates. Defaults to true (SQL Server) */
  TrustServerCertificate?: boolean;

  /** Enable arithmetic abort. Defaults to true (SQL Server) */
  EnableArithAbort?: boolean;

  // ─── PostgreSQL Options ──────────────────────────────────────────

  /**
   * SSL configuration for PostgreSQL connections.
   * Set to `true` for default SSL, or pass an object for custom SSL config.
   */
  SSL?: boolean | Record<string, unknown>;

  // ─── Common Options ──────────────────────────────────────────────

  /** Request timeout in milliseconds. Defaults to 300000 (5 minutes) */
  RequestTimeout?: number;

  /** Connection timeout in milliseconds. Defaults to 30000 (30 seconds) */
  ConnectionTimeout?: number;
}
