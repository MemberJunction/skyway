/**
 * A failed batch can leave its transaction already aborted by the server (a request timeout,
 * a severe error), and rolling back an aborted transaction throws. Migrate() must still report
 * the batch's own error — not the rollback's "Transaction has been aborted".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Skyway } from '../core/skyway';
import { TransactionMode } from '../core/config';
import { DatabaseProvider, ProviderTransaction, HistoryTableProvider, HistoryInsertParams, CleanOperation } from '../db/provider';
import { DatabaseConfig } from '../db/types';
import { HistoryRecord } from '../history/types';
import { SQLBatch } from '../executor/sql-splitter';

class MemoryHistory implements HistoryTableProvider {
  records: HistoryRecord[] = [];
  exists = false;
  async EnsureExists(): Promise<void> { this.exists = true; }
  async Exists(): Promise<boolean> { return this.exists; }
  async GetAllRecords(): Promise<HistoryRecord[]> { return [...this.records]; }
  async GetNextRank(): Promise<number> {
    return this.records.reduce((max, r) => Math.max(max, r.InstalledRank), -1) + 1;
  }
  async InsertRecord(_s: string, _t: string, p: HistoryInsertParams): Promise<void> {
    this.records.push({ ...p, InstalledOn: new Date() } as HistoryRecord);
  }
  async DeleteRecord(): Promise<void> {}
  async UpdateChecksum(): Promise<void> {}
}

/** A provider whose failing batch aborts its transaction, so the follow-up Rollback() throws. */
class AbortingProvider implements DatabaseProvider {
  readonly Dialect = 'sqlserver' as const;
  readonly DefaultSchema = 'dbo';
  readonly DefaultPort = 1433;
  readonly History = new MemoryHistory();
  IsConnected = false;
  RollbackAttempts = 0;

  constructor(readonly Config: DatabaseConfig, private readonly failingSQL: string, private readonly batchError: string) {}

  async Connect(): Promise<void> { this.IsConnected = true; }
  async Disconnect(): Promise<void> { this.IsConnected = false; }
  async DatabaseExists(): Promise<boolean> { return true; }
  async CreateDatabase(): Promise<void> {}
  async DropDatabase(): Promise<void> {}
  async BeginTransaction(): Promise<ProviderTransaction> {
    let aborted = false;
    return {
      Execute: async (sql: string) => {
        if (sql === this.failingSQL) {
          aborted = true;
          throw new Error(this.batchError);
        }
      },
      Query: async <T>() => [] as T[],
      Commit: async () => {},
      Rollback: async () => {
        this.RollbackAttempts++;
        if (aborted) throw new Error('Transaction has been aborted.');
      },
    };
  }
  async Execute(): Promise<void> {}
  async Query<T>(): Promise<T[]> { return []; }
  SplitScript(script: string): SQLBatch[] {
    return [{ SQL: script.trim(), RepeatCount: 1, StartLine: 1, EndLine: 1 }];
  }
  async GetCleanOperations(): Promise<CleanOperation[]> { return []; }
  async DropSchema(): Promise<void> {}
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-rollback-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const dbConfig: DatabaseConfig = { Server: 'localhost', Database: 'test', User: 'u', Password: 'p' };

describe.each<TransactionMode>(['per-migration', 'per-run'])('Migrate() when rollback throws after a failed batch (%s)', (mode) => {
  it("reports the batch's error, not the rollback's", async () => {
    fs.writeFileSync(path.join(dir, 'V1__ok.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, 'V2__stalls.sql'), 'UPDATE t SET c = 1;');
    const provider = new AbortingProvider(dbConfig, 'UPDATE t SET c = 1;', 'Timeout: Request failed to complete in 300000ms');

    const result = await new Skyway({
      Provider: provider,
      Database: dbConfig,
      Migrations: { Locations: [dir], DefaultSchema: 'dbo' },
      TransactionMode: mode,
    }).Migrate();

    expect(result.Success).toBe(false);
    expect(result.ErrorMessage).toContain('Timeout: Request failed to complete in 300000ms');
    expect(result.ErrorMessage).not.toContain('Transaction has been aborted');
    expect(provider.RollbackAttempts).toBeGreaterThan(0);
  });
});
