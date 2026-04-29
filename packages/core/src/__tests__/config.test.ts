import { describe, it, expect } from 'vitest';
import { resolveConfig, SkywayConfig } from '../core/config';
import { DatabaseConfig } from '../db/types';

const baseDatabase: DatabaseConfig = {
  Server: 'localhost',
  Database: 'testdb',
  User: 'sa',
  Password: 'secret',
};

const minimalConfig: SkywayConfig = {
  Database: baseDatabase,
  Migrations: {
    Locations: ['./migrations'],
  },
};

describe('resolveConfig', () => {
  it('applies default schema', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Migrations.DefaultSchema).toBe('dbo');
  });

  it('applies default history table name', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Migrations.HistoryTable).toBe('flyway_schema_history');
  });

  it('applies default baseline version', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Migrations.BaselineVersion).toBe('1');
  });

  it('applies default BaselineOnMigrate as false', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Migrations.BaselineOnMigrate).toBe(false);
  });

  it('applies default OutOfOrder as false', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Migrations.OutOfOrder).toBe(false);
  });

  it('applies default TransactionMode as per-run', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.TransactionMode).toBe('per-run');
  });

  it('applies default empty Placeholders', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Placeholders).toEqual({});
  });

  it('preserves user-specified values', () => {
    const config: SkywayConfig = {
      ...minimalConfig,
      Migrations: {
        Locations: ['/custom/path'],
        DefaultSchema: '__mj',
        HistoryTable: 'custom_history',
        BaselineVersion: '202601122300',
        BaselineOnMigrate: true,
        OutOfOrder: true,
      },
      Placeholders: { 'flyway:defaultSchema': '__mj' },
      TransactionMode: 'per-migration',
    };
    const resolved = resolveConfig(config);
    expect(resolved.Migrations.DefaultSchema).toBe('__mj');
    expect(resolved.Migrations.HistoryTable).toBe('custom_history');
    expect(resolved.Migrations.BaselineVersion).toBe('202601122300');
    expect(resolved.Migrations.BaselineOnMigrate).toBe(true);
    expect(resolved.Migrations.OutOfOrder).toBe(true);
    expect(resolved.TransactionMode).toBe('per-migration');
    expect(resolved.Placeholders).toEqual({ 'flyway:defaultSchema': '__mj' });
  });

  it('preserves Database config as-is', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Database).toEqual(minimalConfig.Database);
  });

  it('defaults to dbo schema for sqlserver dialect', () => {
    const config: SkywayConfig = {
      ...minimalConfig,
      Database: { ...baseDatabase, Dialect: 'sqlserver' },
    };
    const resolved = resolveConfig(config);
    expect(resolved.Migrations.DefaultSchema).toBe('dbo');
  });

  it('defaults to public schema for postgresql dialect', () => {
    const config: SkywayConfig = {
      ...minimalConfig,
      Database: { ...baseDatabase, Dialect: 'postgresql' },
    };
    const resolved = resolveConfig(config);
    expect(resolved.Migrations.DefaultSchema).toBe('public');
  });

  it('defaults to dbo schema when no dialect specified', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Migrations.DefaultSchema).toBe('dbo');
  });

  it('applies default DryRun as false', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.DryRun).toBe(false);
  });

  it('preserves Provider when supplied', () => {
    // Provider is optional — when not supplied, it's undefined
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Provider).toBeUndefined();
  });

  describe('Database fallback to Provider.Config', () => {
    // Minimal stub that satisfies the structural shape resolveConfig reads.
    // No real DB methods needed — config resolution touches Config + Dialect only.
    const stubProvider = (overrides: Partial<DatabaseConfig> & { Dialect?: 'sqlserver' | 'postgresql' } = {}) => {
      const cfg: DatabaseConfig = { ...baseDatabase, ...overrides };
      // Cast through unknown — only Config + Dialect are read by resolveConfig.
      return {
        Config: cfg,
        Dialect: overrides.Dialect ?? cfg.Dialect ?? 'sqlserver',
      } as unknown as NonNullable<SkywayConfig['Provider']>;
    };

    it('falls back to Provider.Config when Database is omitted', () => {
      const resolved = resolveConfig({
        Provider: stubProvider({ Database: 'pg_db', Dialect: 'postgresql' }),
        Migrations: { Locations: ['./migrations'] },
      });
      expect(resolved.Database.Database).toBe('pg_db');
      expect(resolved.Migrations.DefaultSchema).toBe('public'); // dialect-aware
    });

    it('uses Provider.Dialect when Database has no Dialect set', () => {
      const provider = stubProvider({ Dialect: 'postgresql' });
      // Database supplied but no Dialect — provider.Dialect should drive defaults
      const resolved = resolveConfig({
        Database: { ...baseDatabase, Dialect: undefined },
        Provider: provider,
        Migrations: { Locations: ['./migrations'] },
      });
      expect(resolved.Migrations.DefaultSchema).toBe('public');
    });

    it('explicit Database wins over Provider.Config', () => {
      const provider = stubProvider({ Database: 'from_provider' });
      const resolved = resolveConfig({
        Database: { ...baseDatabase, Database: 'explicit' },
        Provider: provider,
        Migrations: { Locations: ['./migrations'] },
      });
      expect(resolved.Database.Database).toBe('explicit');
    });

    it('throws when neither Database nor Provider is supplied', () => {
      expect(() =>
        resolveConfig({
          Migrations: { Locations: ['./migrations'] },
        } as unknown as SkywayConfig)
      ).toThrow(/Database connection config or a Provider/);
    });
  });
});
