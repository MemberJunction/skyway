/**
 * @module history/history-table
 * Manages the `flyway_schema_history` table — creating it if it doesn't
 * exist, querying applied migrations, and inserting new records.
 *
 * The table schema matches Flyway's SQL Server implementation exactly,
 * ensuring full compatibility with existing Flyway-managed databases.
 */

import * as sql from 'mssql';
import { HistoryRecord, HistoryRecordType } from './types';
import { ResolvedMigration } from '../migration/types';

/**
 * Manages the schema history table for tracking applied migrations.
 *
 * All methods accept an optional `sql.Transaction` parameter. When provided,
 * queries execute within that transaction. When omitted, queries execute
 * directly against the connection pool.
 */
export class HistoryTable {
  private readonly schema: string;
  private readonly tableName: string;
  private readonly pool: sql.ConnectionPool;

  /**
   * @param pool - Connected SQL Server connection pool
   * @param schema - Schema name (e.g., "__mj" or "dbo")
   * @param tableName - History table name (default: "flyway_schema_history")
   */
  constructor(
    pool: sql.ConnectionPool,
    schema: string,
    tableName: string = 'flyway_schema_history'
  ) {
    this.pool = pool;
    this.schema = schema;
    this.tableName = tableName;
  }

  /**
   * Creates a new sql.Request bound to the given transaction or pool.
   */
  private createRequest(connectionSource?: sql.Transaction): sql.Request {
    if (connectionSource) {
      return new sql.Request(connectionSource);
    }
    return new sql.Request(this.pool);
  }

  /**
   * The fully qualified table name: `[schema].[tableName]`.
   */
  get QualifiedName(): string {
    return `[${this.schema}].[${this.tableName}]`;
  }

  /**
   * Creates the schema (if needed) and history table (if it doesn't exist).
   * Also creates the success index matching Flyway's schema.
   *
   * @param connectionSource - Transaction or pool to execute against
   */
  async EnsureExists(connectionSource?: sql.Transaction): Promise<void> {
    const request = this.createRequest(connectionSource);

    // Create schema if it doesn't exist
    await request.batch(`
      IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${this.schema}')
      BEGIN
        EXEC('CREATE SCHEMA [${this.schema}]')
      END
    `);

    // Create history table if it doesn't exist
    const createRequest = this.createRequest(connectionSource);
    await createRequest.batch(`
      IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = '${this.schema}' AND TABLE_NAME = '${this.tableName}'
      )
      BEGIN
        CREATE TABLE ${this.QualifiedName} (
          [installed_rank]  INT            NOT NULL,
          [version]         NVARCHAR(50)   NULL,
          [description]     NVARCHAR(200)  NOT NULL,
          [type]            NVARCHAR(20)   NOT NULL,
          [script]          NVARCHAR(1000) NOT NULL,
          [checksum]        INT            NULL,
          [installed_by]    NVARCHAR(100)  NOT NULL,
          [installed_on]    DATETIME       NOT NULL DEFAULT GETDATE(),
          [execution_time]  INT            NOT NULL,
          [success]         BIT            NOT NULL,
          CONSTRAINT [${this.tableName}_pk] PRIMARY KEY ([installed_rank])
        );

        CREATE INDEX [${this.tableName}_s_idx]
          ON ${this.QualifiedName} ([success]);
      END
    `);
  }

  /**
   * Returns true if the history table exists in the database.
   */
  async Exists(): Promise<boolean> {
    const request = new sql.Request(this.pool);
    const result = await request.query(`
      SELECT COUNT(*) AS cnt
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = '${this.schema}' AND TABLE_NAME = '${this.tableName}'
    `);
    return result.recordset[0].cnt > 0;
  }

  /**
   * Retrieves all records from the history table, ordered by installed_rank.
   *
   * @param connectionSource - Transaction or pool to execute against
   * @returns All history records
   */
  async GetAllRecords(
    connectionSource?: sql.Transaction
  ): Promise<HistoryRecord[]> {
    const request = this.createRequest(connectionSource);
    const result = await request.query(
      `SELECT * FROM ${this.QualifiedName} ORDER BY [installed_rank]`
    );

    return result.recordset.map(mapRowToRecord);
  }

  /**
   * Returns the next available installed_rank value.
   *
   * @param connectionSource - Transaction or pool to execute against
   */
  async GetNextRank(connectionSource?: sql.Transaction): Promise<number> {
    const request = this.createRequest(connectionSource);
    const result = await request.query(
      `SELECT ISNULL(MAX([installed_rank]), -1) + 1 AS next_rank FROM ${this.QualifiedName}`
    );
    return result.recordset[0].next_rank;
  }

  /**
   * Inserts the schema creation marker (installed_rank 0) that Flyway
   * writes when it first creates the schema.
   *
   * @param user - Database user name (e.g., "sa")
   * @param connectionSource - Transaction or pool to execute against
   */
  async InsertSchemaMarker(
    user: string,
    connectionSource?: sql.Transaction
  ): Promise<void> {
    const request = this.createRequest(connectionSource);
    request.input('installedRank', sql.Int, 0);
    request.input('description', sql.NVarChar(200), '<< Flyway Schema Creation >>');
    request.input('type', sql.NVarChar(20), 'SCHEMA');
    request.input('script', sql.NVarChar(1000), `[${this.schema}]`);
    request.input('installedBy', sql.NVarChar(100), user);
    request.input('executionTime', sql.Int, 0);
    request.input('success', sql.Bit, true);

    await request.query(`
      IF NOT EXISTS (
        SELECT 1 FROM ${this.QualifiedName} WHERE [installed_rank] = 0
      )
      INSERT INTO ${this.QualifiedName}
        ([installed_rank], [version], [description], [type], [script],
         [checksum], [installed_by], [execution_time], [success])
      VALUES
        (@installedRank, NULL, @description, @type, @script,
         NULL, @installedBy, @executionTime, @success)
    `);
  }

  /**
   * Records a successfully applied migration in the history table.
   *
   * @param migration - The resolved migration that was executed
   * @param rank - The installed_rank to assign
   * @param executionTimeMS - How long execution took in milliseconds
   * @param user - Database user who ran the migration
   * @param connectionSource - Transaction or pool to execute against
   */
  async InsertAppliedMigration(
    migration: ResolvedMigration,
    rank: number,
    executionTimeMS: number,
    user: string,
    connectionSource?: sql.Transaction
  ): Promise<void> {
    const type = this.resolveHistoryType(migration);

    const request = this.createRequest(connectionSource);
    request.input('installedRank', sql.Int, rank);
    request.input('version', sql.NVarChar(50), migration.Version);
    request.input('description', sql.NVarChar(200), migration.Description);
    request.input('type', sql.NVarChar(20), type);
    request.input('script', sql.NVarChar(1000), migration.ScriptPath);
    request.input('checksum', sql.Int, migration.Checksum);
    request.input('installedBy', sql.NVarChar(100), user);
    request.input('executionTime', sql.Int, executionTimeMS);
    request.input('success', sql.Bit, true);

    await request.query(`
      INSERT INTO ${this.QualifiedName}
        ([installed_rank], [version], [description], [type], [script],
         [checksum], [installed_by], [execution_time], [success])
      VALUES
        (@installedRank, @version, @description, @type, @script,
         @checksum, @installedBy, @executionTime, @success)
    `);
  }

  /**
   * Records a failed migration attempt in the history table.
   *
   * @param migration - The migration that failed
   * @param rank - The installed_rank to assign
   * @param executionTimeMS - How long execution took before failure
   * @param user - Database user who ran the migration
   * @param connectionSource - Transaction or pool to execute against
   */
  async InsertFailedMigration(
    migration: ResolvedMigration,
    rank: number,
    executionTimeMS: number,
    user: string,
    connectionSource?: sql.Transaction
  ): Promise<void> {
    const type = this.resolveHistoryType(migration);

    const request = this.createRequest(connectionSource);
    request.input('installedRank', sql.Int, rank);
    request.input('version', sql.NVarChar(50), migration.Version);
    request.input('description', sql.NVarChar(200), migration.Description);
    request.input('type', sql.NVarChar(20), type);
    request.input('script', sql.NVarChar(1000), migration.ScriptPath);
    request.input('checksum', sql.Int, migration.Checksum);
    request.input('installedBy', sql.NVarChar(100), user);
    request.input('executionTime', sql.Int, executionTimeMS);
    request.input('success', sql.Bit, false);

    await request.query(`
      INSERT INTO ${this.QualifiedName}
        ([installed_rank], [version], [description], [type], [script],
         [checksum], [installed_by], [execution_time], [success])
      VALUES
        (@installedRank, @version, @description, @type, @script,
         @checksum, @installedBy, @executionTime, @success)
    `);
  }

  /**
   * Maps a migration type to the Flyway history record type string.
   */
  private resolveHistoryType(migration: ResolvedMigration): HistoryRecordType {
    switch (migration.Type) {
      case 'baseline':
        return 'SQL_BASELINE';
      case 'versioned':
      case 'repeatable':
        return 'SQL';
      default:
        return 'SQL';
    }
  }
}

/**
 * Maps a raw database row to a typed HistoryRecord.
 */
function mapRowToRecord(row: Record<string, unknown>): HistoryRecord {
  return {
    InstalledRank: row.installed_rank as number,
    Version: (row.version as string) ?? null,
    Description: row.description as string,
    Type: row.type as HistoryRecordType,
    Script: row.script as string,
    Checksum: (row.checksum as number) ?? null,
    InstalledBy: row.installed_by as string,
    InstalledOn: row.installed_on as Date,
    ExecutionTime: row.execution_time as number,
    Success: row.success as boolean,
  };
}
