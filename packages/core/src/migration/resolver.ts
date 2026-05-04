/**
 * @module migration/resolver
 * Determines which migrations need to be executed by comparing
 * discovered migrations on disk against the schema history table.
 *
 * Handles the full Flyway resolution logic:
 * - Versioned migrations run once and are tracked by version
 * - Baseline migrations run only on empty databases
 * - Repeatable migrations re-run when their checksum changes
 * - Previously applied migrations are skipped
 */

import { ResolvedMigration, MigrationState, MigrationStatus } from './types';
import { HistoryRecord } from '../history/types';

/**
 * Result of resolving migrations: what to execute and what to report.
 */
export interface ResolverResult {
  /** Migrations that should be executed, in correct order */
  PendingMigrations: ResolvedMigration[];

  /** Full status report of all migrations (for the `info` command) */
  StatusReport: MigrationStatus[];

  /** Whether a baseline migration was found and should be applied */
  ShouldBaseline: boolean;

  /** The effective baseline version used (auto-selected or explicit). Null if no baseline applies. */
  EffectiveBaselineVersion: string | null;

  /** True if the baseline version was auto-selected (not explicitly configured). */
  BaselineAutoSelected: boolean;

  /** Number of baseline files discovered on disk */
  BaselineFileCount: number;
}

/**
 * Resolves which migrations need to run by diffing disk state against database state.
 *
 * @param discovered - All migrations found on disk (fully resolved with checksums)
 * @param applied - All records from the flyway_schema_history table
 * @param baselineVersion - Configured baseline version string
 * @param baselineOnMigrate - Whether to auto-baseline empty databases
 * @param outOfOrder - Whether to allow out-of-order migrations
 * @returns Resolution result with pending migrations and status report
 */
export function ResolveMigrations(
  discovered: ResolvedMigration[],
  applied: HistoryRecord[],
  baselineVersion: string,
  baselineOnMigrate: boolean,
  outOfOrder: boolean
): ResolverResult {
  const pending: ResolvedMigration[] = [];
  const statusReport: MigrationStatus[] = [];

  // Build a map of applied versions for quick lookup
  const appliedByVersion = new Map<string, HistoryRecord>();
  const appliedRepeatables = new Map<string, HistoryRecord>();

  for (const record of applied) {
    if (record.Version !== null) {
      appliedByVersion.set(record.Version, record);
    } else if (record.Type === 'SQL' && record.Description !== '<< Flyway Schema Creation >>') {
      // Repeatable migration — keyed by description
      appliedRepeatables.set(record.Description, record);
    }
  }

  // Determine if this is a fresh database (no versioned migrations applied)
  const hasHistory = applied.some(
    (r) => r.Type === 'SQL' || r.Type === 'SQL_BASELINE' || r.Type === 'BASELINE'
  );
  const shouldBaseline = !hasHistory && baselineOnMigrate;

  // Separate migrations by type
  const versioned = discovered
    .filter((m) => m.Type === 'versioned')
    .sort((a, b) => a.Version!.localeCompare(b.Version!));

  const baselines = discovered
    .filter((m) => m.Type === 'baseline')
    .sort((a, b) => a.Version!.localeCompare(b.Version!));

  const repeatables = discovered.filter((m) => m.Type === 'repeatable');

  // Find the highest applied version
  const highestApplied = getHighestAppliedVersion(applied);

  // Highest baseline version already recorded in history. A baseline row in
  // history sets a permanent floor for resolution: any V-prefixed file at or
  // below it is subsumed by the baseline and should be reported as
  // ABOVE_BASELINE, not IGNORED/PENDING/MISSING. SQL_BASELINE = a B-prefixed
  // file that ran; BASELINE = a `Skyway.Baseline()` marker.
  //
  // Failed baseline rows (Success=false) are excluded — a failed baseline
  // didn't actually establish state. Treating it as the floor would silently
  // skip migrations the user still needs to run after Repair() / re-run.
  let highestHistoryBaseline: string | null = null;
  for (const record of applied) {
    if (
      (record.Type === 'BASELINE' || record.Type === 'SQL_BASELINE') &&
      record.Version !== null &&
      record.Success !== false &&
      (highestHistoryBaseline === null || record.Version > highestHistoryBaseline)
    ) {
      highestHistoryBaseline = record.Version;
    }
  }

  // --- Resolve baseline migrations ---
  let effectiveBaselineVersion: string | null = null;
  let baselineAutoSelected = false;

  if (shouldBaseline && baselines.length > 0) {
    let selectedBaseline: ResolvedMigration | undefined;

    if (baselineVersion === '1') {
      // Auto-select: pick the highest-versioned baseline
      // baselines are already sorted ascending by version, so take the last one
      selectedBaseline = baselines[baselines.length - 1];
      baselineAutoSelected = true;
    } else {
      // Explicit version: find exact match
      selectedBaseline = baselines.find((b) => b.Version === baselineVersion);
    }

    if (selectedBaseline) {
      effectiveBaselineVersion = selectedBaseline.Version;
      pending.push(selectedBaseline);
      statusReport.push({
        Type: 'baseline',
        Version: selectedBaseline.Version,
        Description: selectedBaseline.Description,
        State: 'PENDING',
        Script: selectedBaseline.ScriptPath,
        DiskChecksum: selectedBaseline.Checksum,
        AppliedChecksum: null,
        InstalledOn: null,
        ExecutionTime: null,
      });
    }
  }

  // A baseline already in history sets the floor too — and on subsequent runs
  // it's the only source. When both exist, the higher version wins so we
  // never go backwards.
  if (
    highestHistoryBaseline !== null &&
    (effectiveBaselineVersion === null || highestHistoryBaseline > effectiveBaselineVersion)
  ) {
    effectiveBaselineVersion = highestHistoryBaseline;
  }

  // Report status for baseline files on disk that weren't selected for execution
  // (already-applied, or below the active floor). Without this, stale B files
  // would silently disappear from `Info()` once the DB is no longer fresh.
  for (const baseline of baselines) {
    const alreadyPending = pending.some((m) => m === baseline);
    if (alreadyPending) continue;
    const appliedRecord = appliedByVersion.get(baseline.Version!);
    if (appliedRecord) {
      statusReport.push({
        Type: 'baseline',
        Version: baseline.Version,
        Description: baseline.Description,
        State: appliedRecord.Success === false ? 'FAILED' : 'BASELINE',
        Script: baseline.ScriptPath,
        DiskChecksum: baseline.Checksum,
        AppliedChecksum: appliedRecord.Checksum,
        InstalledOn: appliedRecord.InstalledOn,
        ExecutionTime: appliedRecord.ExecutionTime,
      });
    } else if (effectiveBaselineVersion !== null && baseline.Version! <= effectiveBaselineVersion) {
      statusReport.push({
        Type: 'baseline',
        Version: baseline.Version,
        Description: baseline.Description,
        State: 'ABOVE_BASELINE',
        Script: baseline.ScriptPath,
        DiskChecksum: baseline.Checksum,
        AppliedChecksum: null,
        InstalledOn: null,
        ExecutionTime: null,
      });
    }
  }

  // --- Resolve versioned migrations ---
  for (const migration of versioned) {
    const appliedRecord = appliedByVersion.get(migration.Version!);

    if (appliedRecord) {
      // Already applied — report status
      const state: MigrationState =
        appliedRecord.Success === false ? 'FAILED' : 'APPLIED';

      statusReport.push({
        Type: 'versioned',
        Version: migration.Version,
        Description: migration.Description,
        State: state,
        Script: migration.ScriptPath,
        DiskChecksum: migration.Checksum,
        AppliedChecksum: appliedRecord.Checksum,
        InstalledOn: appliedRecord.InstalledOn,
        ExecutionTime: appliedRecord.ExecutionTime,
      });
    } else if (effectiveBaselineVersion !== null && migration.Version! <= effectiveBaselineVersion) {
      // At or below the baseline floor — the baseline subsumes this migration.
      // Floor source is either the fresh-DB selection above or a baseline row
      // already recorded in history.
      statusReport.push({
        Type: 'versioned',
        Version: migration.Version,
        Description: migration.Description,
        State: 'ABOVE_BASELINE',
        Script: migration.ScriptPath,
        DiskChecksum: migration.Checksum,
        AppliedChecksum: null,
        InstalledOn: null,
        ExecutionTime: null,
      });
    } else if (
      !outOfOrder &&
      highestApplied !== null &&
      migration.Version! < highestApplied
    ) {
      // Out of order and not allowed — mark as ignored
      statusReport.push({
        Type: 'versioned',
        Version: migration.Version,
        Description: migration.Description,
        State: 'IGNORED',
        Script: migration.ScriptPath,
        DiskChecksum: migration.Checksum,
        AppliedChecksum: null,
        InstalledOn: null,
        ExecutionTime: null,
      });
    } else {
      // Pending — needs to be applied
      pending.push(migration);
      statusReport.push({
        Type: 'versioned',
        Version: migration.Version,
        Description: migration.Description,
        State: 'PENDING',
        Script: migration.ScriptPath,
        DiskChecksum: migration.Checksum,
        AppliedChecksum: null,
        InstalledOn: null,
        ExecutionTime: null,
      });
    }
  }

  // --- Report applied migrations not found on disk ---
  for (const record of applied) {
    if (record.Version === null || record.Type === 'SCHEMA') continue;

    // Baseline rows are typically one-shot bootstraps — the file gets pruned
    // after the first successful run. Don't flag them as MISSING.
    if (record.Type === 'BASELINE' || record.Type === 'SQL_BASELINE') continue;

    // Records subsumed by the baseline floor are expected to be absent on disk.
    if (effectiveBaselineVersion !== null && record.Version <= effectiveBaselineVersion) continue;

    if (
      !discovered.some(
        (m) => m.Version === record.Version && m.Type !== 'repeatable'
      )
    ) {
      statusReport.push({
        Type: 'versioned',
        Version: record.Version,
        Description: record.Description,
        State: 'MISSING',
        Script: record.Script,
        DiskChecksum: null,
        AppliedChecksum: record.Checksum,
        InstalledOn: record.InstalledOn,
        ExecutionTime: record.ExecutionTime,
      });
    }
  }

  // --- Resolve repeatable migrations ---
  for (const migration of repeatables) {
    const appliedRecord = appliedRepeatables.get(migration.Description);

    if (!appliedRecord) {
      // Never run before — pending
      pending.push(migration);
      statusReport.push({
        Type: 'repeatable',
        Version: null,
        Description: migration.Description,
        State: 'PENDING',
        Script: migration.ScriptPath,
        DiskChecksum: migration.Checksum,
        AppliedChecksum: null,
        InstalledOn: null,
        ExecutionTime: null,
      });
    } else if (appliedRecord.Checksum !== migration.Checksum) {
      // Checksum changed — re-run
      pending.push(migration);
      statusReport.push({
        Type: 'repeatable',
        Version: null,
        Description: migration.Description,
        State: 'OUTDATED',
        Script: migration.ScriptPath,
        DiskChecksum: migration.Checksum,
        AppliedChecksum: appliedRecord.Checksum,
        InstalledOn: appliedRecord.InstalledOn,
        ExecutionTime: appliedRecord.ExecutionTime,
      });
    } else {
      // Checksum unchanged — skip
      statusReport.push({
        Type: 'repeatable',
        Version: null,
        Description: migration.Description,
        State: 'APPLIED',
        Script: migration.ScriptPath,
        DiskChecksum: migration.Checksum,
        AppliedChecksum: appliedRecord.Checksum,
        InstalledOn: appliedRecord.InstalledOn,
        ExecutionTime: appliedRecord.ExecutionTime,
      });
    }
  }

  return {
    PendingMigrations: pending,
    StatusReport: statusReport,
    ShouldBaseline: shouldBaseline,
    EffectiveBaselineVersion: effectiveBaselineVersion,
    BaselineAutoSelected: baselineAutoSelected,
    BaselineFileCount: baselines.length,
  };
}

/**
 * Finds the highest version string among applied migrations.
 * Returns null if no versioned migrations have been applied.
 */
function getHighestAppliedVersion(applied: HistoryRecord[]): string | null {
  let highest: string | null = null;

  for (const record of applied) {
    if (
      record.Version !== null &&
      record.Type !== 'SCHEMA' &&
      (highest === null || record.Version > highest)
    ) {
      highest = record.Version;
    }
  }

  return highest;
}
