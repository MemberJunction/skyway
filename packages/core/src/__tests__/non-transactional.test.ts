/**
 * executeInTransaction=false support: Flyway-style `<file>.sql.conf` script config files,
 * and running such migrations outside a transaction in both transaction modes.
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
import { ParseScriptConfig, LoadScriptConfig } from '../migration/script-config';
import { ScanAndResolveMigrations } from '../migration/scanner';

// ─── Recording fake provider ─────────────────────────────────────────

class RecordingHistory implements HistoryTableProvider {
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
  migrationVersions(): (string | null)[] {
    return this.records.filter((r) => r.Type !== 'SCHEMA').map((r) => r.Version);
  }
}

class RecordingProvider implements DatabaseProvider {
  readonly Dialect = 'postgresql' as const;
  readonly DefaultSchema = 'public';
  readonly DefaultPort = 5432;
  readonly History = new RecordingHistory();
  IsConnected = false;
  /** "txn<n>:<sql>" for statements run in transaction n, "direct:<sql>" outside one. */
  readonly Log: string[] = [];
  Commits = 0;
  Rollbacks = 0;
  /** SQL that should fail when executed. */
  FailOn = new Set<string>();
  private txnCount = 0;

  constructor(readonly Config: DatabaseConfig, private withStatementSplitter = true) {
    if (!withStatementSplitter) {
      this.SplitStatements = undefined;
    }
  }

  async Connect(): Promise<void> { this.IsConnected = true; }
  async Disconnect(): Promise<void> { this.IsConnected = false; }
  async DatabaseExists(): Promise<boolean> { return true; }
  async CreateDatabase(): Promise<void> {}
  async DropDatabase(): Promise<void> {}
  async BeginTransaction(): Promise<ProviderTransaction> {
    const id = ++this.txnCount;
    const run = async (sql: string) => this.run(`txn${id}`, sql);
    return {
      Execute: run,
      Query: async <T>() => [] as T[],
      Commit: async () => { this.Commits++; },
      Rollback: async () => { this.Rollbacks++; },
    };
  }
  async Execute(sql: string): Promise<void> { await this.run('direct', sql); }
  async Query<T>(): Promise<T[]> { return []; }
  SplitScript(script: string): SQLBatch[] {
    return [{ SQL: script.trim(), RepeatCount: 1, StartLine: 1, EndLine: 1 }];
  }
  SplitStatements?(script: string): SQLBatch[] {
    return script.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
      .map((s) => ({ SQL: s, RepeatCount: 1, StartLine: 1, EndLine: 1 }));
  }
  async GetCleanOperations(): Promise<CleanOperation[]> { return []; }
  async DropSchema(): Promise<void> {}

  private async run(where: string, sql: string): Promise<void> {
    this.Log.push(`${where}:${sql}`);
    if (this.FailOn.has(sql)) {
      throw new Error(`boom: ${sql}`);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-notxn-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(file: string, sql: string, conf?: string): void {
  fs.writeFileSync(path.join(dir, file), sql);
  if (conf !== undefined) {
    fs.writeFileSync(path.join(dir, `${file}.conf`), conf);
  }
}

const dbConfig: DatabaseConfig = { Server: 'localhost', Database: 'test', User: 'u', Password: 'p' };

function skyway(provider: RecordingProvider, mode: TransactionMode): Skyway {
  return new Skyway({
    Provider: provider,
    Database: provider.Config,
    Migrations: { Locations: [dir], DefaultSchema: 'public' },
    TransactionMode: mode,
  });
}

/** Strips the transaction number so assertions read "txn:" vs "direct:". */
const where = (p: RecordingProvider) => p.Log.map((l) => l.replace(/^txn\d+/, 'txn'));

// ─── Script config files ─────────────────────────────────────────────

describe('ParseScriptConfig', () => {
  it('reads executeInTransaction, case-insensitively, ignoring comments and other keys', () => {
    expect(ParseScriptConfig('# Flyway script config\nexecuteInTransaction=false\n')).toEqual({ ExecuteInTransaction: false });
    expect(ParseScriptConfig('  EXECUTEINTRANSACTION = True  ')).toEqual({ ExecuteInTransaction: true });
    expect(ParseScriptConfig('encoding=UTF-8\n\nnot a pair\n')).toEqual({});
  });

  it('rejects a value other than true/false', () => {
    expect(() => ParseScriptConfig('executeInTransaction=no', 'V1.sql.conf')).toThrow(/V1\.sql\.conf: executeInTransaction must be true or false/);
  });
});

describe('LoadScriptConfig / ResolveMigration', () => {
  it('returns an empty config when there is no .conf file', async () => {
    expect(await LoadScriptConfig(path.join(dir, 'V1__none.sql'))).toEqual({});
  });

  it('marks a migration non-transactional only when its .conf says so', async () => {
    write('V1__plain.sql', 'SELECT 1;');
    write('V2__concurrent.sql', 'CREATE INDEX CONCURRENTLY a ON t (c);', 'executeInTransaction=false\n');
    const migrations = await ScanAndResolveMigrations([dir]);
    expect(migrations.map((m) => [m.Filename, m.ExecuteInTransaction])).toEqual([
      ['V1__plain.sql', true],
      ['V2__concurrent.sql', false],
    ]);
  });

  it('does not treat .conf files as migrations', async () => {
    write('V1__x.sql', 'SELECT 1;', 'executeInTransaction=false');
    expect((await ScanAndResolveMigrations([dir])).map((m) => m.Filename)).toEqual(['V1__x.sql']);
  });
});

// ─── Execution ───────────────────────────────────────────────────────

describe.each<TransactionMode>(['per-run', 'per-migration'])('Migrate() with executeInTransaction=false (%s)', (mode) => {
  it('runs the marked migration outside a transaction, statement by statement, and records it in order', async () => {
    const provider = new RecordingProvider(dbConfig);
    write('V1__before.sql', 'CREATE TABLE t (c int);');
    write('V2__index.sql', 'CREATE INDEX CONCURRENTLY a ON t (c); CREATE INDEX CONCURRENTLY b ON t (c);', 'executeInTransaction=false');
    write('V3__after.sql', 'SELECT 3;');

    const result = await skyway(provider, mode).Migrate();

    expect(result.Success).toBe(true);
    expect(result.MigrationsApplied).toBe(3);
    expect(where(provider)).toEqual([
      'txn:CREATE TABLE t (c int);',
      'direct:CREATE INDEX CONCURRENTLY a ON t (c)',
      'direct:CREATE INDEX CONCURRENTLY b ON t (c)',
      'txn:SELECT 3;',
    ]);
    expect(provider.History.migrationVersions()).toEqual(['1', '2', '3']);
  });

  it('stops at a failing non-transactional migration and records nothing for it', async () => {
    const provider = new RecordingProvider(dbConfig);
    provider.FailOn.add('CREATE INDEX CONCURRENTLY b ON t (c)');
    write('V1__before.sql', 'SELECT 1;');
    write('V2__index.sql', 'CREATE INDEX CONCURRENTLY a ON t (c); CREATE INDEX CONCURRENTLY b ON t (c);', 'executeInTransaction=false');
    write('V3__after.sql', 'SELECT 3;');

    const result = await skyway(provider, mode).Migrate();

    expect(result.Success).toBe(false);
    expect(where(provider)).not.toContain('txn:SELECT 3;');
    expect(provider.History.migrationVersions()).toEqual(['1']);
  });

  it('falls back to SplitScript when the provider has no statement splitter', async () => {
    const provider = new RecordingProvider(dbConfig, false);
    write('V1__index.sql', 'CREATE INDEX CONCURRENTLY a ON t (c);', 'executeInTransaction=false');
    await skyway(provider, mode).Migrate();
    expect(where(provider)).toEqual(['direct:CREATE INDEX CONCURRENTLY a ON t (c);']);
  });
});

describe('Migrate() per-run mode around a non-transactional migration', () => {
  it('commits the migrations before it, then continues in a new transaction', async () => {
    const provider = new RecordingProvider(dbConfig);
    write('V1__a.sql', 'SELECT 1;');
    write('V2__b.sql', 'SELECT 2;');
    write('V3__idx.sql', 'CREATE INDEX CONCURRENTLY a ON t (c);', 'executeInTransaction=false');
    write('V4__c.sql', 'SELECT 4;');
    write('V5__d.sql', 'SELECT 5;');

    await skyway(provider, 'per-run').Migrate();

    expect(provider.Log).toEqual([
      'txn1:SELECT 1;', 'txn1:SELECT 2;',
      'direct:CREATE INDEX CONCURRENTLY a ON t (c)',
      'txn2:SELECT 4;', 'txn2:SELECT 5;',
    ]);
    expect(provider.Commits).toBe(2);
  });

  it('keeps migrations already committed before a later failure', async () => {
    const provider = new RecordingProvider(dbConfig);
    provider.FailOn.add('SELECT 4;');
    write('V1__a.sql', 'SELECT 1;');
    write('V2__idx.sql', 'CREATE INDEX CONCURRENTLY a ON t (c);', 'executeInTransaction=false');
    write('V3__c.sql', 'SELECT 3;');
    write('V4__d.sql', 'SELECT 4;');

    const result = await skyway(provider, 'per-run').Migrate();

    expect(result.Success).toBe(false);
    // V1 committed in its own transaction, V2 ran directly; V3+V4 shared a transaction that rolled back.
    expect(provider.Log).toEqual(['txn1:SELECT 1;', 'direct:CREATE INDEX CONCURRENTLY a ON t (c)', 'txn2:SELECT 3;', 'txn2:SELECT 4;']);
    expect(provider.Commits).toBe(1);
    expect(provider.Rollbacks).toBe(1);
    // (This fake's history table is not transactional, so V3's rolled-back row is still visible here.)
    expect(provider.History.migrationVersions().slice(0, 2)).toEqual(['1', '2']);
  });

  it('without any .conf files, still runs everything in one transaction', async () => {
    const provider = new RecordingProvider(dbConfig);
    write('V1__a.sql', 'SELECT 1;');
    write('V2__b.sql', 'SELECT 2;');
    await skyway(provider, 'per-run').Migrate();
    expect(provider.Log).toEqual(['txn1:SELECT 1;', 'txn1:SELECT 2;']);
    expect(provider.Commits).toBe(1);
  });
});
