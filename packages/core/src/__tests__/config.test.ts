import { describe, it, expect } from 'vitest';
import { resolveConfig, SkywayConfig } from '../core/config';

const minimalConfig: SkywayConfig = {
  Database: {
    Server: 'localhost',
    Database: 'testdb',
    User: 'sa',
    Password: 'secret',
  },
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

  it('applies default empty HistoryExtraColumns', () => {
    const resolved = resolveConfig(minimalConfig);
    expect(resolved.Migrations.HistoryExtraColumns).toEqual([]);
  });

  it('preserves HistoryExtraColumns with values and defaults', () => {
    const config: SkywayConfig = {
      ...minimalConfig,
      Migrations: {
        ...minimalConfig.Migrations,
        HistoryTable: 'IntegrationSchemaHistory',
        HistoryExtraColumns: [
          {
            Name: 'CompanyIntegrationID',
            SqlType: 'UNIQUEIDENTIFIER',
            IsNullable: false,
            Value: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
          },
          {
            Name: 'TriggeredBy',
            SqlType: 'NVARCHAR(200)',
            DefaultValue: "N'system'",
          },
        ],
      },
    };
    const resolved = resolveConfig(config);
    expect(resolved.Migrations.HistoryTable).toBe('IntegrationSchemaHistory');
    expect(resolved.Migrations.HistoryExtraColumns).toHaveLength(2);
    expect(resolved.Migrations.HistoryExtraColumns[0]).toMatchObject({
      Name: 'CompanyIntegrationID',
      SqlType: 'UNIQUEIDENTIFIER',
      IsNullable: false,
      Value: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
    });
    expect(resolved.Migrations.HistoryExtraColumns[1]).toMatchObject({
      Name: 'TriggeredBy',
      DefaultValue: "N'system'",
    });
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
});
