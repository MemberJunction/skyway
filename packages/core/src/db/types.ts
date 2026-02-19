/**
 * @module db/types
 * Database connection configuration types for Skyway.
 */

/**
 * Configuration for connecting to a SQL Server instance.
 * Maps directly to the `mssql` package connection options with
 * sensible defaults for migration workloads.
 */
export interface DatabaseConfig {
  /** SQL Server hostname or IP address */
  Server: string;

  /** SQL Server port. Defaults to 1433 */
  Port?: number;

  /** Database name to connect to */
  Database: string;

  /** SQL Server login username */
  User: string;

  /** SQL Server login password */
  Password: string;

  /** Additional connection options */
  Options?: DatabaseConnectionOptions;
}

/**
 * Extended connection options for fine-tuning SQL Server connectivity.
 */
export interface DatabaseConnectionOptions {
  /** Whether to encrypt the connection. Defaults to true */
  Encrypt?: boolean;

  /** Whether to trust self-signed certificates. Defaults to true */
  TrustServerCertificate?: boolean;

  /** Enable arithmetic abort. Defaults to true */
  EnableArithAbort?: boolean;

  /** Request timeout in milliseconds. Defaults to 300000 (5 minutes) */
  RequestTimeout?: number;

  /** Connection timeout in milliseconds. Defaults to 30000 (30 seconds) */
  ConnectionTimeout?: number;
}
