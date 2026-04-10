/**
 * @module postgres-provider
 * PostgreSQL implementation of the Skyway DatabaseProvider interface.
 *
 * Uses the `pg` (node-postgres) driver to provide connection management,
 * transaction handling, history table operations, and schema cleanup
 * for PostgreSQL databases.
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
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
import { SQLBatch } from '@memberjunction/skyway-core';

/**
 * PostgreSQL provider for Skyway.
 *
 * Uses a `pg.Pool` with `max: 1` for sequential migration execution,
 * matching the single-connection pattern used by the SQL Server provider.
 */
export class PostgresProvider implements DatabaseProvider {
  private pool: Pool | null = null;
  private connected = false;
  private readonly config: DatabaseConfig;
  private readonly historyProvider: PostgresHistoryProvider;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.historyProvider = new PostgresHistoryProvider(this);
  }

  // ─── Dialect Info ──────────────────────────────────────────────────

  get Dialect(): DatabaseDialect {
    return 'postgresql';
  }

  get DefaultSchema(): string {
    return 'public';
  }

  get DefaultPort(): number {
    return 5432;
  }

  // ─── Connection Lifecycle ──────────────────────────────────────────

  async Connect(): Promise<void> {
    if (this.connected && this.pool) {
      return;
    }

    this.pool = new Pool(this.buildPoolConfig(this.config.Database));
    // Verify connectivity by acquiring and releasing a client
    const client = await this.pool.connect();
    client.release();
    this.connected = true;
  }

  async Disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
    }
  }

  get IsConnected(): boolean {
    return this.connected;
  }

  // ─── Database-Level Operations ─────────────────────────────────────

  async DatabaseExists(dbName: string): Promise<boolean> {
    const systemPool = await this.connectToSystemDb();
    try {
      const result = await systemPool.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );
      return result.rowCount !== null && result.rowCount > 0;
    } finally {
      await systemPool.end();
    }
  }

  async CreateDatabase(dbName: string): Promise<void> {
    const systemPool = await this.connectToSystemDb();
    try {
      const exists = await systemPool.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );
      if (exists.rowCount === 0 || exists.rowCount === null) {
        // Database names cannot be parameterized in CREATE DATABASE
        await systemPool.query(`CREATE DATABASE "${dbName}"`);
      }
    } finally {
      await systemPool.end();
    }
  }

  async DropDatabase(dbName: string): Promise<void> {
    const systemPool = await this.connectToSystemDb();
    try {
      const exists = await systemPool.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );
      if (exists.rowCount !== null && exists.rowCount > 0) {
        // Terminate all connections to the database
        await systemPool.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()
        `, [dbName]);
        await systemPool.query(`DROP DATABASE "${dbName}"`);
      }
    } finally {
      await systemPool.end();
    }
  }

  // ─── Transaction Management ────────────────────────────────────────

  async BeginTransaction(): Promise<ProviderTransaction> {
    const pool = this.getPool();
    const client = await pool.connect();
    await client.query('BEGIN');
    return new PostgresTransaction(client);
  }

  // ─── Direct Execution ──────────────────────────────────────────────

  async Execute(sqlText: string): Promise<void> {
    const pool = this.getPool();
    await pool.query(sqlText);
  }

  async Query<T = Record<string, unknown>>(sqlText: string): Promise<T[]> {
    const pool = this.getPool();
    const result = await pool.query(sqlText);
    return result.rows as T[];
  }

  // ─── Script Splitting ──────────────────────────────────────────────

  SplitScript(script: string): SQLBatch[] {
    // PostgreSQL does not use GO batch separators.
    // Return the entire script as a single batch.
    const trimmed = script.trim();
    if (trimmed.length === 0) {
      return [];
    }
    return [{
      SQL: trimmed,
      RepeatCount: 1,
      StartLine: 1,
    }];
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
    const fkResult = await pool.query(`
      SELECT
        con.conname AS constraint_name,
        cls.relname AS table_name
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class cls ON con.conrelid = cls.oid
      JOIN pg_catalog.pg_namespace nsp ON cls.relnamespace = nsp.oid
      WHERE nsp.nspname = $1
        AND con.contype = 'f'
    `, [schema]);
    for (const row of fkResult.rows) {
      operations.push({
        SQL: `ALTER TABLE "${schema}"."${row.table_name}" DROP CONSTRAINT "${row.constraint_name}"`,
        Label: `FK constraint "${row.constraint_name}" on "${schema}"."${row.table_name}"`,
      });
    }

    // 2. Drop views
    const viewResult = await pool.query(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = $1
    `, [schema]);
    for (const row of viewResult.rows) {
      operations.push({
        SQL: `DROP VIEW IF EXISTS "${schema}"."${row.table_name}" CASCADE`,
        Label: `View "${schema}"."${row.table_name}"`,
      });
    }

    // 3. Drop functions/procedures
    const fnResult = await pool.query(`
      SELECT
        p.proname AS func_name,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS func_args,
        CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS func_type
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = $1
        AND p.prokind IN ('f', 'p')
    `, [schema]);
    for (const row of fnResult.rows) {
      operations.push({
        SQL: `DROP ${row.func_type} IF EXISTS "${schema}"."${row.func_name}"(${row.func_args}) CASCADE`,
        Label: `${row.func_type} "${schema}"."${row.func_name}"`,
      });
    }

    // 4. Drop user-defined types (enums and composites)
    // Exclude implicit composite types that PG auto-creates for every table/view —
    // those are dropped automatically when the table/view is dropped.
    const typeResult = await pool.query(`
      SELECT t.typname AS type_name
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = $1
        AND t.typtype IN ('e', 'c')
        AND t.typname NOT LIKE '\\_%'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c
          WHERE c.relnamespace = n.oid
            AND c.relname = t.typname
            AND c.relkind IN ('r', 'v', 'm')
        )
    `, [schema]);
    for (const row of typeResult.rows) {
      operations.push({
        SQL: `DROP TYPE IF EXISTS "${schema}"."${row.type_name}" CASCADE`,
        Label: `Type "${schema}"."${row.type_name}"`,
      });
    }

    // 5. Drop tables
    const tableResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
    `, [schema]);
    for (const row of tableResult.rows) {
      operations.push({
        SQL: `DROP TABLE IF EXISTS "${schema}"."${row.table_name}" CASCADE`,
        Label: `Table "${schema}"."${row.table_name}"`,
      });
    }

    // 6. Drop sequences
    const seqResult = await pool.query(`
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_schema = $1
    `, [schema]);
    for (const row of seqResult.rows) {
      operations.push({
        SQL: `DROP SEQUENCE IF EXISTS "${schema}"."${row.sequence_name}" CASCADE`,
        Label: `Sequence "${schema}"."${row.sequence_name}"`,
      });
    }

    return operations;
  }

  async DropSchema(schema: string): Promise<void> {
    if (schema.toLowerCase() === 'public') {
      return; // Never drop the built-in public schema
    }

    const pool = this.getPool();
    const result = await pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
      [schema]
    );
    if (result.rowCount !== null && result.rowCount > 0) {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────────

  /**
   * Returns the active connection pool.
   * @throws Error if not connected.
   * @internal — exposed for PostgresHistoryProvider
   */
  getPool(): Pool {
    if (!this.pool || !this.connected) {
      throw new Error(
        'Connection pool is not connected. Call Connect() before accessing the pool.'
      );
    }
    return this.pool;
  }

  /**
   * Builds a pg.PoolConfig from the Skyway DatabaseConfig.
   */
  private buildPoolConfig(dbName: string): PoolConfig {
    const poolConfig: PoolConfig = {
      host: this.config.Server,
      port: this.config.Port ?? 5432,
      database: dbName,
      user: this.config.User,
      password: this.config.Password,
      max: 1,
      connectionTimeoutMillis: this.config.Options?.ConnectionTimeout ?? 30_000,
      statement_timeout: this.config.Options?.RequestTimeout ?? 300_000,
    };

    if (this.config.Options?.SSL) {
      poolConfig.ssl = this.config.Options.SSL === true
        ? { rejectUnauthorized: false }
        : this.config.Options.SSL as PoolConfig['ssl'];
    }

    return poolConfig;
  }

  /**
   * Connects to the `postgres` system database for database-level operations.
   */
  private async connectToSystemDb(): Promise<Pool> {
    const pool = new Pool(this.buildPoolConfig('postgres'));
    // Verify connectivity
    const client = await pool.connect();
    client.release();
    return pool;
  }
}

// ─── PostgresTransaction ─────────────────────────────────────────────

/**
 * Wraps a pg PoolClient with an active transaction as a ProviderTransaction.
 */
class PostgresTransaction implements ProviderTransaction {
  /** @internal — exposed for PostgresHistoryProvider */
  readonly Client: PoolClient;

  constructor(client: PoolClient) {
    this.Client = client;
  }

  async Execute(sqlText: string): Promise<void> {
    await this.Client.query(sqlText);
  }

  async Query<T = Record<string, unknown>>(sqlText: string): Promise<T[]> {
    const result = await this.Client.query(sqlText);
    return result.rows as T[];
  }

  async Commit(): Promise<void> {
    try {
      await this.Client.query('COMMIT');
    } finally {
      this.Client.release();
    }
  }

  async Rollback(): Promise<void> {
    try {
      await this.Client.query('ROLLBACK');
    } finally {
      this.Client.release();
    }
  }
}

// ─── PostgresHistoryProvider ─────────────────────────────────────────

/**
 * PostgreSQL implementation of `HistoryTableProvider`.
 *
 * Uses PostgreSQL-native DDL and parameterized queries:
 * - `VARCHAR`, `TIMESTAMP`, `BOOLEAN` types
 * - `NOW()` for timestamps
 * - `COALESCE()` for null coalescing
 * - `"double-quote"` identifier quoting
 * - `$1, $2` positional parameter syntax
 */
class PostgresHistoryProvider implements HistoryTableProvider {
  private readonly provider: PostgresProvider;

  constructor(provider: PostgresProvider) {
    this.provider = provider;
  }

  private qualifiedName(schema: string, tableName: string): string {
    return `"${schema}"."${tableName}"`;
  }

  /**
   * Returns a query executor — either the transaction client or the pool.
   */
  private getExecutor(txn?: ProviderTransaction): Pool | PoolClient {
    if (txn) {
      return (txn as PostgresTransaction).Client;
    }
    return this.provider.getPool();
  }

  async EnsureExists(schema: string, tableName: string, txn?: ProviderTransaction): Promise<void> {
    const executor = this.getExecutor(txn);
    const qualifiedName = this.qualifiedName(schema, tableName);

    // Create schema if it doesn't exist
    await executor.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    // Create history table if it doesn't exist
    await executor.query(`
      CREATE TABLE IF NOT EXISTS ${qualifiedName} (
        installed_rank  INTEGER        NOT NULL,
        version         VARCHAR(50)    NULL,
        description     VARCHAR(200)   NOT NULL,
        type            VARCHAR(20)    NOT NULL,
        script          VARCHAR(1000)  NOT NULL,
        checksum        INTEGER        NULL,
        installed_by    VARCHAR(100)   NOT NULL,
        installed_on    TIMESTAMP      NOT NULL DEFAULT NOW(),
        execution_time  INTEGER        NOT NULL,
        success         BOOLEAN        NOT NULL,
        CONSTRAINT "${tableName}_pk" PRIMARY KEY (installed_rank)
      )
    `);

    // Create success index if it doesn't exist
    await executor.query(`
      CREATE INDEX IF NOT EXISTS "${tableName}_s_idx"
        ON ${qualifiedName} (success)
    `);
  }

  async Exists(schema: string, tableName: string): Promise<boolean> {
    const pool = this.provider.getPool();
    const result = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [schema, tableName]
    );
    return parseInt(result.rows[0].cnt, 10) > 0;
  }

  async GetAllRecords(schema: string, tableName: string, txn?: ProviderTransaction): Promise<HistoryRecord[]> {
    const executor = this.getExecutor(txn);
    const qualifiedName = this.qualifiedName(schema, tableName);
    const result = await executor.query(
      `SELECT * FROM ${qualifiedName} ORDER BY installed_rank`
    );
    return result.rows.map(mapRowToRecord);
  }

  async GetNextRank(schema: string, tableName: string, txn?: ProviderTransaction): Promise<number> {
    const executor = this.getExecutor(txn);
    const qualifiedName = this.qualifiedName(schema, tableName);
    const result = await executor.query(
      `SELECT COALESCE(MAX(installed_rank), -1) + 1 AS next_rank FROM ${qualifiedName}`
    );
    return parseInt(result.rows[0].next_rank, 10);
  }

  async InsertRecord(
    schema: string,
    tableName: string,
    record: HistoryInsertParams,
    txn?: ProviderTransaction
  ): Promise<void> {
    const executor = this.getExecutor(txn);
    const qualifiedName = this.qualifiedName(schema, tableName);

    await executor.query(
      `INSERT INTO ${qualifiedName}
        (installed_rank, version, description, type, script,
         checksum, installed_by, execution_time, success)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.InstalledRank,
        record.Version,
        record.Description,
        record.Type,
        record.Script,
        record.Checksum,
        record.InstalledBy,
        record.ExecutionTime,
        record.Success,
      ]
    );
  }

  async DeleteRecord(
    schema: string,
    tableName: string,
    installedRank: number,
    txn?: ProviderTransaction
  ): Promise<void> {
    const executor = this.getExecutor(txn);
    const qualifiedName = this.qualifiedName(schema, tableName);
    await executor.query(
      `DELETE FROM ${qualifiedName} WHERE installed_rank = $1`,
      [installedRank]
    );
  }

  async UpdateChecksum(
    schema: string,
    tableName: string,
    installedRank: number,
    newChecksum: number,
    txn?: ProviderTransaction
  ): Promise<void> {
    const executor = this.getExecutor(txn);
    const qualifiedName = this.qualifiedName(schema, tableName);
    await executor.query(
      `UPDATE ${qualifiedName} SET checksum = $1 WHERE installed_rank = $2`,
      [newChecksum, installedRank]
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
