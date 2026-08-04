import { describe, it, expect } from 'vitest';
import * as sql from 'mssql';
import { HistoryTable } from '../history/history-table';
import { HistoryExtraColumn } from '../history/types';

/**
 * A disconnected pool. The stampable-contract check runs before any DDL, so a
 * config that passes validation fails later with a driver error instead — which
 * is how these tests distinguish "rejected by the contract" from "got past it".
 */
function tableWith(extras: HistoryExtraColumn[]): HistoryTable {
  return new HistoryTable({} as unknown as sql.ConnectionPool, 'dbo', 'flyway_schema_history', extras);
}

const CONTRACT_ERROR = /HistoryExtraColumns:/;

/** Asserts EnsureExists got past validation (failing only on the dead pool). */
async function expectPassesValidation(table: HistoryTable): Promise<void> {
  await expect(table.EnsureExists()).rejects.toThrow();
  await expect(table.EnsureExists()).rejects.not.toThrow(CONTRACT_ERROR);
}

describe('HistoryTable extra columns', () => {
  describe('stampable contract', () => {
    it('rejects a NOT NULL extra with no Value and no DefaultValue', async () => {
      const table = tableWith([{ Name: 'CompanyIntegrationID', SqlType: 'UNIQUEIDENTIFIER', IsNullable: false }]);

      await expect(table.EnsureExists()).rejects.toThrow(/CompanyIntegrationID.*NOT NULL.*no Value/s);
    });

    it('names the offending column so the operator can fix it', async () => {
      const table = tableWith([
        { Name: 'Ok', SqlType: 'NVARCHAR(50)', IsNullable: true },
        { Name: 'Broken', SqlType: 'INT', IsNullable: false },
      ]);

      await expect(table.EnsureExists()).rejects.toThrow(/'Broken'/);
    });

    it('accepts a NOT NULL extra that carries a Value', async () => {
      const table = tableWith([
        { Name: 'CompanyIntegrationID', SqlType: 'UNIQUEIDENTIFIER', IsNullable: false, Value: 'abc' },
      ]);

      await expectPassesValidation(table);
    });

    it('accepts a NOT NULL extra that carries a DefaultValue', async () => {
      const table = tableWith([
        { Name: 'Tag', SqlType: 'NVARCHAR(50)', IsNullable: false, DefaultValue: "'unknown'" },
      ]);

      await expectPassesValidation(table);
    });

    it('accepts a nullable extra with no Value', async () => {
      const table = tableWith([{ Name: 'AffectedTables', SqlType: 'NVARCHAR(MAX)', IsNullable: true }]);

      await expectPassesValidation(table);
    });

    it('treats an omitted IsNullable as nullable', async () => {
      const table = tableWith([{ Name: 'AffectedTables', SqlType: 'NVARCHAR(MAX)' }]);

      await expectPassesValidation(table);
    });
  });
});
