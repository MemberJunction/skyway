/**
 * @module core/errors
 * Custom error types for Skyway migration operations.
 */

/**
 * Base error class for all Skyway errors.
 * Provides a consistent error hierarchy with error codes for programmatic handling.
 */
export class SkywayError extends Error {
  /** Machine-readable error code for programmatic handling */
  readonly Code: string;

  constructor(code: string, message: string, cause?: Error) {
    super(message);
    this.name = 'SkywayError';
    this.Code = code;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when a migration file fails to execute against SQL Server.
 * Contains details about which migration failed and the SQL error.
 */
export class MigrationExecutionError extends SkywayError {
  /** The migration version that failed (e.g., "202601122300") */
  readonly Version: string | null;

  /** The migration script filename */
  readonly Script: string;

  /** The specific SQL batch that failed, if identifiable */
  readonly FailedSQL?: string;

  constructor(
    version: string | null,
    script: string,
    message: string,
    failedSQL?: string,
    cause?: Error
  ) {
    super('MIGRATION_EXECUTION_FAILED', message, cause);
    this.name = 'MigrationExecutionError';
    this.Version = version;
    this.Script = script;
    this.FailedSQL = failedSQL;
  }
}

/**
 * Thrown when a migration file has an invalid name that cannot be parsed.
 */
export class MigrationParseError extends SkywayError {
  /** The filename that could not be parsed */
  readonly Filename: string;

  constructor(filename: string, message: string) {
    super('MIGRATION_PARSE_FAILED', message);
    this.name = 'MigrationParseError';
    this.Filename = filename;
  }
}

/**
 * Thrown when checksum validation fails — an applied migration's file
 * has been modified since it was originally executed.
 */
export class ChecksumMismatchError extends SkywayError {
  /** The migration version with the mismatch */
  readonly Version: string;

  /** Checksum stored in the history table */
  readonly ExpectedChecksum: number;

  /** Checksum computed from the current file */
  readonly ActualChecksum: number;

  constructor(version: string, expected: number, actual: number) {
    super(
      'CHECKSUM_MISMATCH',
      `Checksum mismatch for migration version ${version}: ` +
        `expected ${expected} but found ${actual}. ` +
        `The migration file has been modified after it was applied.`
    );
    this.name = 'ChecksumMismatchError';
    this.Version = version;
    this.ExpectedChecksum = expected;
    this.ActualChecksum = actual;
  }
}

/**
 * Thrown when a transaction fails to commit or rollback.
 */
export class TransactionError extends SkywayError {
  constructor(message: string, cause?: Error) {
    super('TRANSACTION_FAILED', message, cause);
    this.name = 'TransactionError';
  }
}

/**
 * Thrown when the connection to SQL Server cannot be established.
 */
export class ConnectionError extends SkywayError {
  constructor(message: string, cause?: Error) {
    super('CONNECTION_FAILED', message, cause);
    this.name = 'ConnectionError';
  }
}
