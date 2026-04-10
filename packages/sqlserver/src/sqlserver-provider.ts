/**
 * @module sqlserver-provider
 * SQL Server implementation of the Skyway DatabaseProvider interface.
 *
 * Wraps the `mssql` (tedious) driver to provide connection management,
 * transaction handling, history table operations, and schema cleanup
 * for SQL Server databases.
 */

import * as sql from 'mssql';
import {
  DatabaseProvider,
  DatabaseDialect,
  ProviderTransaction,
  HistoryTableProvider,
  HistoryInsertParams,
  CleanOperation,
} from '@memberjunction/skyway-core';
import { DatabaseConfig } from '@memberjunction/skyway-core';
import { HistoryRecord } from '@memberjunction/skyway-core';
import { SplitOnGO, SQLBatch } from '@memberjunction/skyway-core';

/**
 * SQL Server provider for Skyway.
 *
 * Uses a single-connection pool to guarantee that all batches within
 * a transaction share the same underlying connection.
 */
export class SqlServerProvider implements DatabaseProvider {
  private pool: sql.ConnectionPool | null = null;
  private readonly config: DatabaseConfig;
  private readonly historyProvider: SqlServerHistoryProvider;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.historyProvider = new SqlServerHistoryProvider(this);
  }

  // ─── Dialect Info ──────────────────────────────────────────────────

  get Dialect(): DatabaseDialect {
    return 'sqlserver';
  }

  get DefaultSchema(): string {
    return 'dbo';
  }

  get DefaultPort(): number {
    return 1433;
  }

  // ─── Connection Lifecycle ──────────────────────────────────────────

  async Connect(): Promise<void> {
    if (this.pool?.connected) {
      return;
    }

    const mssqlConfig: sql.config = {
      server: this.config.Server,
      port: this.config.Port ?? 1433,
      user: this.config.User,
      password: this.config.Password,
      database: this.config.Database,
      options: {
        encrypt: this.config.Options?.Encrypt ?? true,
        trustServerCertificate: this.config.Options?.TrustServerCertificate ?? true,
        enableArithAbort: this.config.Options?.EnableArithAbort ?? true,
      },
      pool: {
        max: 1,
        min: 1,
      },
      requestTimeout: this.config.Options?.RequestTimeout ?? 300_000,
      connectionTimeout: this.config.Options?.ConnectionTimeout ?? 30_000,
    };

    this.pool = new sql.ConnectionPool(mssqlConfig);
    await this.pool.connect();
  }

  async Disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  get IsConnected(): boolean {
    return this.pool?.connected ?? false;
  }

  // ─── Database-Level Operations ─────────────────────────────────────

  async DatabaseExists(dbName: string): Promise<boolean> {
    const masterPool = await this.connectToMaster();
    try {
      const request = new sql.Request(masterPool);
      const result = await request.query(`SELECT DB_ID('${dbName}') AS dbid`);
      return result.recordset[0].dbid !== null;
    } finally {
      await masterPool.close();
    }
  }

  async CreateDatabase(dbName: string): Promise<void> {
    const masterPool = await this.connectToMaster();
    try {
      const result = await new sql.Request(masterPool).query(
        `SELECT DB_ID('${dbName}') AS dbid`
      );
      if (result.recordset[0].dbid === null) {
        await new sql.Request(masterPool).batch(`CREATE DATABASE [${dbName}]`);
      }
    } finally {
      await masterPool.close();
    }
  }

  async DropDatabase(dbName: string): Promise<void> {
    const masterPool = await this.connectToMaster();
    try {
      const result = await new sql.Request(masterPool).query(
        `SELECT DB_ID('${dbName}') AS dbid`
      );
      if (result.recordset[0].dbid !== null) {
        await new sql.Request(masterPool).batch(`
          ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
          DROP DATABASE [${dbName}];
        `);
      }
    } finally {
      await masterPool.close();
    }
  }

  // ─── Transaction Management ────────────────────────────────────────

  async BeginTransaction(): Promise<ProviderTransaction> {
    const pool = this.getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    return new SqlServerTransaction(transaction);
  }

  // ─── Direct Execution ──────────────────────────────────────────────

  async Execute(sqlText: string): Promise<void> {
    const pool = this.getPool();
    await new sql.Request(pool).batch(sqlText);
  }

  async Query<T = Record<string, unknown>>(sqlText: string): Promise<T[]> {
    const pool = this.getPool();
    const result = await new sql.Request(pool).query(sqlText);
    return result.recordset as T[];
  }

  // ─── Script Splitting ──────────────────────────────────────────────

  SplitScript(script: string): SQLBatch[] {
    return SplitOnGO(script);
  }

  // ─── History Table ─────────────────────────────────────────────────

  get History(): HistoryTableProvider {
    return this.historyProvider;
  }

  // ─── Schema Cleanup ────────────────────────────────────────────────

  async GetCleanOperations(schema: string): Promise<CleanOperation[]> {
    const pool = this.getPool();
    const operations: CleanOperation[] = [];

    // 1. Drop foreign key constraints
    const fkResult = await pool.request().query(`
      SELECT fk.name AS FKName, OBJECT_NAME(fk.parent_object_id) AS TableName
      FROM sys.foreign_keys fk
      JOIN sys.tables t ON fk.parent_object_id = t.object_id
      WHERE SCHEMA_NAME(t.schema_id) = '${schema}'
    `);
    for (const row of fkResult.recordset) {
      operations.push({
        SQL: `ALTER TABLE [${schema}].[${row.TableName}] DROP CONSTRAINT [${row.FKName}]`,
        Label: `FK constraint [${row.FKName}] on [${schema}].[${row.TableName}]`,
      });
    }

    // 2. Drop views
    const viewResult = await pool.request().query(`
      SELECT name FROM sys.views WHERE schema_id = SCHEMA_ID('${schema}')
    `);
    for (const row of viewResult.recordset) {
      operations.push({
        SQL: `DROP VIEW [${schema}].[${row.name}]`,
        Label: `View [${schema}].[${row.name}]`,
      });
    }

    // 3. Drop stored procedures
    const spResult = await pool.request().query(`
      SELECT name FROM sys.procedures WHERE schema_id = SCHEMA_ID('${schema}')
    `);
    for (const row of spResult.recordset) {
      operations.push({
        SQL: `DROP PROCEDURE [${schema}].[${row.name}]`,
        Label: `Procedure [${schema}].[${row.name}]`,
      });
    }

    // 4. Drop functions
    const fnResult = await pool.request().query(`
      SELECT name FROM sys.objects
      WHERE schema_id = SCHEMA_ID('${schema}')
        AND type IN ('FN', 'IF', 'TF')
    `);
    for (const row of fnResult.recordset) {
      operations.push({
        SQL: `DROP FUNCTION [${schema}].[${row.name}]`,
        Label: `Function [${schema}].[${row.name}]`,
      });
    }

    // 5. Drop user-defined types
    const typeResult = await pool.request().query(`
      SELECT name FROM sys.types
      WHERE schema_id = SCHEMA_ID('${schema}') AND is_user_defined = 1
    `);
    for (const row of typeResult.recordset) {
      operations.push({
        SQL: `DROP TYPE [${schema}].[${row.name}]`,
        Label: `Type [${schema}].[${row.name}]`,
      });
    }

    // 6. Drop tables
    const tableResult = await pool.request().query(`
      SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('${schema}')
    `);
    for (const row of tableResult.recordset) {
      operations.push({
        SQL: `DROP TABLE [${schema}].[${row.name}]`,
        Label: `Table [${schema}].[${row.name}]`,
      });
    }

    return operations;
  }

  async DropSchema(schema: string): Promise<void> {
    if (schema.toLowerCase() === 'dbo') {
      return; // Never drop the built-in dbo schema
    }

    const pool = this.getPool();
    const result = await pool.request().query(
      `SELECT COUNT(*) AS cnt FROM sys.schemas WHERE name = '${schema}'`
    );
    if (result.recordset[0].cnt > 0) {
      await pool.request().batch(`DROP SCHEMA [${schema}]`);
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────────

  /**
   * Returns the active connection pool.
   * @throws Error if not connected.
   * @internal — exposed for SqlServerHistoryProvider, not part of public API
   */
  getPool(): sql.ConnectionPool {
    if (!this.pool?.connected) {
      throw new Error(
        'Connection pool is not connected. Call Connect() before accessing the pool.'
      );
    }
    return this.pool;
  }

  /**
   * Connects to the SQL Server instance without specifying a database.
   * Used for database-level operations like CREATE DATABASE / DROP DATABASE.
   */
  private async connectToMaster(): Promise<sql.ConnectionPool> {
    const mssqlConfig: sql.config = {
      server: this.config.Server,
      port: this.config.Port ?? 1433,
      user: this.config.User,
      password: this.config.Password,
      database: 'master',
      options: {
        encrypt: this.config.Options?.Encrypt ?? true,
        trustServerCertificate: this.config.Options?.TrustServerCertificate ?? true,
        enableArithAbort: this.config.Options?.EnableArithAbort ?? true,
      },
      pool: {
        max: 1,
        min: 1,
      },
      requestTimeout: this.config.Options?.RequestTimeout ?? 300_000,
      connectionTimeout: this.config.Options?.ConnectionTimeout ?? 30_000,
    };

    const masterPool = new sql.ConnectionPool(mssqlConfig);
    await masterPool.connect();
    return masterPool;
  }
}

// ─── SqlServerTransaction ────────────────────────────────────────────

/**
 * Wraps an `mssql.Transaction` as a `ProviderTransaction`.
 */
class SqlServerTransaction implements ProviderTransaction {
  /** @internal — exposed for SqlServerHistoryProvider to create requests against this transaction */
  readonly RawTransaction: sql.Transaction;

  private get transaction(): sql.Transaction {
    return this.RawTransaction;
  }

  constructor(transaction: sql.Transaction) {
    this.RawTransaction = transaction;
  }

  async Execute(sqlText: string): Promise<void> {
    const request = new sql.Request(this.transaction);
    await request.batch(sqlText);
  }

  async Query<T = Record<string, unknown>>(sqlText: string): Promise<T[]> {
    const request = new sql.Request(this.transaction);
    const result = await request.query(sqlText);
    return result.recordset as T[];
  }

  async Commit(): Promise<void> {
    await this.transaction.commit();
  }

  async Rollback(): Promise<void> {
    await this.transaction.rollback();
  }
}

// ─── SqlServerHistoryProvider ────────────────────────────────────────

/**
 * SQL Server implementation of `HistoryTableProvider`.
 *
 * Uses SQL Server-specific DDL and parameterized queries:
 * - `NVARCHAR`, `DATETIME`, `BIT` types
 * - `GETDATE()` for timestamps
 * - `ISNULL()` for null coalescing
 * - `[bracket]` quoting
 * - `@param` named parameters with explicit `sql.Int`, `sql.NVarChar` types
 */
class SqlServerHistoryProvider implements HistoryTableProvider {
  private readonly provider: SqlServerProvider;

  constructor(provider: SqlServerProvider) {
    this.provider = provider;
  }

  private qualifiedName(schema: string, tableName: string): string {
    return `[${schema}].[${tableName}]`;
  }

  private createRequest(txn?: ProviderTransaction): sql.Request {
    if (txn) {
      const sqlServerTxn = txn as SqlServerTransaction;
      return new sql.Request(sqlServerTxn.RawTransaction);
    }
    return new sql.Request(this.provider.getPool());
  }

  async EnsureExists(schema: string, tableName: string, txn?: ProviderTransaction): Promise<void> {
    const qualifiedName = this.qualifiedName(schema, tableName);

    // Create schema if it doesn't exist
    const schemaRequest = this.createRequest(txn);
    await schemaRequest.batch(`
      IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${schema}')
      BEGIN
        EXEC('CREATE SCHEMA [${schema}]')
      END
    `);

    // Create history table if it doesn't exist
    const tableRequest = this.createRequest(txn);
    await tableRequest.batch(`
      IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${tableName}'
      )
      BEGIN
        CREATE TABLE ${qualifiedName} (
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
          CONSTRAINT [${tableName}_pk] PRIMARY KEY ([installed_rank])
        );

        CREATE INDEX [${tableName}_s_idx]
          ON ${qualifiedName} ([success]);
      END
    `);
  }

  async Exists(schema: string, tableName: string): Promise<boolean> {
    const pool = this.provider.getPool();
    const result = await new sql.Request(pool).query(`
      SELECT COUNT(*) AS cnt
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${tableName}'
    `);
    return result.recordset[0].cnt > 0;
  }

  async GetAllRecords(schema: string, tableName: string, txn?: ProviderTransaction): Promise<HistoryRecord[]> {
    const qualifiedName = this.qualifiedName(schema, tableName);
    const request = this.createRequest(txn);
    const result = await request.query(
      `SELECT * FROM ${qualifiedName} ORDER BY [installed_rank]`
    );
    return result.recordset.map(mapRowToRecord);
  }

  async GetNextRank(schema: string, tableName: string, txn?: ProviderTransaction): Promise<number> {
    const qualifiedName = this.qualifiedName(schema, tableName);
    const request = this.createRequest(txn);
    const result = await request.query(
      `SELECT ISNULL(MAX([installed_rank]), -1) + 1 AS next_rank FROM ${qualifiedName}`
    );
    return result.recordset[0].next_rank;
  }

  async InsertRecord(
    schema: string,
    tableName: string,
    record: HistoryInsertParams,
    txn?: ProviderTransaction
  ): Promise<void> {
    const qualifiedName = this.qualifiedName(schema, tableName);
    const request = this.createRequest(txn);

    request.input('installedRank', sql.Int, record.InstalledRank);
    request.input('version', sql.NVarChar(50), record.Version);
    request.input('description', sql.NVarChar(200), record.Description);
    request.input('type', sql.NVarChar(20), record.Type);
    request.input('script', sql.NVarChar(1000), record.Script);
    request.input('checksum', sql.Int, record.Checksum);
    request.input('installedBy', sql.NVarChar(100), record.InstalledBy);
    request.input('executionTime', sql.Int, record.ExecutionTime);
    request.input('success', sql.Bit, record.Success);

    await request.query(`
      INSERT INTO ${qualifiedName}
        ([installed_rank], [version], [description], [type], [script],
         [checksum], [installed_by], [execution_time], [success])
      VALUES
        (@installedRank, @version, @description, @type, @script,
         @checksum, @installedBy, @executionTime, @success)
    `);
  }

  async DeleteRecord(
    schema: string,
    tableName: string,
    installedRank: number,
    txn?: ProviderTransaction
  ): Promise<void> {
    const qualifiedName = this.qualifiedName(schema, tableName);
    const request = this.createRequest(txn);
    request.input('rank', sql.Int, installedRank);
    await request.query(
      `DELETE FROM ${qualifiedName} WHERE [installed_rank] = @rank`
    );
  }

  async UpdateChecksum(
    schema: string,
    tableName: string,
    installedRank: number,
    newChecksum: number,
    txn?: ProviderTransaction
  ): Promise<void> {
    const qualifiedName = this.qualifiedName(schema, tableName);
    const request = this.createRequest(txn);
    request.input('rank', sql.Int, installedRank);
    request.input('checksum', sql.Int, newChecksum);
    await request.query(
      `UPDATE ${qualifiedName} SET [checksum] = @checksum WHERE [installed_rank] = @rank`
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Maps a raw database row to a typed HistoryRecord.
 */
function mapRowToRecord(row: Record<string, unknown>): HistoryRecord {
  return {
    InstalledRank: row.installed_rank as number,
    Version: (row.version as string) ?? null,
    Description: row.description as string,
    Type: row.type as HistoryRecord['Type'],
    Script: row.script as string,
    Checksum: (row.checksum as number) ?? null,
    InstalledBy: row.installed_by as string,
    InstalledOn: row.installed_on as Date,
    ExecutionTime: row.execution_time as number,
    Success: row.success as boolean,
  };
}
