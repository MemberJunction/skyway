/**
 * Smoke tests for SqlServerProvider — covers the dialect-identifying API,
 * validator wiring at public entry points, and dialect-specific behaviors
 * that don't require a live SQL Server connection.
 *
 * These intentionally avoid mocking the `mssql` driver end-to-end; the goal
 * is to catch regressions in contract + input validation, not to re-test the
 * driver. Integration testing against a real SQL Server lives separately.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SqlServerProvider } from '../sqlserver-provider';
import type { DatabaseConfig } from '@memberjunction/skyway-core';

// Minimal valid config — only Server/Database/User/Password actually matter for
// anything exercised here. Connect() isn't called in these tests.
const baseConfig: DatabaseConfig = {
  Server: 'localhost',
  Port: 1433,
  Database: 'TestDb',
  User: 'sa',
  Password: 'irrelevant',
};

describe('SqlServerProvider', () => {
  let provider: SqlServerProvider;

  beforeEach(() => {
    provider = new SqlServerProvider(baseConfig);
  });

  describe('dialect info', () => {
    it('reports sqlserver as its dialect', () => {
      expect(provider.Dialect).toBe('sqlserver');
    });

    it('defaults schema to dbo', () => {
      expect(provider.DefaultSchema).toBe('dbo');
    });

    it('defaults port to 1433', () => {
      expect(provider.DefaultPort).toBe(1433);
    });

    it('exposes Config so Skyway can fall back to it when SkywayConfig.Database is omitted', () => {
      expect(provider.Config).toBe(baseConfig);
      expect(provider.Config.Database).toBe('TestDb');
      expect(provider.Config.User).toBe('sa');
    });
  });

  describe('connection state', () => {
    it('reports disconnected before Connect() is called', () => {
      expect(provider.IsConnected).toBe(false);
    });
  });

  describe('SplitScript', () => {
    it('splits on GO batch separator (SQL Server-specific)', () => {
      const script = 'CREATE TABLE a (id int);\nGO\nCREATE TABLE b (id int);';
      const batches = provider.SplitScript(script);
      expect(batches.length).toBeGreaterThanOrEqual(2);
    });

    it('returns single batch when no GO present', () => {
      const script = 'CREATE TABLE solo (id int);';
      const batches = provider.SplitScript(script);
      expect(batches.length).toBe(1);
    });
  });

  // Validator wiring — these operations must reject invalid identifiers BEFORE
  // they attempt to connect or execute SQL. The throw path doesn't need any
  // mocking because validation runs first.
  describe('identifier validation (injection guards)', () => {
    describe('DatabaseExists', () => {
      it('rejects empty database name', async () => {
        await expect(provider.DatabaseExists('')).rejects.toThrow(/database identifier/);
      });

      it('rejects database name with injection characters', async () => {
        await expect(provider.DatabaseExists("db'; DROP DATABASE evil;--"))
          .rejects.toThrow(/database identifier/);
      });

      it('rejects database name with brackets', async () => {
        await expect(provider.DatabaseExists('db]injection')).rejects.toThrow(/database identifier/);
      });
    });

    describe('CreateDatabase', () => {
      it('rejects empty database name', async () => {
        await expect(provider.CreateDatabase('')).rejects.toThrow();
      });

      it('rejects database name with a space', async () => {
        await expect(provider.CreateDatabase('my db')).rejects.toThrow(/database identifier/);
      });
    });

    describe('DropDatabase', () => {
      it('rejects database name with semicolons', async () => {
        await expect(provider.DropDatabase('db;DROP DATABASE other')).rejects.toThrow();
      });
    });

    describe('DropSchema', () => {
      // This is a special case — `dbo` is skipped *before* validation, which
      // is intentional (dbo never gets dropped). Every other value goes
      // through validation.
      it('silently skips the dbo schema without validation or DB call', async () => {
        await expect(provider.DropSchema('dbo')).resolves.not.toThrow();
      });

      it('is case-insensitive about the dbo skip', async () => {
        await expect(provider.DropSchema('DBO')).resolves.not.toThrow();
        await expect(provider.DropSchema('Dbo')).resolves.not.toThrow();
      });

      it('rejects invalid schema names', async () => {
        await expect(provider.DropSchema("sch'ema")).rejects.toThrow(/schema identifier/);
      });
    });

    describe('GetCleanOperations', () => {
      it('rejects invalid schema names without connecting', async () => {
        // provider.Connect() was never called, so if validation is bypassed
        // we'd get a "pool not connected" error instead of a validation error.
        // Asserting the validation-error message confirms the validator runs first.
        await expect(provider.GetCleanOperations('bad;schema')).rejects.toThrow(/schema identifier/);
      });
    });

    describe('History.EnsureExists', () => {
      it('rejects invalid schema name', async () => {
        await expect(provider.History.EnsureExists('bad"schema', 'flyway_schema_history'))
          .rejects.toThrow(/schema identifier/);
      });

      it('rejects invalid table name', async () => {
        await expect(provider.History.EnsureExists('dbo', 'table--injection'))
          .rejects.toThrow(/history table identifier/);
      });
    });

    describe('History.Exists', () => {
      it('rejects invalid schema name', async () => {
        await expect(provider.History.Exists('sch ema', 'flyway_schema_history'))
          .rejects.toThrow(/schema identifier/);
      });
    });
  });
});
