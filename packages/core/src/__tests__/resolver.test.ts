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
  it('includes out-of-order migration in status but not pending when outOfOrder is false', () => {
    const discovered = [
      makeMigration({ Version: '202401010000', Description: 'Old migration' }),
    ];
    const applied = [
      makeHistory({ Version: '202601010000', Description: 'Applied later' }),
    ];

    const result = ResolveMigrations(discovered, applied, '1', false, false);

    // Out-of-order migrations still appear as PENDING in status but are NOT
    // added to the pending execution list
    expect(result.PendingMigrations).toHaveLength(0);
    const status = result.StatusReport.find((s) => s.Version === '202401010000');
    expect(status?.State).toBe('PENDING');
  });
});
