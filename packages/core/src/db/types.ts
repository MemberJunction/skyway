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

  /**
   * Lock wait timeout in milliseconds, applied at the start of every migration
   * transaction. If a statement can't get a lock within this time it fails and
   * the migration rolls back, instead of blocking every query queued behind it.
   * Unset (the default) changes nothing: SQL Server waits forever and
   * PostgreSQL uses the server's `lock_timeout`.
   *
   * Must be an integer from 0 to 2147483647. `0` means opposite things:
   * SQL Server fails at once if a lock is held, PostgreSQL disables the timeout.
   *
   * Migrations run with `executeInTransaction=false` skip the transaction, so
   * they are not covered.
   */
  LockTimeout?: number;

  /** Connection timeout in milliseconds. Defaults to 30000 (30 seconds) */
  ConnectionTimeout?: number;
}
