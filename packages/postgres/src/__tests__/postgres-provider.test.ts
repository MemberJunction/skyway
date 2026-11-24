/**
 * Smoke tests for PostgresProvider — dialect contract, validator wiring at
 * public entry points, and dialect-specific behaviors that don't require a
 * live PostgreSQL connection.
 *
 * Parallel in structure to sqlserver-provider.test.ts so the two suites read
 * as a spec of dialect parity. Where behaviors differ (GO-split vs single-batch,
 * dbo vs public protected schemas) the tests assert the PG-specific behavior.
 *
 * Integration tests against a real PostgreSQL live separately.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresProvider } from '../postgres-provider';
import type { DatabaseConfig } from '@memberjunction/skyway-core';

const baseConfig: DatabaseConfig = {
  Dialect: 'postgresql',
  Server: 'localhost',
  Port: 5432,
  Database: 'test_db',
  User: 'postgres',
  Password: 'irrelevant',
};

describe('PostgresProvider', () => {
  let provider: PostgresProvider;

  beforeEach(() => {
    provider = new PostgresProvider(baseConfig);
  });

  describe('dialect info', () => {
    it('reports postgresql as its dialect', () => {
      expect(provider.Dialect).toBe('postgresql');
    });

    it('defaults schema to public', () => {
      expect(provider.DefaultSchema).toBe('public');
    });

    it('defaults port to 5432', () => {
      expect(provider.DefaultPort).toBe(5432);
    });

    it('exposes Config so Skyway can fall back to it when SkywayConfig.Database is omitted', () => {
      expect(provider.Config).toBe(baseConfig);
      expect(provider.Config.Database).toBe('test_db');
      expect(provider.Config.User).toBe('postgres');
    });
  });

  describe('connection state', () => {
    it('reports disconnected before Connect() is called', () => {
      expect(provider.IsConnected).toBe(false);
    });
  });

  describe('SplitScript', () => {
    // PG doesn't use `GO` batch separators — the entire script is a single batch.
    it('returns the whole script as a single batch (PG has no GO separator)', () => {
      const script = 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);';
      const batches = provider.SplitScript(script);
      expect(batches.length).toBe(1);
      expect(batches[0].SQL).toContain('CREATE TABLE a');
      expect(batches[0].SQL).toContain('CREATE TABLE b');
    });

    it('returns empty array for empty/whitespace script', () => {
      expect(provider.SplitScript('')).toEqual([]);
      expect(provider.SplitScript('   \n  \t  ')).toEqual([]);
    });

    it('does NOT split on GO (unlike SQL Server)', () => {
      // On SQL Server `GO` splits batches; on PG it would be a syntax error,
      // but the script is handed to the server as one batch regardless.
      const script = 'SELECT 1;\nGO\nSELECT 2;';
      const batches = provider.SplitScript(script);
      expect(batches.length).toBe(1);
      expect(batches[0].SQL).toContain('GO');
    });
  });

  // Validator wiring — these operations must reject invalid identifiers
  // BEFORE they attempt to connect or execute SQL. The throw path doesn't
  // need any mocking because validation runs first.
  describe('identifier validation (injection guards)', () => {
    describe('CreateDatabase', () => {
      it('rejects empty database name', async () => {
        await expect(provider.CreateDatabase('')).rejects.toThrow(/database identifier/);
      });

      it('rejects database name with double-quote injection', async () => {
        await expect(provider.CreateDatabase('db";DROP DATABASE evil;--'))
          .rejects.toThrow(/database identifier/);
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
      // The public schema is always protected — skipped before validation, so
      // no error even if validation would have rejected it. This is by design.
      it('silently skips the public schema without validation or DB call', async () => {
        await expect(provider.DropSchema('public')).resolves.not.toThrow();
      });

      it('is case-insensitive about the public skip', async () => {
        await expect(provider.DropSchema('PUBLIC')).resolves.not.toThrow();
        await expect(provider.DropSchema('Public')).resolves.not.toThrow();
      });

      it('rejects invalid schema names', async () => {
        await expect(provider.DropSchema('sch"ema')).rejects.toThrow(/schema identifier/);
      });
    });

    describe('GetCleanOperations', () => {
      it('rejects invalid schema names without connecting', async () => {
        // If validation didn't run first, we'd see a different error
        // (pool not connected). Asserting the specific validation message
        // confirms the validator is the first guard.
        await expect(provider.GetCleanOperations('bad;schema'))
          .rejects.toThrow(/schema identifier/);
      });
    });

    describe('History.EnsureExists', () => {
      it('rejects invalid schema name', async () => {
        await expect(provider.History.EnsureExists('bad"schema', 'flyway_schema_history'))
          .rejects.toThrow(/schema identifier/);
      });

      it('rejects invalid table name', async () => {
        await expect(provider.History.EnsureExists('public', 'table--injection'))
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

// LockTimeout: a fake pool hands out a fake client that records every query.
describe('PostgresProvider.BeginTransaction LockTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function providerWith(lockTimeout: unknown): PostgresProvider {
    // Cast: the invalid-value tests need values the type forbids, as a JSON config could carry.
    return new PostgresProvider({ ...baseConfig, Options: { LockTimeout: lockTimeout as number } });
  }

  function stubPool(provider: PostgresProvider) {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const getPool = vi.spyOn(provider, 'getPool').mockReturnValue(pool as unknown as Pool);
    return { getPool, client };
  }

  it('runs SET LOCAL lock_timeout right after BEGIN when LockTimeout is set', async () => {
    const provider = providerWith(2000);
    const { client } = stubPool(provider);
    await provider.BeginTransaction();
    expect(client.query.mock.calls).toEqual([['BEGIN'], ["SET LOCAL lock_timeout = '2000ms'"]]);
  });

  it('runs nothing extra when LockTimeout is unset', async () => {
    const provider = new PostgresProvider(baseConfig);
    const { client } = stubPool(provider);
    await provider.BeginTransaction();
    expect(client.query.mock.calls).toEqual([['BEGIN']]);
  });

  it.each([0, -1, 1.5, "2000'; DROP TABLE x; --"])('rejects invalid LockTimeout %s when the provider is created', (value) => {
    expect(() => providerWith(value)).toThrow(/LockTimeout must be an integer from 1/);
  });

  it('re-checks LockTimeout in BeginTransaction if the config changed after construction', async () => {
    const provider = providerWith(2000);
    const { getPool, client } = stubPool(provider);
    provider.Config.Options = { LockTimeout: -1 };
    await expect(provider.BeginTransaction()).rejects.toThrow(/LockTimeout must be an integer/);
    expect(getPool).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rolls back, releases the client and rethrows when the SET fails', async () => {
    const provider = providerWith(2000);
    const { client } = stubPool(provider);
    client.query.mockImplementation(async (text: string) => {
      if (text.startsWith('SET LOCAL')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(provider.BeginTransaction()).rejects.toThrow('boom');
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('throws an AggregateError and has the pool destroy the client when the SET and ROLLBACK both fail', async () => {
    const provider = providerWith(2000);
    const { client } = stubPool(provider);
    const setErr = new Error('set failed');
    const rollbackErr = new Error('rollback failed');
    client.query.mockImplementation(async (text: string) => {
      if (text.startsWith('SET LOCAL')) throw setErr;
      if (text === 'ROLLBACK') throw rollbackErr;
      return { rows: [] };
    });
    const caught = await provider.BeginTransaction().catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([setErr, rollbackErr]);
    // pg-pool removes (destroys) a client released with a truthy argument.
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
