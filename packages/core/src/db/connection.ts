/**
 * @module db/connection
 * SQL Server connection pool management for Skyway.
 *
 * Provides a single-connection pool optimized for sequential migration
 * execution. All migrations run through one connection to ensure
 * transaction integrity.
 */

import * as sql from 'mssql';
import { DatabaseConfig } from './types';

/**
 * Manages a SQL Server connection pool for migration execution.
 * Uses a single-connection pool to guarantee that all batches within
 * a transaction share the same underlying connection.
 */
export class ConnectionManager {
  private pool: sql.ConnectionPool | null = null;
  private readonly config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  /**
   * Opens the connection pool. Must be called before executing any SQL.
   * Safe to call multiple times — subsequent calls are no-ops if already connected.
   */
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
        encrypt: this.config.Options?.Encrypt ?? false,
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

  /**
   * Returns the active connection pool.
   * @throws Error if the pool has not been connected yet.
   */
  GetPool(): sql.ConnectionPool {
    if (!this.pool?.connected) {
      throw new Error(
        'Connection pool is not connected. Call Connect() before accessing the pool.'
      );
    }
    return this.pool;
  }

  /**
   * Closes the connection pool and releases all resources.
   * Safe to call multiple times.
   */
  async Disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  /**
   * Returns true if the connection pool is currently connected.
   */
  get IsConnected(): boolean {
    return this.pool?.connected ?? false;
  }

  /**
   * Connects to the SQL Server instance without specifying a database.
   * Used for database-level operations like CREATE DATABASE / DROP DATABASE.
   */
  async ConnectToMaster(): Promise<sql.ConnectionPool> {
    const mssqlConfig: sql.config = {
      server: this.config.Server,
      port: this.config.Port ?? 1433,
      user: this.config.User,
      password: this.config.Password,
      database: 'master',
      options: {
        encrypt: this.config.Options?.Encrypt ?? false,
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
