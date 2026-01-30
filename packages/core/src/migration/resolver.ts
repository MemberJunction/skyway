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

  // --- Resolve baseline migrations ---
  if (shouldBaseline && baselines.length > 0) {
    // Find the baseline matching the configured version
    const matchingBaseline = baselines.find((b) => b.Version === baselineVersion);
    if (matchingBaseline) {
      pending.push(matchingBaseline);
      statusReport.push({
        Type: 'baseline',
        Version: matchingBaseline.Version,
        Description: matchingBaseline.Description,
        State: 'PENDING',
        Script: matchingBaseline.ScriptPath,
        DiskChecksum: matchingBaseline.Checksum,
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
    } else if (shouldBaseline && migration.Version! <= baselineVersion) {
      // Below or at baseline — skip (baseline covers these)
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
      // Out of order and not allowed — skip but warn
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
    if (
      record.Version !== null &&
      record.Type !== 'SCHEMA' &&
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
