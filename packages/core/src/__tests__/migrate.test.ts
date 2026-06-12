/**
 * Unit tests for `Skyway.Migrate()` duplicate-version handling.
 *
 * The regression these guard: two migration files on disk that share a
 * version were both marked PENDING and BOTH applied (two history rows for
 * one version, as seen in the real `mj_duplicate` database). Migrate() must
 * now fail fast before applying anything.
 *
 * Uses an in-memory fake provider with a working (no-op) transaction so the
 * double-apply actually reproduces pre-fix — both migrations would otherwise
 * execute and insert. Real-DB coverage lives in
 * integration-tests/sqlserver/duplicate-version-smoke.ts.
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

// ─── Fake provider (drives Migrate end-to-end) ───────────────────────

class FakeHistoryProvider implements HistoryTableProvider {
  records: HistoryRecord[] = [];
  exists = false;

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

  /** Migration rows only — excludes the rank-0 SCHEMA creation marker. */
  migrationRows(): HistoryRecord[] {
    return this.records.filter((r) => r.Type !== 'SCHEMA');
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
    // Working no-op transaction so migrations actually "apply".
    return {
      async Execute(): Promise<void> {},
      async Query<T>(): Promise<T[]> {
        return [];
      },
      async Commit(): Promise<void> {},
      async Rollback(): Promise<void> {},
    };
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
  migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-migrate-'));
});

afterEach(() => {
  if (fs.existsSync(migrationsDir)) fs.rmSync(migrationsDir, { recursive: true, force: true });
});

function writeMigration(filename: string, sql = 'SELECT 1;\n'): void {
  fs.writeFileSync(path.join(migrationsDir, filename), sql);
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

describe('Skyway.Migrate() — duplicate versions', () => {
  it('fails fast and applies nothing when two files share a version', async () => {
    const provider = new FakeProvider(config);
    writeMigration('V202606021200__First.sql');
    writeMigration('V202606021200__Second.sql');

    const result = await makeSkyway(provider).Migrate();

    expect(result.Success).toBe(false);
    expect(result.ErrorMessage).toMatch(/Found more than one migration with version 202606021200/);
    expect(result.MigrationsApplied).toBe(0);
    // The guard runs before EnsureExists, so on a fresh database nothing is
    // created — not the history table, not the rank-0 schema marker, no rows.
    expect(provider.History.exists).toBe(false);
    expect(provider.History.records).toHaveLength(0);
  });

  it('does not apply duplicates even in dry-run mode', async () => {
    const provider = new FakeProvider(config);
    writeMigration('V202606021200__First.sql');
    writeMigration('V202606021200__Second.sql');

    const skyway = new Skyway({
      Provider: provider,
      Database: provider.Config,
      Migrations: { Locations: [migrationsDir], DefaultSchema: 'dbo' },
      DryRun: true,
    });
    const result = await skyway.Migrate();

    expect(result.Success).toBe(false);
    expect(result.ErrorMessage).toMatch(/Found more than one migration with version 202606021200/);
    // Same fresh-DB guarantee holds in dry-run: nothing reaches the database.
    expect(provider.History.exists).toBe(false);
    expect(provider.History.records).toHaveLength(0);
  });

  it('still applies distinct versions normally (negative control)', async () => {
    const provider = new FakeProvider(config);
    writeMigration('V202606021200__First.sql');
    writeMigration('V202606021300__Second.sql');

    const result = await makeSkyway(provider).Migrate();

    expect(result.Success).toBe(true);
    expect(result.MigrationsApplied).toBe(2);
    expect(provider.History.migrationRows()).toHaveLength(2);
  });
});
