/**
 * Unit tests for `Skyway.Validate()` baseline-floor behavior.
 *
 * `Validate()` has its own disk-vs-history reconciliation that doesn't go
 * through the resolver, so it needs its own test coverage for the floor
 * fix. Resolver-level tests cover the StatusReport generation; these tests
 * cover the validation-error generation specifically.
 *
 * Uses an in-memory fake provider rather than mocking the SQL Server / PG
 * drivers — fast, deterministic, and exercises the actual Skyway class.
 * Real-DB coverage lives in integration-tests/sqlserver/baseline-floor-smoke.ts.
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

// ─── Fake provider ───────────────────────────────────────────────────
//
// Just enough of the DatabaseProvider surface to drive Validate(). All
// transaction / clean / migrate paths are stubbed because Validate()
// doesn't touch them.

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
    this.records.push({
      ...p,
      InstalledOn: new Date(),
    } as HistoryRecord);
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
    throw new Error('not used in Validate tests');
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
  migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-validate-'));
});

afterEach(() => {
  if (fs.existsSync(migrationsDir)) fs.rmSync(migrationsDir, { recursive: true, force: true });
});

function writeMigration(filename: string, sql = 'SELECT 1;\n'): void {
  fs.writeFileSync(path.join(migrationsDir, filename), sql);
}

function makeHistoryRecord(overrides: Partial<HistoryRecord> & { Version: string | null }): HistoryRecord {
  return {
    InstalledRank: 1,
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

// ─── Tests ───────────────────────────────────────────────────────────

describe('Skyway.Validate() — baseline floor', () => {
  it('does not flag a BASELINE row as missing-from-disk', () => {
    // The bug: Validate() walks the disk-by-version map and reports every
    // applied row whose version isn't on disk as "missing". A BASELINE row
    // with a pruned bootstrap file should not be flagged.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'BASELINE',
        Description: 'v5 Baseline',
      }),
    ];
    // No disk files.

    return makeSkyway(provider)
      .Validate()
      .then((result) => {
        expect(result.Errors).toHaveLength(0);
        expect(result.Valid).toBe(true);
      });
  });

  it('does not flag pre-baseline V files on disk as IGNORED', async () => {
    // Without the floor fix, Validate() would forward the resolver's IGNORED
    // states as validation errors. With the fix those entries are
    // ABOVE_BASELINE and never enter the error list.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'BASELINE',
        Description: 'v5 Baseline',
      }),
    ];
    writeMigration('V202401010000__pre_baseline.sql');

    const result = await makeSkyway(provider).Validate();
    expect(result.Errors).toHaveLength(0);
    expect(result.Valid).toBe(true);
  });

  it('still flags post-baseline V file with deleted history', async () => {
    // Negative control: a real applied V whose disk file vanished should
    // still be reported. The floor only suppresses what's at or below it.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'BASELINE',
        Description: 'v5 Baseline',
      }),
      makeHistoryRecord({
        InstalledRank: 2,
        Version: '202602160000',
        Type: 'SQL',
        Description: 'post baseline',
        Checksum: 12345,
      }),
    ];
    // No disk file for the post-baseline V — that's the failure case.

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(false);
    expect(result.Errors).toHaveLength(1);
    expect(result.Errors[0]).toMatch(/202602160000/);
    expect(result.Errors[0]).toMatch(/no longer found on disk/);
  });

  it('still flags checksum mismatch for post-baseline V file', async () => {
    // Another negative control: post-baseline files are still checksum-checked.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'BASELINE',
        Description: 'v5 Baseline',
      }),
      makeHistoryRecord({
        InstalledRank: 2,
        Version: '202602160000',
        Type: 'SQL',
        Description: 'post baseline',
        Checksum: 999, // wrong on purpose
      }),
    ];
    writeMigration('V202602160000__post_baseline.sql', 'SELECT 1;\n');

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(false);
    expect(result.Errors.some((e) => /Checksum mismatch/.test(e))).toBe(true);
  });

  it('uses highest baseline as floor when multiple baseline rows exist', async () => {
    // Mirrors MJ's stacked-baseline shape. The most-recent-dated baseline wins.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202502010000',
        Type: 'SQL_BASELINE',
        Description: 'v4 Baseline (older)',
      }),
      makeHistoryRecord({
        InstalledRank: 2,
        Version: '202602151200',
        Type: 'BASELINE',
        Description: 'v5 Baseline (most recent)',
      }),
      makeHistoryRecord({
        InstalledRank: 3,
        Version: '202401010000',
        Type: 'SQL',
        Description: 'pre-v4 applied long ago, file pruned',
      }),
    ];
    // Old V file on disk; bootstrap files pruned.
    writeMigration('V202301010000__ancient_v2.sql');

    const result = await makeSkyway(provider).Validate();
    // Pre-v4 SQL row is below the v5 floor → not MISSING.
    // Pre-baseline V on disk is ABOVE_BASELINE → not IGNORED.
    // Both baseline rows are baseline-typed → never flagged.
    expect(result.Valid).toBe(true);
    expect(result.Errors).toHaveLength(0);
  });
});

// ─── Validate() — Edge Cases ─────────────────────────────────────────

describe('Skyway.Validate() — edge cases', () => {
  it('three-baseline stack (MJ v3 + v4 + v5) — only post-v5 V files validated', async () => {
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({ InstalledRank: 1, Version: '202601122300', Type: 'SQL_BASELINE', Description: 'v3 Baseline' }),
      makeHistoryRecord({ InstalledRank: 2, Version: '202602061600', Type: 'SQL_BASELINE', Description: 'v4 Baseline' }),
      makeHistoryRecord({ InstalledRank: 3, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
      makeHistoryRecord({
        InstalledRank: 4,
        Version: '202602160000',
        Type: 'SQL',
        Description: 'post-v5 metadata sync',
        // Checksum=null means "no checksum to compare against" — keeps the
        // test focused on floor behavior, not checksum validation.
        Checksum: null,
      }),
    ];
    writeMigration('V202602160000__post_baseline.sql', 'SELECT 1;\n');

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(true);
    expect(result.Errors).toHaveLength(0);
  });

  it('install order does not affect floor — older baseline inserted after newer one is ignored', async () => {
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({ InstalledRank: 1, Version: '202602151200', Type: 'BASELINE', Description: 'v5 (inserted first)' }),
      makeHistoryRecord({ InstalledRank: 2, Version: '202401010000', Type: 'BASELINE', Description: 'v3 (inserted later)' }),
    ];
    // V file between v3 and v5 — must be subsumed by v5 (the higher version).
    writeMigration('V202501010000__between.sql');

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(true);
    expect(result.Errors).toHaveLength(0);
  });

  it('failed baseline does not set the floor — old SQL row is then a real MISSING', async () => {
    // Failed v5 baseline + real SQL row at v3 with no disk file.
    // Without the floor, the SQL row goes into the disk-vs-history check
    // and is correctly reported as missing. (User would Repair() to fix it.)
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'SQL_BASELINE',
        Description: 'v5 Baseline (failed)',
        Success: false,
      }),
      makeHistoryRecord({
        InstalledRank: 2,
        Version: '202401010000',
        Type: 'SQL',
        Description: 'old SQL row, file gone',
        Checksum: 12345,
      }),
    ];
    // No disk files.

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(false);
    expect(result.Errors.some((e) => /202401010000/.test(e))).toBe(true);
  });

  it('SCHEMA marker (rank 0) is never flagged regardless of floor', async () => {
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 0,
        Version: null,
        Type: 'SCHEMA',
        Description: '<< Flyway Schema Creation >>',
        Script: '[dbo]',
      }),
      makeHistoryRecord({ InstalledRank: 1, Version: '202602151200', Type: 'BASELINE', Description: 'v5 Baseline' }),
    ];

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(true);
  });

  it('checksum mismatch on a row exactly at the floor: not flagged (subsumed)', async () => {
    // Edge case: a SQL row at exactly the floor version. Without the floor,
    // it would be checksum-checked. With the floor, it's subsumed and
    // skipped — no checksum check, no missing-file check.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'SQL',
        Description: 'pre-existing applied at floor',
        Checksum: 999, // intentionally wrong
      }),
      makeHistoryRecord({
        InstalledRank: 2,
        Version: '202602151200',
        Type: 'SQL_BASELINE',
        Description: 'v5 Baseline',
      }),
    ];
    // Disk file is present with a different checksum, but the floor subsumes it.
    writeMigration('V202602151200__pre_baseline.sql', 'SELECT 1;\n');

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(true);
    expect(result.Errors).toHaveLength(0);
  });

  it('no history baseline + missing disk file → MISSING is still reported', async () => {
    // Negative control: without any baseline the floor is null and the
    // disk-vs-history check should run normally.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.records = [
      makeHistoryRecord({
        InstalledRank: 1,
        Version: '202601010000',
        Type: 'SQL',
        Description: 'real applied migration, file gone',
        Checksum: 12345,
      }),
    ];

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(false);
    expect(result.Errors.some((e) => /no longer found on disk/.test(e))).toBe(true);
  });

  it('history table does not exist → returns Valid: true with no errors', async () => {
    // Existing behavior: Validate() short-circuits when there's no history
    // table at all. Locking it because the new logic moved the resolver call
    // up; we don't want to accidentally break the short-circuit.
    const provider = new FakeProvider({
      Server: 'localhost',
      Database: 'test',
      User: 'sa',
      Password: 'x',
    });
    provider.History.exists = false;

    const result = await makeSkyway(provider).Validate();
    expect(result.Valid).toBe(true);
    expect(result.Errors).toHaveLength(0);
  });
});
