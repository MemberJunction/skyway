/**
 * Unit tests for `Skyway.Repair()` duplicate-version handling.
 *
 * Repair builds a disk-by-version map (last-write-wins on readdir order) to
 * realign checksums. With two files sharing a version that mapping is
 * ambiguous — the exact problem duplicate detection exists to prevent — so
 * Repair must refuse before mutating the history table (removing failed
 * entries / realigning checksums).
 *
 * Uses an in-memory fake provider; Repair touches no transactions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Skyway } from '../core/skyway';
import { HistoryRecord } from '../history/types';
import {
  DatabaseProvider,
  ProviderTransaction,
  HistoryTableProvider,
  HistoryInsertParams,
  CleanOperation,
} from '../db/provider';
import { DatabaseConfig } from '../db/types';
import { SQLBatch } from '../executor/sql-splitter';

// ─── Fake provider (drives Repair) ───────────────────────────────────

class FakeHistoryProvider implements HistoryTableProvider {
  records: HistoryRecord[] = [];
  exists = true;

  async EnsureExists(): Promise<void> {
    this.exists = true;
  }
  async Exists(): Promise<boolean> {
    return this.exists;
  }
  async GetAllRecords(): Promise<HistoryRecord[]> {
    return [...this.records];
  }
  async GetNextRank(): Promise<number> {
    let max = -1;
    for (const r of this.records) if (r.InstalledRank > max) max = r.InstalledRank;
    return max + 1;
  }
  async InsertRecord(_s: string, _t: string, p: HistoryInsertParams): Promise<void> {
    this.records.push({ ...p, InstalledOn: new Date() } as HistoryRecord);
  }
  async DeleteRecord(_s: string, _t: string, rank: number): Promise<void> {
    this.records = this.records.filter((r) => r.InstalledRank !== rank);
  }
  async UpdateChecksum(_s: string, _t: string, rank: number, c: number): Promise<void> {
    const r = this.records.find((x) => x.InstalledRank === rank);
    if (r) r.Checksum = c;
  }
}

class FakeProvider implements DatabaseProvider {
  readonly Dialect = 'sqlserver' as const;
  readonly DefaultSchema = 'dbo';
  readonly DefaultPort = 1433;
  readonly Config: DatabaseConfig;
  readonly History = new FakeHistoryProvider();

  IsConnected = false;

  constructor(config: DatabaseConfig) {
    this.Config = config;
  }

  async Connect(): Promise<void> {
    this.IsConnected = true;
  }
  async Disconnect(): Promise<void> {
    this.IsConnected = false;
  }
  async DatabaseExists(): Promise<boolean> {
    return true;
  }
  async CreateDatabase(): Promise<void> {}
  async DropDatabase(): Promise<void> {}
  async BeginTransaction(): Promise<ProviderTransaction> {
    throw new Error('not used in Repair tests');
  }
  async Execute(): Promise<void> {}
  async Query<T>(): Promise<T[]> {
    return [];
  }
  SplitScript(script: string): SQLBatch[] {
    return [{ SQL: script, RepeatCount: 1, StartLine: 1, EndLine: 1 }];
  }
  async GetCleanOperations(): Promise<CleanOperation[]> {
    return [];
  }
  async DropSchema(): Promise<void> {}
}

// ─── Helpers ─────────────────────────────────────────────────────────

let migrationsDir: string;

beforeEach(() => {
  migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-repair-'));
});

afterEach(() => {
  if (fs.existsSync(migrationsDir)) fs.rmSync(migrationsDir, { recursive: true, force: true });
});

function writeMigration(filename: string, sql = 'SELECT 1;\n'): void {
  fs.writeFileSync(path.join(migrationsDir, filename), sql);
}

function makeHistoryRecord(overrides: Partial<HistoryRecord> & { Version: string | null }): HistoryRecord {
  return {
    InstalledRank: overrides.InstalledRank ?? 1,
    Version: overrides.Version,
    Description: overrides.Description ?? 'desc',
    Type: overrides.Type ?? 'SQL',
    Script: overrides.Script ?? 'V_x.sql',
    Checksum: overrides.Checksum ?? null,
    InstalledBy: overrides.InstalledBy ?? 'sa',
    InstalledOn: overrides.InstalledOn ?? new Date('2026-01-01'),
    ExecutionTime: overrides.ExecutionTime ?? 0,
    Success: overrides.Success ?? true,
  };
}

function makeSkyway(provider: FakeProvider): Skyway {
  return new Skyway({
    Provider: provider,
    Database: provider.Config,
    Migrations: { Locations: [migrationsDir], DefaultSchema: 'dbo' },
  });
}

const config: DatabaseConfig = {
  Server: 'localhost',
  Database: 'test',
  User: 'sa',
  Password: 'x',
};

// ─── Tests ───────────────────────────────────────────────────────────

describe('Skyway.Repair() — duplicate versions', () => {
  it('fails and mutates nothing when two files share a version', async () => {
    const provider = new FakeProvider(config);
    provider.History.records = [
      makeHistoryRecord({ InstalledRank: 1, Version: '202601010000', Description: 'failed one', Success: false }),
      makeHistoryRecord({ InstalledRank: 2, Version: '202606021200', Description: 'applied', Checksum: 999 }),
    ];
    writeMigration('V202606021200__First.sql');
    writeMigration('V202606021200__Second.sql');

    const result = await makeSkyway(provider).Repair();

    expect(result.Success).toBe(false);
    expect(result.ErrorMessage).toMatch(/Found more than one migration with version 202606021200/);
    expect(result.FailedEntriesRemoved).toBe(0);
    expect(result.ChecksumsRealigned).toBe(0);
    // Guard runs before any mutation: failed entry still present, checksum untouched.
    expect(provider.History.records.some((r) => r.Success === false)).toBe(true);
    expect(provider.History.records.find((r) => r.Version === '202606021200')?.Checksum).toBe(999);
  });

  it('still repairs normally when versions are distinct (negative control)', async () => {
    const provider = new FakeProvider(config);
    provider.History.records = [
      makeHistoryRecord({ InstalledRank: 1, Version: '202601010000', Description: 'failed one', Success: false }),
      makeHistoryRecord({ InstalledRank: 2, Version: '202606021200', Description: 'drifted checksum', Checksum: 999 }),
    ];
    writeMigration('V202606021200__drifted.sql', 'SELECT 1;\n');

    const result = await makeSkyway(provider).Repair();

    expect(result.Success).toBe(true);
    expect(result.FailedEntriesRemoved).toBe(1);
    expect(result.ChecksumsRealigned).toBe(1);
  });
});
