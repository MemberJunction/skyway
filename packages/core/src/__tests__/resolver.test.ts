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
});
