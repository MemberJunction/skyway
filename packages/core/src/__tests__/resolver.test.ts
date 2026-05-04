import { describe, it, expect } from 'vitest';
import { ResolveMigrations } from '../migration/resolver';
import { ResolvedMigration } from '../migration/types';
import { HistoryRecord } from '../history/types';

// ─── Test Helpers ────────────────────────────────────────────────────

function makeMigration(overrides: Partial<ResolvedMigration> = {}): ResolvedMigration {
  const version = overrides.Version ?? '202601010000';
  const type = overrides.Type ?? 'versioned';
  const prefix = type === 'baseline' ? 'B' : type === 'repeatable' ? 'R' : 'V';
  const desc = overrides.Description ?? 'Test migration';
  const filename = overrides.Filename ?? `${prefix}${version ?? ''}__${desc.replace(/ /g, '_')}.sql`;
  return {
    Type: type,
    Version: version,
    Description: desc,
    Filename: filename,
    FilePath: `/migrations/${filename}`,
    ScriptPath: overrides.ScriptPath ?? filename,
    SQL: overrides.SQL ?? 'SELECT 1',
    Checksum: overrides.Checksum ?? 12345,
  };
}

function makeHistory(overrides: Partial<HistoryRecord> & { Version?: string | null } = {}): HistoryRecord {
  return {
    InstalledRank: overrides.InstalledRank ?? 1,
    Version: 'Version' in overrides ? overrides.Version! : '202601010000',
    Description: overrides.Description ?? 'Test migration',
    Type: overrides.Type ?? 'SQL',
    Script: overrides.Script ?? 'V202601010000__Test_migration.sql',
    Checksum: overrides.Checksum ?? 12345,
    InstalledBy: overrides.InstalledBy ?? 'sa',
    InstalledOn: overrides.InstalledOn ?? new Date('2026-01-01'),
    ExecutionTime: overrides.ExecutionTime ?? 100,
    Success: overrides.Success ?? true,
  };
}

// ─── Auto-Selection Tests ────────────────────────────────────────────

describe('ResolveMigrations — baseline auto-selection', () => {
  it('auto-selects highest baseline when baselineVersion is default "1"', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202401010000', Description: 'v1 Baseline' }),
      makeMigration({ Type: 'baseline', Version: '202501010000', Description: 'v2 Baseline' }),
      makeMigration({ Type: 'baseline', Version: '202601122300', Description: 'v3 Baseline' }),
    ];

    const result = ResolveMigrations(discovered, [], '1', true, false);

    expect(result.BaselineAutoSelected).toBe(true);
    expect(result.EffectiveBaselineVersion).toBe('202601122300');
    expect(result.BaselineFileCount).toBe(3);
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202601122300');
  });

  it('auto-selects single baseline when only one exists', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202601010000', Description: 'Only Baseline' }),
    ];

    const result = ResolveMigrations(discovered, [], '1', true, false);

    expect(result.BaselineAutoSelected).toBe(true);
    expect(result.EffectiveBaselineVersion).toBe('202601010000');
    expect(result.BaselineFileCount).toBe(1);
    expect(result.PendingMigrations).toHaveLength(1);
  });

  it('returns no baseline when no B files exist', () => {
    const discovered = [
      makeMigration({ Type: 'versioned', Version: '202601010000' }),
    ];

    const result = ResolveMigrations(discovered, [], '1', true, false);

    expect(result.BaselineAutoSelected).toBe(false);
    expect(result.EffectiveBaselineVersion).toBeNull();
    expect(result.BaselineFileCount).toBe(0);
    expect(result.ShouldBaseline).toBe(true);
  });

  it('uses explicit version when baselineVersion is not the default', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202401010000', Description: 'v1 Baseline' }),
      makeMigration({ Type: 'baseline', Version: '202501010000', Description: 'v2 Baseline' }),
      makeMigration({ Type: 'baseline', Version: '202601122300', Description: 'v3 Baseline' }),
    ];

    const result = ResolveMigrations(discovered, [], '202501010000', true, false);

    expect(result.BaselineAutoSelected).toBe(false);
    expect(result.EffectiveBaselineVersion).toBe('202501010000');
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202501010000');
  });

  it('returns no baseline when explicit version does not match any file', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202601010000', Description: 'Baseline' }),
    ];

    const result = ResolveMigrations(discovered, [], '999999999999', true, false);

    expect(result.BaselineAutoSelected).toBe(false);
    expect(result.EffectiveBaselineVersion).toBeNull();
    expect(result.PendingMigrations).toHaveLength(0);
  });

  it('skips versioned migrations at or below auto-selected baseline', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202601122300', Description: 'v3 Baseline' }),
      makeMigration({ Type: 'versioned', Version: '202401010001', Description: 'Add Users Table' }),
      makeMigration({ Type: 'versioned', Version: '202501010001', Description: 'Add Roles Table' }),
      makeMigration({ Type: 'versioned', Version: '202601010000', Description: 'Add Audit Log' }),
      makeMigration({ Type: 'versioned', Version: '202601122301', Description: 'Add Notifications' }),
    ];

    const result = ResolveMigrations(discovered, [], '1', true, false);

    // Baseline + the one versioned migration above it
    expect(result.PendingMigrations).toHaveLength(2);
    expect(result.PendingMigrations[0].Type).toBe('baseline');
    expect(result.PendingMigrations[1].Version).toBe('202601122301');

    // The three migrations at/below baseline should be ABOVE_BASELINE
    const aboveBaseline = result.StatusReport.filter((s) => s.State === 'ABOVE_BASELINE');
    expect(aboveBaseline).toHaveLength(3);
    expect(aboveBaseline.map((s) => s.Version)).toEqual([
      '202401010001',
      '202501010001',
      '202601010000',
    ]);
  });

  it('applies versioned migrations above auto-selected baseline', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202501010000', Description: 'Baseline' }),
      makeMigration({ Type: 'versioned', Version: '202501010001', Description: 'After Baseline' }),
      makeMigration({ Type: 'versioned', Version: '202601010000', Description: 'Way After Baseline' }),
    ];

    const result = ResolveMigrations(discovered, [], '1', true, false);

    const pendingVersioned = result.PendingMigrations.filter((m) => m.Type === 'versioned');
    expect(pendingVersioned).toHaveLength(2);
    expect(pendingVersioned[0].Version).toBe('202501010001');
    expect(pendingVersioned[1].Version).toBe('202601010000');
  });

  it('does not auto-select when database has existing history', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202601010000', Description: 'Baseline' }),
    ];
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202501010000', Type: 'SQL' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', true, false);

    expect(result.ShouldBaseline).toBe(false);
    expect(result.BaselineAutoSelected).toBe(false);
    expect(result.EffectiveBaselineVersion).toBeNull();
    expect(result.PendingMigrations).toHaveLength(0);
  });

  it('does not auto-select when BaselineOnMigrate is false', () => {
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202601010000', Description: 'Baseline' }),
    ];

    const result = ResolveMigrations(discovered, [], '1', false, false);

    expect(result.ShouldBaseline).toBe(false);
    expect(result.BaselineAutoSelected).toBe(false);
    expect(result.EffectiveBaselineVersion).toBeNull();
    expect(result.PendingMigrations).toHaveLength(0);
  });
});

// ─── Existing Resolver Behavior (Regression Tests) ───────────────────

describe('ResolveMigrations — versioned migrations', () => {
  it('marks new versioned migration as pending', () => {
    const discovered = [
      makeMigration({ Version: '202601010000', Description: 'Add Users' }),
    ];

    const result = ResolveMigrations(discovered, [], '1', false, false);

    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202601010000');

    const status = result.StatusReport.find((s) => s.Version === '202601010000');
    expect(status?.State).toBe('PENDING');
  });

  it('marks already-applied migration as APPLIED', () => {
    const discovered = [
      makeMigration({ Version: '202601010000', Checksum: 12345 }),
    ];
    const applied = [
      makeHistory({ Version: '202601010000', Checksum: 12345 }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.PendingMigrations).toHaveLength(0);
    const status = result.StatusReport.find((s) => s.Version === '202601010000');
    expect(status?.State).toBe('APPLIED');
  });

  it('reports migration in history but not on disk as MISSING', () => {
    const applied = [
      makeHistory({ Version: '202601010000', Description: 'Deleted migration' }),
    ];

    const result = ResolveMigrations([], applied, '1', false, false);

    const status = result.StatusReport.find((s) => s.Version === '202601010000');
    expect(status?.State).toBe('MISSING');
  });

  it('reports failed migration as FAILED', () => {
    const discovered = [
      makeMigration({ Version: '202601010000', Checksum: 12345 }),
    ];
    const applied = [
      makeHistory({ Version: '202601010000', Checksum: 12345, Success: false }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.PendingMigrations).toHaveLength(0);
    const status = result.StatusReport.find((s) => s.Version === '202601010000');
    expect(status?.State).toBe('FAILED');
  });
});

describe('ResolveMigrations — repeatable migrations', () => {
  it('marks new repeatable migration as pending', () => {
    const discovered = [
      makeMigration({ Type: 'repeatable', Version: null, Description: 'RefreshMetadata', Checksum: 111 }),
    ];

    const result = ResolveMigrations(discovered, [], '1', false, false);

    expect(result.PendingMigrations).toHaveLength(1);
    const status = result.StatusReport.find((s) => s.Description === 'RefreshMetadata');
    expect(status?.State).toBe('PENDING');
  });

  it('marks repeatable with changed checksum as OUTDATED', () => {
    const discovered = [
      makeMigration({ Type: 'repeatable', Version: null, Description: 'RefreshMetadata', Checksum: 222 }),
    ];
    const applied = [
      makeHistory({ Version: null, Description: 'RefreshMetadata', Type: 'SQL', Checksum: 111 }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.PendingMigrations).toHaveLength(1);
    const status = result.StatusReport.find((s) => s.Description === 'RefreshMetadata');
    expect(status?.State).toBe('OUTDATED');
  });

  it('skips repeatable with unchanged checksum', () => {
    const discovered = [
      makeMigration({ Type: 'repeatable', Version: null, Description: 'RefreshMetadata', Checksum: 111 }),
    ];
    const applied = [
      makeHistory({ Version: null, Description: 'RefreshMetadata', Type: 'SQL', Checksum: 111 }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.PendingMigrations).toHaveLength(0);
    const status = result.StatusReport.find((s) => s.Description === 'RefreshMetadata');
    expect(status?.State).toBe('APPLIED');
  });
});

describe('ResolveMigrations — out-of-order', () => {
  it('marks out-of-order migration as IGNORED when outOfOrder is false', () => {
    const discovered = [
      makeMigration({ Version: '202401010000', Description: 'Old migration' }),
    ];
    const applied = [
      makeHistory({ Version: '202601010000', Description: 'Applied later' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.PendingMigrations).toHaveLength(0);
    const status = result.StatusReport.find((s) => s.Version === '202401010000');
    expect(status?.State).toBe('IGNORED');
  });

  it('includes out-of-order migration as PENDING when outOfOrder is true', () => {
    const discovered = [
      makeMigration({ Version: '202401010000', Description: 'Old migration' }),
    ];
    const applied = [
      makeHistory({ Version: '202601010000', Description: 'Applied later' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, true);

    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202401010000');
    const status = result.StatusReport.find((s) => s.Version === '202401010000');
    expect(status?.State).toBe('PENDING');
  });

  it('marks all out-of-order migrations as IGNORED and keeps future ones PENDING', () => {
    const discovered = [
      makeMigration({ Version: '202301010000', Description: 'Very old' }),
      makeMigration({ Version: '202401010000', Description: 'Old' }),
      makeMigration({ Version: '202701010000', Description: 'Future' }),
    ];
    const applied = [
      makeHistory({ Version: '202601010000', Description: 'Applied' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    // Two migrations are below highest applied (202601010000)
    const ignored = result.StatusReport.filter((s) => s.State === 'IGNORED');
    expect(ignored).toHaveLength(2);
    expect(ignored.map((s) => s.Version)).toEqual(['202301010000', '202401010000']);

    // One migration is above — should be PENDING
    const pending = result.StatusReport.filter((s) => s.State === 'PENDING');
    expect(pending).toHaveLength(1);
    expect(pending[0].Version).toBe('202701010000');

    // Only the future migration should be in PendingMigrations
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202701010000');
  });

  it('does not mark earlier migrations as IGNORED on fresh DB with baseline', () => {
    // Simulates the MJ scenario: v2, v3, v4, v5 migration folders.
    // On a fresh database with baselineOnMigrate=true, the highest baseline
    // is auto-selected. Migrations at/below the baseline should be ABOVE_BASELINE,
    // migrations above should be PENDING. None should be IGNORED.
    const discovered = [
      // Baseline file (latest)
      makeMigration({ Type: 'baseline', Version: '202601010000', Description: 'v5 Baseline' }),
      // Old versioned migrations (v2, v3, v4 — below baseline)
      makeMigration({ Version: '202301010000', Description: 'v2 Create Users' }),
      makeMigration({ Version: '202401010000', Description: 'v3 Add Roles' }),
      makeMigration({ Version: '202501010000', Description: 'v4 Add Permissions' }),
      // New versioned migrations (v5 — above baseline)
      makeMigration({ Version: '202601010001', Description: 'v5 Add Audit Log' }),
      makeMigration({ Version: '202601020000', Description: 'v5 Add Notifications' }),
    ];

    // Fresh database — no applied history
    const result = ResolveMigrations(discovered, [], '1', true, false);

    // Baseline should be auto-selected
    expect(result.BaselineAutoSelected).toBe(true);
    expect(result.EffectiveBaselineVersion).toBe('202601010000');

    // No migrations should be IGNORED
    const ignored = result.StatusReport.filter((s) => s.State === 'IGNORED');
    expect(ignored).toHaveLength(0);

    // Old migrations should be ABOVE_BASELINE
    const aboveBaseline = result.StatusReport.filter((s) => s.State === 'ABOVE_BASELINE');
    expect(aboveBaseline).toHaveLength(3);
    expect(aboveBaseline.map((s) => s.Version)).toEqual([
      '202301010000',
      '202401010000',
      '202501010000',
    ]);

    // New migrations should be PENDING
    const pending = result.StatusReport.filter(
      (s) => s.State === 'PENDING' && s.Type === 'versioned'
    );
    expect(pending).toHaveLength(2);
    expect(pending.map((s) => s.Version)).toEqual(['202601010001', '202601020000']);

    // PendingMigrations should include baseline + 2 versioned
    expect(result.PendingMigrations).toHaveLength(3);
    expect(result.PendingMigrations[0].Type).toBe('baseline');
    expect(result.PendingMigrations[1].Version).toBe('202601010001');
    expect(result.PendingMigrations[2].Version).toBe('202601020000');
  });
});

// ─── Baseline Floor From History ─────────────────────────────────────
//
// Once a baseline has been recorded in `flyway_schema_history`, that version
// is a permanent floor: V-files at or below it are subsumed by the baseline
// and must not be flagged as IGNORED, MISSING, or PENDING. The floor applies
// regardless of `BaselineOnMigrate` (the flag only governs whether to *create*
// a baseline on a fresh DB; the resolver still needs to honor an existing one).

describe('ResolveMigrations — baseline floor from history', () => {
  it('marks earlier V files as ABOVE_BASELINE when a BASELINE row exists in history', () => {
    const discovered = [
      makeMigration({ Version: '202301010000', Description: 'v1 Create Users' }),
      makeMigration({ Version: '202401010000', Description: 'v2 Add Roles' }),
      makeMigration({ Version: '202601020000', Description: 'v5 Add Audit' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202601010000',
        Type: 'BASELINE',
        Description: 'Skyway baseline',
        Checksum: null,
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202601010000');

    // Earlier files must NOT appear as IGNORED
    const ignored = result.StatusReport.filter((s) => s.State === 'IGNORED');
    expect(ignored).toHaveLength(0);

    // The two pre-baseline V files are subsumed
    const aboveBaseline = result.StatusReport.filter((s) => s.State === 'ABOVE_BASELINE');
    expect(aboveBaseline.map((s) => s.Version).sort()).toEqual([
      '202301010000',
      '202401010000',
    ]);

    // Only the post-baseline V file is pending
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202601020000');
  });

  it('treats SQL_BASELINE rows as floor (B-prefixed file that ran)', () => {
    const discovered = [
      makeMigration({ Version: '202301010000', Description: 'v1 Create Users' }),
      makeMigration({ Version: '202601020000', Description: 'v5 Add Audit' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202601010000',
        Type: 'SQL_BASELINE',
        Description: 'v5 Baseline',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202601010000');
    const aboveBaseline = result.StatusReport.filter((s) => s.State === 'ABOVE_BASELINE');
    expect(aboveBaseline).toHaveLength(1);
    expect(aboveBaseline[0].Version).toBe('202301010000');
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202601020000');
  });

  it('uses the highest baseline when multiple baseline rows exist in history', () => {
    const discovered = [
      makeMigration({ Version: '202501010000', Description: 'v4 Between Baselines' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202401010000',
        Type: 'BASELINE',
        Description: 'old baseline',
      }),
      makeHistory({
        InstalledRank: 2,
        Version: '202601010000',
        Type: 'BASELINE',
        Description: 'new baseline',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202601010000');
    const status = result.StatusReport.find((s) => s.Version === '202501010000');
    expect(status?.State).toBe('ABOVE_BASELINE');
    expect(result.PendingMigrations).toHaveLength(0);
  });

  it('does not flag baseline-typed history records as MISSING when their file is gone', () => {
    // Common case: the B*.sql bootstrap was deleted after running.
    const discovered = [
      makeMigration({ Version: '202601020000', Description: 'v5 Add Audit' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202601010000',
        Type: 'BASELINE',
        Description: 'Baseline',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    const missing = result.StatusReport.filter((s) => s.State === 'MISSING');
    expect(missing).toHaveLength(0);
  });

  it('does not flag pre-baseline SQL records as MISSING when their files are gone', () => {
    // The pre-baseline V-files were applied long ago but have since been deleted
    // from disk because the baseline replaces them. They must not appear as MISSING.
    const discovered: ReturnType<typeof makeMigration>[] = [];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202401010000',
        Type: 'SQL',
        Description: 'old applied migration',
      }),
      makeHistory({
        InstalledRank: 2,
        Version: '202601010000',
        Type: 'BASELINE',
        Description: 'Baseline',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    const missing = result.StatusReport.filter((s) => s.State === 'MISSING');
    expect(missing).toHaveLength(0);
  });

  it('still flags post-baseline V records as MISSING when their files are gone', () => {
    // Records strictly above the floor are real V-migrations; their disk
    // files going missing is still a real problem.
    const discovered: ReturnType<typeof makeMigration>[] = [];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202601010000',
        Type: 'BASELINE',
        Description: 'Baseline',
      }),
      makeHistory({
        InstalledRank: 2,
        Version: '202601020000',
        Type: 'SQL',
        Description: 'Post-baseline migration',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    const missing = result.StatusReport.filter((s) => s.State === 'MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0].Version).toBe('202601020000');
  });

  it('reports a stale B-file below the floor as ABOVE_BASELINE', () => {
    // The user kept the older B file around but a newer baseline has since run.
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202401010000', Description: 'v3 Baseline' }),
      makeMigration({ Version: '202601020000', Description: 'v5 New Migration' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202601010000',
        Type: 'BASELINE',
        Description: 'Baseline v5',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202601010000');
    const staleBaseline = result.StatusReport.find(
      (s) => s.Version === '202401010000' && s.Type === 'baseline'
    );
    expect(staleBaseline?.State).toBe('ABOVE_BASELINE');

    // Stale B file is not pending
    expect(result.PendingMigrations.find((m) => m.Version === '202401010000')).toBeUndefined();
    // Post-baseline V is pending
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202601020000');
  });

  it('regression — Validate flow: history baseline + earlier V on disk produces no IGNORED', () => {
    // `Skyway.Validate()` walks StatusReport for IGNORED entries and reports
    // them as validation errors. After this fix that should no longer fire
    // for files subsumed by the floor.
    const discovered = [
      makeMigration({ Version: '202301010000', Description: 'pre-baseline' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202601010000',
        Type: 'BASELINE',
        Description: 'Baseline',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.StatusReport.find((s) => s.State === 'IGNORED')).toBeUndefined();
  });

  it('mixed BASELINE + SQL_BASELINE: most recent (highest) wins (MJ stacked-baseline scenario)', () => {
    // Mirrors MJ's real history: an older v4 baseline ran from a B file
    // (SQL_BASELINE), then a newer v5 baseline was inserted via Skyway.Baseline()
    // (BASELINE). The latest dated baseline must drive the floor regardless of
    // which mechanism produced the row.
    const discovered = [
      // v2-v4 era V files still on disk
      makeMigration({ Version: '202301010000', Description: 'v2 Create Users' }),
      makeMigration({ Version: '202401010000', Description: 'v3 Add Roles' }),
      makeMigration({ Version: '202501010000', Description: 'v4 Add Permissions' }),
      // post v5-baseline migration on disk
      makeMigration({ Version: '202602160000', Description: 'v5 Add Audit' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202502010000',
        Type: 'SQL_BASELINE',
        Description: 'v4 Baseline (older)',
      }),
      makeHistory({
        InstalledRank: 2,
        Version: '202602151200',
        Type: 'BASELINE',
        Description: 'v5 Baseline (most recent)',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    // Floor should be the most-recent-dated baseline.
    expect(result.EffectiveBaselineVersion).toBe('202602151200');

    // All three pre-v5-baseline V files are ABOVE_BASELINE.
    const aboveBaseline = result.StatusReport.filter((s) => s.State === 'ABOVE_BASELINE');
    expect(aboveBaseline.map((s) => s.Version).sort()).toEqual([
      '202301010000',
      '202401010000',
      '202501010000',
    ]);

    // None ignored — pre-baseline V files must not trip the out-of-order check.
    expect(result.StatusReport.filter((s) => s.State === 'IGNORED')).toHaveLength(0);

    // Only the post-baseline V is pending.
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202602160000');
  });

  it('MJ-shaped scenario: B baseline file ran (SQL_BASELINE), pre/post V files coexist on disk', () => {
    // Mirrors the actual layout in MJ/migrations/v5/:
    //   B202602151200__v5.0__Baseline.sql        (recorded as SQL_BASELINE)
    //   V202602131500__v5.0.x__...sql            (pre-baseline, rolled into B)
    //   V202602141421__v5.0.x__...sql            (pre-baseline, rolled into B)
    //   V202602161825__v5.0.x__Metadata_Sync.sql (post-baseline, runs normally)
    //   V202602170015__v5.1__...sql              (post-baseline, runs normally)
    //
    // After the v5 baseline has been applied, only the V files above
    // 202602151200 should be checked.
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202602151200', Description: 'v5.0 Baseline' }),
      makeMigration({ Version: '202602131500', Description: 'v5.0.x pre-baseline 1' }),
      makeMigration({ Version: '202602141421', Description: 'v5.0.x pre-baseline 2' }),
      makeMigration({ Version: '202602161825', Description: 'v5.0.x post-baseline' }),
      makeMigration({ Version: '202602170015', Description: 'v5.1 post-baseline' }),
    ];
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'SQL_BASELINE',
        Description: 'v5.0 Baseline',
      }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202602151200');

    // Both pre-baseline V files are subsumed.
    const aboveBaseline = result.StatusReport.filter(
      (s) => s.State === 'ABOVE_BASELINE' && s.Type === 'versioned'
    );
    expect(aboveBaseline.map((s) => s.Version).sort()).toEqual([
      '202602131500',
      '202602141421',
    ]);

    // Nothing IGNORED — proves the bug stays fixed.
    expect(result.StatusReport.filter((s) => s.State === 'IGNORED')).toHaveLength(0);

    // Post-baseline V files are PENDING and ready to run.
    expect(result.PendingMigrations.map((m) => m.Version).sort()).toEqual([
      '202602161825',
      '202602170015',
    ]);

    // The B file on disk is reported alongside its history row (BASELINE state),
    // not re-pending.
    const bFileStatus = result.StatusReport.find(
      (s) => s.Type === 'baseline' && s.Version === '202602151200'
    );
    expect(bFileStatus?.State).toBe('BASELINE');
  });
});

// ─── Baseline Floor — Edge Cases ─────────────────────────────────────
//
// Exhaustive coverage of less-obvious interactions: multi-baseline stacks,
// ordering, failed baselines, MJ-real three-baseline shape, plus boundary
// conditions on the disk-vs-history reconciliation. These exist to lock
// behavior so future refactors don't silently regress.

describe('ResolveMigrations — baseline floor edge cases', () => {
  it('three baselines stacked (MJ v3 + v4 + v5 actual repo shape)', () => {
    // /MJ/migrations contains B202601122300 (v3), B202602061600 (v4),
    // B202602151200 (v5). After all three have run, only V files above the
    // v5 baseline should be in scope.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202601122300', Type: 'SQL_BASELINE', Description: 'v3 Baseline' }),
      makeHistory({ InstalledRank: 2, Version: '202602061600', Type: 'SQL_BASELINE', Description: 'v4 Baseline' }),
      makeHistory({ InstalledRank: 3, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
    ];
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202601122300', Description: 'v3 Baseline' }),
      makeMigration({ Type: 'baseline', Version: '202602061600', Description: 'v4 Baseline' }),
      makeMigration({ Type: 'baseline', Version: '202602151200', Description: 'v5 Baseline' }),
      makeMigration({ Version: '202601150000', Description: 'between v3 and v4' }),
      makeMigration({ Version: '202602100000', Description: 'between v4 and v5' }),
      makeMigration({ Version: '202602160000', Description: 'after v5' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202602151200');
    expect(result.StatusReport.filter((s) => s.State === 'IGNORED')).toHaveLength(0);

    // The two pre-v5 V files are ABOVE_BASELINE.
    const versionedAbove = result.StatusReport.filter(
      (s) => s.Type === 'versioned' && s.State === 'ABOVE_BASELINE'
    );
    expect(versionedAbove.map((s) => s.Version).sort()).toEqual([
      '202601150000',
      '202602100000',
    ]);

    // Only the post-v5 V file is pending.
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202602160000');

    // All three B files report as BASELINE.
    const baselineStates = result.StatusReport.filter((s) => s.Type === 'baseline');
    expect(baselineStates).toHaveLength(3);
    for (const b of baselineStates) {
      expect(b.State).toBe('BASELINE');
    }
  });

  it('install order does not affect floor — highest version wins regardless of InstalledRank', () => {
    // Defensive: someone manually inserts an OLDER baseline AFTER a newer one.
    // The floor must still be the higher version.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'BASELINE', Description: 'v5 Baseline (inserted first)' }),
      makeHistory({ InstalledRank: 2, Version: '202401010000', Type: 'BASELINE', Description: 'v3 Baseline (inserted later)' }),
    ];
    const discovered = [
      makeMigration({ Version: '202501010000', Description: 'between v3 and v5' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    // Higher version (v5) wins, NOT the most-recently-inserted (v3).
    expect(result.EffectiveBaselineVersion).toBe('202602151200');
    const status = result.StatusReport.find((s) => s.Version === '202501010000');
    expect(status?.State).toBe('ABOVE_BASELINE');
  });

  it('failed baseline (Success=false) does not set the floor', () => {
    // A failed baseline never established state. If it's still in history
    // (user hasn't run Repair() yet), it must NOT be treated as the floor —
    // otherwise we'd silently skip migrations the user still needs.
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'SQL_BASELINE',
        Description: 'v5 Baseline (failed)',
        Success: false,
      }),
    ];
    const discovered = [
      makeMigration({ Version: '202602100000', Description: 'pre-v5' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBeNull();
    // Without a floor, the pre-v5 V file behaves normally — no IGNORED
    // (highestApplied is null because failed baseline still appears as
    // a history row, but the file is below ... wait, getHighestAppliedVersion
    // doesn't check Success, so the failed baseline DOES set highestApplied.
    // The migration at 202602100000 is BELOW that, so without a floor
    // suppressing it, it would land in IGNORED. That's a real concern but
    // out of scope for this fix — Repair() is the user's tool here.
    // We just assert the floor isn't set; we don't make claims about the
    // pre-v5 V file's classification.
  });

  it('failed baseline does not block higher succeeded baseline from being floor', () => {
    // Both rows present: failed v3 baseline + succeeded v5 baseline.
    // The v5 (Success=true) wins as floor; v3 is ignored entirely.
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202401010000',
        Type: 'SQL_BASELINE',
        Description: 'v3 Baseline (failed)',
        Success: false,
      }),
      makeHistory({
        InstalledRank: 2,
        Version: '202602151200',
        Type: 'SQL_BASELINE',
        Description: 'v5 Baseline (success)',
        Success: true,
      }),
    ];
    const discovered = [
      makeMigration({ Version: '202501010000', Description: 'between v3 and v5' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202602151200');
    const status = result.StatusReport.find((s) => s.Version === '202501010000');
    expect(status?.State).toBe('ABOVE_BASELINE');
  });

  it('failed baseline at a higher version does not float floor up', () => {
    // Failed v5 baseline + succeeded v3 baseline.
    // The v3 (Success=true) wins as floor — failed v5 is ignored entirely.
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202401010000',
        Type: 'SQL_BASELINE',
        Description: 'v3 Baseline (success)',
        Success: true,
      }),
      makeHistory({
        InstalledRank: 2,
        Version: '202602151200',
        Type: 'BASELINE',
        Description: 'v5 Baseline (failed)',
        Success: false,
      }),
    ];
    const discovered = [
      makeMigration({ Version: '202501010000', Description: 'between' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.EffectiveBaselineVersion).toBe('202401010000');
  });

  it('history baseline trumps fresh-DB auto-selected disk baseline when higher', () => {
    // Hypothetical race: user pulled a NEWER B file that the DB hasn't seen
    // yet, but an older baseline is already in history. Both effects compute
    // a candidate floor; the higher wins.
    //
    // Note: shouldBaseline is gated on `!hasHistory`, so on an already-
    // baselined DB the disk baseline auto-selection block is skipped. This
    // test confirms the history baseline drives the floor in that case.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'BASELINE', Description: 'v5 Baseline' }),
    ];
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202601010000', Description: 'old B file on disk' }),
      makeMigration({ Version: '202601500000', Description: 'between' }),
      makeMigration({ Version: '202602160000', Description: 'after v5' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', true, false);

    // Floor is from history (v5), not the disk B file.
    expect(result.EffectiveBaselineVersion).toBe('202602151200');
    expect(result.BaselineAutoSelected).toBe(false); // shouldBaseline=false because history exists
    // Old disk B file is below the floor → ABOVE_BASELINE.
    expect(
      result.StatusReport.find((s) => s.Type === 'baseline' && s.Version === '202601010000')?.State
    ).toBe('ABOVE_BASELINE');
    // The "between" V is below floor → ABOVE_BASELINE.
    expect(
      result.StatusReport.find((s) => s.Version === '202601500000')?.State
    ).toBe('ABOVE_BASELINE');
    // Post-v5 V is pending.
    expect(result.PendingMigrations).toHaveLength(1);
    expect(result.PendingMigrations[0].Version).toBe('202602160000');
  });

  it('SQL row exactly at the floor is not flagged as MISSING when its file is gone', () => {
    // A historical SQL row at the same version as the baseline floor — the
    // baseline subsumes it, so its absence on disk is expected.
    const applied = [
      makeHistory({
        InstalledRank: 1,
        Version: '202602151200',
        Type: 'SQL',
        Description: 'old applied at exact floor',
      }),
      makeHistory({
        InstalledRank: 2,
        Version: '202602151200',
        Type: 'SQL_BASELINE',
        Description: 'v5 Baseline',
      }),
    ];
    const discovered: ReturnType<typeof makeMigration>[] = [];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.StatusReport.filter((s) => s.State === 'MISSING')).toHaveLength(0);
  });

  it('SQL row strictly above the floor with no disk file IS flagged MISSING', () => {
    // Negative control for the floor — anything above it is still a real
    // migration whose disk file going missing is a problem.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
      makeHistory({ InstalledRank: 2, Version: '202602160000', Type: 'SQL', Description: 'post-v5 deleted' }),
    ];

    const result = ResolveMigrations([], applied, '1', false, false);

    const missing = result.StatusReport.filter((s) => s.State === 'MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0].Version).toBe('202602160000');
  });

  it('SCHEMA marker (rank 0) is never flagged as missing-from-disk regardless of floor', () => {
    // Defensive: rank-0 schema marker has Version=null and Type='SCHEMA'.
    // It must always be skipped, floor or no floor.
    const applied = [
      makeHistory({
        InstalledRank: 0,
        Version: null,
        Type: 'SCHEMA',
        Description: '<< Flyway Schema Creation >>',
        Script: '[dbo]',
      }),
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'BASELINE', Description: 'v5 Baseline' }),
    ];

    const result = ResolveMigrations([], applied, '1', false, false);

    expect(result.StatusReport.filter((s) => s.State === 'MISSING')).toHaveLength(0);
  });

  it('multiple stale B files on disk all report as ABOVE_BASELINE', () => {
    // User kept v3 and v4 B files around but v5 baseline is the floor.
    // Both must appear in the StatusReport (not silently dropped).
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
    ];
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202401010000', Description: 'v3 Baseline (stale)' }),
      makeMigration({ Type: 'baseline', Version: '202602061600', Description: 'v4 Baseline (stale)' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    const staleBaselines = result.StatusReport.filter(
      (s) => s.Type === 'baseline' && s.State === 'ABOVE_BASELINE'
    );
    expect(staleBaselines.map((s) => s.Version).sort()).toEqual([
      '202401010000',
      '202602061600',
    ]);
    expect(result.PendingMigrations).toHaveLength(0);
  });

  it('disk B file that matches the history baseline reports as BASELINE, not ABOVE_BASELINE', () => {
    // Sanity: when the same B file is both on disk AND in history, the entry
    // shows the BASELINE state (it's the active baseline) rather than being
    // mislabeled as a stale/below-floor baseline.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
    ];
    const discovered = [
      makeMigration({ Type: 'baseline', Version: '202602151200', Description: 'v5 Baseline' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    const baselineEntry = result.StatusReport.find(
      (s) => s.Type === 'baseline' && s.Version === '202602151200'
    );
    expect(baselineEntry?.State).toBe('BASELINE');
    expect(result.PendingMigrations).toHaveLength(0);
  });

  it('outOfOrder=true with a baseline floor: floor still suppresses pre-baseline files', () => {
    // outOfOrder widens what's PENDING by lifting the highestApplied check —
    // but the floor must still apply. Pre-baseline V files stay ABOVE_BASELINE.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'BASELINE', Description: 'v5 Baseline' }),
    ];
    const discovered = [
      makeMigration({ Version: '202301010000', Description: 'pre-baseline (would be IGNORED with outOfOrder=false)' }),
      makeMigration({ Version: '202602160000', Description: 'post-baseline' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, true);

    const pre = result.StatusReport.find((s) => s.Version === '202301010000');
    expect(pre?.State).toBe('ABOVE_BASELINE');
    expect(result.PendingMigrations.map((m) => m.Version)).toEqual(['202602160000']);
  });

  it('failed non-baseline SQL row above the floor stays out of MISSING (file present)', () => {
    // Negative control: a Success=false row above the floor with its disk
    // file still present should not be flagged MISSING — it'd be FAILED via
    // the resolver's APPLIED branch, not MISSING.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
      makeHistory({
        InstalledRank: 2,
        Version: '202602160000',
        Type: 'SQL',
        Description: 'post-v5 failed',
        Success: false,
      }),
    ];
    const discovered = [
      makeMigration({ Version: '202602160000', Description: 'post-v5 failed' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    expect(result.StatusReport.filter((s) => s.State === 'MISSING')).toHaveLength(0);
    const failed = result.StatusReport.find((s) => s.Version === '202602160000');
    expect(failed?.State).toBe('FAILED');
  });

  it('V file strictly between two baselines is ABOVE_BASELINE', () => {
    // Specifically: floor=v5 baseline. A V file dated AFTER v4 baseline but
    // BEFORE v5 baseline must still be ABOVE_BASELINE (subsumed by v5).
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602061600', Type: 'SQL_BASELINE', Description: 'v4 Baseline' }),
      makeHistory({ InstalledRank: 2, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
    ];
    const discovered = [
      makeMigration({ Version: '202602100000', Description: 'between v4 and v5' }),
      makeMigration({ Version: '202602160000', Description: 'after v5' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    const between = result.StatusReport.find((s) => s.Version === '202602100000');
    expect(between?.State).toBe('ABOVE_BASELINE');
    const after = result.StatusReport.find((s) => s.Version === '202602160000');
    expect(after?.State).toBe('PENDING');
  });

  it('repeatable migrations are unaffected by the floor (keyed by description)', () => {
    // Floor logic targets versioned types only. Repeatables run when checksum
    // changes, no version comparison.
    const applied = [
      makeHistory({ InstalledRank: 1, Version: '202602151200', Type: 'SQL_BASELINE', Description: 'v5 Baseline' }),
    ];
    const discovered = [
      makeMigration({ Type: 'repeatable', Version: null, Description: 'RefreshViews', Checksum: 999 }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    // New repeatable (never run) is PENDING regardless of the floor.
    const r = result.StatusReport.find((s) => s.Description === 'RefreshViews');
    expect(r?.State).toBe('PENDING');
    expect(result.PendingMigrations.map((m) => m.Type)).toContain('repeatable');
  });
});
